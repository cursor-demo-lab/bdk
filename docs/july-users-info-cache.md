# July `users.info` cache: unbounded, never refreshed, keyed by object identity

Upstream issue for `@cursor/july`. Still open in 0.2.25: `dist/channels/slack/user-info.js`, `external-policy.js`, `sender-name.js`, and `self-identity.js` are byte-identical in 0.2.23, 0.2.24 and 0.2.25 (and were in 0.2.22). Our mitigation is in `factory-desk/agent/lib/july-user-cache.ts` and `factory-desk/agent/lib/originator.ts` (`hostSlackTransport`).

## Location

All module-level `Map`s in `dist/channels/slack/`, none with a TTL or size cap:

| File | Map | Key | Value |
| --- | --- | --- | --- |
| `user-info.js` | `users` | bot token slot (string, resolver function, or `SlackApiTransport` object), then user id | the full `users.info` user record, or the in-flight promise |
| `external-policy.js` | `classified` | `` `${slackTeamId}:${userId}` `` (no token) | externality verdict |
| `sender-name.js` | `botNames` | token slot, then bot id | `bots.info` name |
| `self-identity.js` | `identities` | token slot | `auth.test` identity |

Only whole-cache resets are exported: `resetSlackUserInfoCache`, `resetExternalSenderCache` (also clears `users`), `resetSlackSenderNameCache`, `resetSlackSelfIdentityCache`.

## Problems

1. **Grows with every sender, forever.** Each sender adds a full user record (profile, email, phone, title) under the token and a verdict under `team:user`. Nothing is evicted before the process exits.
2. **Verdicts never refresh.** `isExternalSlackSender` answers from `classified` first. A member who is later made a guest (`is_restricted`), made a stranger, or moved out of the workspace stays "internal" until the process restarts. That bypasses the Slack Connect / guest block (`blockExternals`) for that user. Display names and `tz` in `<slack_context>` go stale the same way.
3. **The outer key is object identity, and it is written before the lookup.** `fetchSlackUserInfo` runs `users.set(botToken, perToken)` before it fetches. A failed lookup deletes the user entry but keeps the per-token map, so the token object is held for good. A caller that builds a `SlackApiTransport` per call (the documented way to route through `ctx.host.slack`) leaks one map, plus whatever the transport closes over, per call. In factory-desk that was the whole per-message `SlackBinding` (fixed on our side). Keying by the object also means a resolver such as `credentialsFromEnv`'s `() => process.env[...]` keeps serving records fetched with an old token after the env token rotates.
4. **Verdicts are shared across tokens.** `classified` has no token in its key, so any token slot, including a transport that cannot reach Slack at all, reads a verdict another token looked up. In a multi-agent `serve`, one agent's lookup answers for another. factory-desk depends on this today (`JULY_CACHE_PROBE` in `fix-request.ts`), so a fix should add a supported read (see below) before it scopes the key.

## Repro

Plain Node against the published package, with fake transports (no Slack). Run it from a directory where `@cursor/july` 0.2.11 through 0.2.13 is installed (the cache code is the same in all three):

```js
import { isExternalSlackSender, fetchSlackUserInfo } from "@cursor/july/channels/slack";

let restricted = false;
let calls = 0;
const token = { kind: "api-transport", label: "t", call: async (_m, a) => (calls++, { ok: true, user: { id: a.user, team_id: "T1", is_restricted: restricted } }) };

for (let i = 0; i < 20000; i++) await isExternalSlackSender({ botToken: token, slackTeamId: "T1", userId: `U${i}` });
calls = 0;
for (let i = 0; i < 20000; i++) await fetchSlackUserInfo({ botToken: token, userId: `U${i}` });
console.log(calls); // 0: all 20k records are still held

restricted = true;
console.log(await isExternalSlackSender({ botToken: token, slackTeamId: "T1", userId: "U0" })); // false: still "internal"

const blind = { kind: "api-transport", label: "blind", call: async () => { throw new Error("no access"); } };
console.log(await isExternalSlackSender({ botToken: blind, slackTeamId: "T1", userId: "U1" })); // false: read from another token's lookup

for (let i = 0; i < 2000; i++) {
  const fresh = { kind: "api-transport", label: "fresh", call: async () => { throw new Error("down"); } };
  await isExternalSlackSender({ botToken: fresh, slackTeamId: "T1", userId: `Ux${i}` }); // each `fresh` is now a permanent key
}
```

Measured with `--expose-gc` on Node 22.18:

- 20,000 senders retain about 6.6 MiB of heap (small fake records; real `users.info` records are several times larger).
- 2,000 per-call transports: all 2,000 are still reachable after GC.

`factory-desk/agent/lib/july-user-cache.test.ts` pins the first, second, and fourth behaviours so that an upgrade that changes them shows up as a failing test.

## Impact

- **Memory.** Growth is linear in distinct senders, plus one entry per call for callers that build a transport per call. A busy Enterprise Grid workspace, or a Slack outage (every lookup fails, so every call leaks), makes it visible.
- **Policy.** A stale "internal" verdict lets a demoted or departed user keep driving an agent that relies on `blockExternals`. For factory-desk that includes the typed and reaction approvals.
- **Data scope.** Full user records (email, phone) stay in process memory with no end. Each record is scoped by token object; the derived verdict is not scoped at all.

## Suggested fix

1. Replace the maps with one small LRU that has a TTL: for example 15–30 minutes and a few thousand entries per token for `users.info`, and the same bounds for `classified` and `botNames`. Keep caching the in-flight promise (it is what gives one call per message).
2. Only insert the per-token map after a successful lookup, and do not let a failed lookup keep the token key. Better, key the per-token level by a stable id: the resolved token string's hash, the transport `label`, or `auth.test`'s `team_id`/`user_id`, not the object.
3. Store only the fields July reads (`team_id`, `enterprise_user.teams`, `is_stranger`, `is_restricted`, `is_ultra_restricted`, `is_bot`, names, `tz`), not the whole record.
4. Put the token scope in the `classified` key, and export a read-only `peekExternalSlackSender({ slackTeamId, userId })` (or pass the dispatch's `membership` verdict to handlers as `message.author.external`). Handlers could then read July's answer without the cache-probe transport factory-desk uses.
5. Export a per-user `forgetSlackUser({ userId })` so an app can drop one entry on `user_change` / `team_join` events instead of clearing everything.

## Our mitigation (factory-desk)

- `originator.ts`: `recordingSpeakers` used to build a transport per message for its own `isExternalSlackSender` call. Every message where July had no verdict yet (a sender's first message, or any message while `users.info` failed) left that transport, and the `SlackBinding` it closed over, in July's map. It now uses one transport per host Slack binding (`hostSlackTransport`, a `WeakMap` keyed by `ctx.host.slack`). Measured over 500 messages with a fresh binding each: 490/500 retained before, 1/500 after; while Slack failed, 500/500 before, 1/500 after.
- `july-user-cache.ts`: `julyUserCache` wraps both desk Slack handlers. It calls `resetExternalSenderCache()` and `resetSlackSenderNameCache()` once the caches are 30 minutes old or 1,000 distinct senders have been seen, but never while a desk Slack handler is running, because those handlers read July's verdict for their own message. An unref'd 60 s timer covers a quiet desk. Self identity is not cleared. It is one entry per token and the desk needs it.
- Known edge: a clear that lands after July's own lookup for a new message but before that message's handler starts makes the desk's probe miss. The sender then counts as external after the 5 s wait, which refuses the command rather than approving it. This can happen at most once per clear.
- Remove both once July bounds its caches and offers a supported verdict read. The characterization tests in `july-user-cache.test.ts` fail when July's behaviour changes.
