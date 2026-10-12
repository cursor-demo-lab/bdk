# Reaction approvals for the factory desk

## Current behaviour (as of 0.2.11)

Setup and checks are in [`slack-and-github-setup.md`](slack-and-github-setup.md).

- Approvals are ✅ / ❌ reactions, or the typed commands. There are no
  buttons or cards; `toolApprovals` is off in
  `factory-desk/agent/channels/slack.ts`.
- Two posts take a reaction: the filing prompt (✅ files the ticket with
  that triage, ❌ files nothing) and the plan post (✅ moves Planned →
  Approved and the worker starts; ❌ leaves a `Denied in Slack` comment and
  the ticket stays Planned).
- Only the person the typed command accepts counts: the requester on the
  filing prompt, the filer on the plan post. Everyone else, bots, and the
  desk's own reactions are ignored with no reply.
- New requests start with `@Factory`. Plain replies in a factory thread in
  `#mars-eng-intake` (`C0EXAMPLE1`) or a DM need no mention.
- The Slack app needs the `reactions:read` scope and the `reaction_added`
  bot event. Without them a reaction never reaches the desk while typed
  replies still work.
- Code: `factory-desk/agent/lib/reaction-approval.ts`. Behaviour:
  `factory-desk/AGENTS.md` and [`../factory-desk/README.md`](../factory-desk/README.md).

Everything below is the original 0.2.2-era design, kept for history. Its
👍 / 👎, allowlist, and platform-patch details are superseded by the
section above.

## Original design

Status: design, 2026-09-23. Package `@cursor/july@0.2.2`. Platform
citations are against everysphere `1f4259e35f98` (main when this was
written, "base" below) and the local draft branch
`simon/v2-slack-reaction-added` at `cc2305d2b9b3` ("draft" below). July
citations are against the published 0.2.2 `dist/`.

Update, 2026-09-27: `@cursor/july` 0.2.11 delivers `reaction_added` on
hosted v2 and its generated manifest requests `reactions:read` and the
`reaction_added` event, so the platform change below has shipped. The desk
now takes ✅ / ❌ on its filing prompt and plan post
(`factory-desk/agent/lib/reaction-approval.ts`; `factory-desk/AGENTS.md`
has the behaviour). It uses ✅ and ❌ rather than 👍 / 👎, the filer (not
an allowlist) as the approver, as the typed commands do, and the existing
claim-lease settle pattern rather than `putIfAbsent`. The deployed desk app
was minted from the 0.2.2-era wizard, so it needs the 0.2.11 manifest
before reactions arrive. The rest of this document is the original design.

## Summary recommendation

A thumbs up on the desk's plan post cannot approve a ticket on hosted v2
today, and no interim trick gets there without a platform change: the
managed Slack app is never subscribed to `reaction_added`, the
provisioning validator rejects both the event and the `reactions:read`
scope, a July agent that declares the event fails deploy, and a polling
fallback needs the same missing scope. Inbound Slack for our team is
also switched off by the `agent_sdk_slack_events_dispatch` gate, so even
the current `approve KEY` text reply does not reach the desk. So: approve
in Jira now (a person moves the ticket to Approved, which already wakes
the factory worker); ask the gate owner to open the dispatch gate so
`approve KEY` works; and propose the opt-in platform patch drafted on
`simon/v2-slack-reaction-added` (19 production files, +224/-39, plus 7
test files). Once it ships, the desk handles 👍 and 👎 in host code with
no model turn: it checks that the reacted-to message is the current plan
post stored in kv, that the reactor is on an approver allowlist, takes a
one-time claim, and makes the same Jira transition `approve_ticket` makes
today. Do not build the reminder-based poll: it needs the same scope
change, adds at least 60 seconds of latency, and its binding to a Jira
continuation is unverified.

## Where approvals stand today

- The approve moment is a Jira transition to Approved.
  `factory-desk/agent/tools/approve_ticket.ts:6-8` and `:21-27`; a repeat
  returns `already`, so the transition is idempotent.
- Hosted Slack has no Approve/Deny cards, so every human gate is a text
  reply (`factory-desk/agent/instructions.md:9-11`). The plan post asks
  for `approve KEY` (`factory-desk/agent/lib/threads.ts:75`).
- The desk posts the plan with `chat.postMessage` into the filing thread
  and stores the post ts under
  `announced/<KEY>:<Planned>:<changelogId>`
  (`factory-desk/agent/tools/announce_plan.ts:37-56`,
  `factory-desk/agent/lib/threads.ts:49-51`). There is no pointer from a
  ticket to its current plan post, and none from a post back to a ticket.
- Nobody is checked before approving. Anyone who can mention the desk in
  the thread can reply `approve KEY`; the desk has no approver list
  (no `approver` or allowlist anywhere under `factory-desk/agent/`).
- Inbound Slack is gated. The events route drops every verified delivery
  when `agent_sdk_slack_events_dispatch` is off for the app's owner team
  (base `backend/server/src/agentServe/agentSdkSlackAppEvents.ts:68`,
  `:382-395`). See [`deployment-issues.md`](deployment-issues.md) issue
  13: that gate is `default: false` and is the inferred reason
  `@factory-desk` has never started a session.

## 1. Platform change

### Why the desk cannot opt in today

Each layer below blocks it on its own:

| Layer | Base behaviour | Citation |
| --- | --- | --- |
| Wizard manifest | Bot scopes stop at `reactions:write`; bot events are mentions, DMs, and app home only | base `backend/server/src/agentServe/agentServeSlackManifest.ts:102-116`, `:118`, `:183-184`, `:208`; July 0.2.2 `dist/channels/slack/manifest.js:17-31` |
| Provisioning validator | Any bot scope outside `BOT_SCOPES` and any bot event outside the allowlist is rejected | base `agentServeSlackProvisioning.ts:793-795`, `:998-1003`, `:1032-1038` |
| Continuation membership | `slack.thread/v2` admits only `message` and `app_mention` | base `backend/packages/server-shared/src/agentServe/conversation/slack.ts:9` |
| Deploy handshake | A declared event type outside that membership throws `INVALID_MANIFEST`, so no edge is written | `backend/server/src/factory/agent-sdk/subscriptionEdges.ts:197-205`, `backend/packages/server-shared/src/agentServe/agentSdkConversationIdentity.ts:188-195` (unchanged in the draft) |
| Events route | `admissibleEventType` returns only `app_mention` or `message` | base `agentSdkSlackAppEvents.ts:142-197` |
| July pack | Declares only `app_mention` and `message`, and says `reaction_added` is deliberately not declared | July 0.2.2 `dist/channels/slack/slack-channel.js:126-137` |

The July handler already exists. `onReactionAdded` is on the channel
options (July 0.2.2 `dist/channels/slack/types.d.ts:608-614`), and the
hosted delivery path runs the same `dispatchInboundFromEventBody` that
routes a reaction to it (`dist/channels/slack/slack-channel.js:529`,
`dist/channels/slack/dispatch.js:663-674`). The handler gets a
`SlackBinding` with `host` (kv, MCP, Slack client), and may return null
for no model turn (`dist/channels/slack/types.d.ts:383-398`). So the gap
is entirely in the control plane and the pack's declaration.

### What the draft changes

Local branch `simon/v2-slack-reaction-added`, commit
`cc2305d2b9b3946decd93c46524af3140b9f7431`, on top of `1f4259e`. Not
pushed, no PR. 26 files, +545/-42: 19 production files +224/-39, 7 test
files +321/-3.

Everything is opt-in. Apps minted without the flag get exactly the base
manifest, because adding a scope to an installed Slack app forces a
reinstall.

| Area | Change | Draft citation |
| --- | --- | --- |
| Manifest | `SlackManifestSpec.reactions`; `REACTION_BOT_SCOPES = ["reactions:read"]`; `REACTION_BOT_EVENTS = ["reaction_added", "reaction_removed"]`; `buildSlackManifest` appends both only when `reactions === true` | `agentServeSlackManifest.ts:23-26`, `:131-133`, `:191-195`, `:220` |
| Validator | Allowlists gain the reaction scope and events | `agentServeSlackProvisioning.ts:797`, `:807` |
| Wizard and endpoints | `reactions` threads through the manifest spec schema, the wizard session, and the mint call | `agentServeSlackEndpoints.ts:261`, `:351`, `:2480`; `agentServeSlackWizard.ts:41`, `:71`, `:127`, `:153`, `:195`, `:285`, `:311` |
| Events route | `AGENT_SDK_SLACK_REACTION_EVENT_TYPES`; `admissibleReaction`; reactions skip the fast ack; metric tag clamp | `agentSdkSlackAppEvents.ts:103-112`, `:187-189`, `:230-249`, `:491-493`, `:367-375` |
| Membership and lane key | `slack.thread/v2` events add both reaction types; the lane key falls back to `event.item.channel` and `event.item.ts` | `backend/packages/server-shared/src/agentServe/conversation/slack.ts:9`, `:27-43`; guest twin `packages/agent-serve/src/internal/continuation-identity.ts:740-749` |
| July parse and dispatch | `parseReactionRemovedEvent`; `onReactionRemoved`; `reaction.removed: true` | `packages/agent-serve/src/channels/slack/inbound.ts:265-311`; `dispatch.ts:990-1010`; `types.ts:285`, `:656-661` |
| July declaration | `reaction_added` / `reaction_removed` go into `slackEventTypes` only when the matching handler is set | `slack-channel.ts:195-207` |
| July manifest and CLI | `SlackManifestOptions.reactions`; `slack create --reactions` | `manifest.ts:83-85`, `:143-152`; `types.ts:786-789`; `bin/agent-serve.ts:595`, `:670`; `internal/cli-slack.ts:56-57`, `:99`, `:121-122`, `:529` |
| Portal | The setup wizard forwards `reactions` | `portal-website/.../SlackSetupWizard.tsx`, `hooks/useAgentServeSlack.ts` |

No fanout code changes. The workspace binding is unrestricted, so the
deploy writes a subscription edge for any declared event type that
passes the membership handshake above. Reactions route on workspace
scope and sit behind the same dispatch gate as mentions (draft
`agentSdkSlackAppEvents.ts:437-451`).

### Tests

Run with vitest 4 against the draft worktree, through a scratch
dependency directory and a resolver for the `<PRIVATE_PACKAGE_SCOPE>/*` workspace
packages (the checkout has no installed `node_modules`).

| File | Tests | Result |
| --- | --- | --- |
| `backend/server/src/agentServe/agentSdkSlackAppEvents.test.ts` | 59 | pass |
| `backend/server/src/agentServe/agentServeSlackManifest.test.ts` | 13 | pass |
| `backend/packages/server-shared/src/agentServe/agentSdkConversationIdentity.test.ts` | 53 | pass |
| `packages/agent-serve/src/internal/continuation-identity.test.ts` | 59 | pass |
| `packages/agent-serve/src/channels/slack/slack.test.ts` | 63 | pass |
| `packages/agent-serve/src/channels/slack/dispatch.test.ts` | 49 | pass |

296 tests, all passing. `agentServeSlackProvisioning.test.ts` was updated
(the rejection case now uses `pin_added`; new cases accept the reaction
scope and events, and the manifest-twin case covers `reactions: true` in
both socket and Events API modes) but could not run here: it imports
generated `<PRIVATE_PACKAGE_SCOPE>/proto-internal`, which needs buf codegen. A strict
`tsc` over the changed files reported no errors in them; unresolved
dependencies elsewhere in the tree may hide some type errors, and the
portal files were not typechecked. CI on a real branch is the check that
counts.

### Dedupe

- **Slack retries.** A retry reuses `event_id`. The events route claims
  `${api_app_id}:${event_id}` before fanout (base
  `agentSdkSlackAppEvents.ts:480`, draft `:539`), so a retry never
  reaches the desk twice. July's own `event_id` dedupe in the hosted path
  is per dispatch call (July 0.2.2 `dist/channels/slack/slack-channel.js:529`,
  `createEventIdDedupe()`), so it does not help across pods.
- **Add and remove are different events.** `reaction_added` and
  `reaction_removed` have distinct `event_id`s, so the control plane
  passes both. Slack does not promise order between them.
- **Flapping.** The desk treats approval as one-way. The first admissible
  👍 or 👎 takes the kv claim `<KEY>:approve` (scoped by the plan's
  changelog id, so a replan can be decided again) with `putIfAbsent`
  (`factory-desk/agent/lib/claims.ts:19-22`; draft only: `host.kv` has no
  `putIfAbsent`, and the shipped desk uses the settle lease described
  under "Current behaviour", [`bugs.md`](bugs.md) ask 11). Later adds are no-ops. A
  removal never reverts: once Jira says Approved, the undo is a person
  moving the ticket back in Jira or replying `replan KEY`. The desk posts
  one line saying so. Because nothing depends on order, a remove that
  arrives before its add is harmless.
- **Jira as the backstop.** The transition itself is idempotent
  (`approve_ticket.ts:6-8`), so even a lost claim cannot approve twice.
- **Two approvers disagree.** First decision wins the claim; the desk
  replies in the thread naming who decided.

### Reactor authorization

- **Humans only.** The route drops any event with `bot_id` and any event
  whose sender is the app's own bot user (draft
  `agentSdkSlackAppEvents.ts:176-185`, the same checks as base
  `:153-163`). Other bots that react as a user are stopped by the
  allowlist below.
- **Only reactions on the desk's messages.** `admissibleReaction`
  requires `item_user` to equal the bot user id, a non-empty emoji, and
  a message item with channel and ts; without a known bot user id every
  reaction drops (draft `:230-249`). Without this, every emoji in a busy
  channel the bot sits in would wake the desk.
- **An approver allowlist.** New env on the desk,
  `FACTORY_DESK_APPROVERS`, a comma list of `SlackUserId=JiraAccountId`
  pairs. The handler rejects any reactor not on it and replies once in
  the thread. A static map is the honest choice: resolving a Slack user
  to a Jira account by email needs `users:read.email`, which the managed
  app does not have (base `agentServeSlackManifest.ts:102-116`). The
  same check should gate the `approve KEY` text path, which has none
  today.
- **Recorded in Jira.** After the transition the handler comments on the
  ticket: who approved (the mapped Jira account and the Slack user id),
  the emoji, and a permalink to the plan post. That is the approver of
  record, not the Slack reaction.

### The bot's own reactions

The fast ack is a 👀 the control plane adds in the app's identity. Its
sender is the bot user, so it is dropped by the sender check above, and
it goes on the mention, not the plan post. The draft also never fast-acks
a reaction (draft `agentSdkSlackAppEvents.ts:488-493`), because a 👀 on
the plan post would read as a second vote. The desk itself only needs
`reactions:write` for the same kind of acknowledgement, and it must never
add 👍 or 👎 to its own posts.

### The authoritative message

Only the current plan post counts. `announce_plan` gains two kv writes
after `chat.postMessage` succeeds:

- `plan/<KEY>` holds `{ channel, ts, changelogId }` and is overwritten
  by a replan.
- `planpost/<channel>:<ts>` holds `{ issueKey, changelogId }`, the
  reverse index a reaction needs, because the event only carries the
  reacted-to channel and ts.

The handler looks up `planpost/<item.channel>:<item.ts>`, then requires
`plan/<KEY>.ts` to equal `item.ts`. A reaction on a stale plan, a
progress post, or any other desk message returns null with no side
effect. One routing detail: a reaction's lane key is
`cont:<channel>:<item.ts>` (draft `conversation/slack.ts:27-43`). The
plan post is a reply inside the filing thread, so its lane is not the
filing thread's lane. That does not matter here, because the handler does
host work and returns null, so no model session is continued. Unverified:
whether the control plane creates a session row for a null-returning
delivery.

### Desk-side work after the patch ships

About four files: `announce_plan.ts` (two kv writes), a new
`agent/lib/reactions.ts` (lookup, allowlist, emoji names `+1` and `-1`
with any `::skin-tone-N` suffix stripped, claim), `channels/slack.ts`
(`onReactionAdded`, `onReactionRemoved`), and the plan text in
`lib/threads.ts:75` ("React 👍 to build, 👎 to leave it, or reply..."). The
Slack app has to be re-minted with `slack create --reactions` (a scope
change forces a reinstall). Plus one eval that a 👍 from a non-approver
does not call `transitionIssue`.

## 2. Interim approach without a platform change

The idea: when something else wakes the desk, it calls `reactions.get`
on the stored plan post and approves if an allowlisted 👍 is there.

### What could wake it

- **Schedules: no.** On hosted v2 a schedule PUT stores a factorydb row
  (base `backend/server/src/agentServe/agentServeEndpoints.ts:3838-3872`),
  but the timed-work sweep only converges v2 reminders: "schedules on v2
  remain out of scope for this sweep" (base
  `backend/server/src/agentServe/temporal/agentServeTimedWorkSyncActivity.ts:13-16`,
  scan at `:323` and `:366-376`). July syncs schedules only at pod boot
  (July 0.2.2 `dist/internal/server.js:676-682`). The schedules reference
  in the July docs describes self-hosted serve.
- **Reminders: yes, with limits.** v2 reminders have their own control
  plane (base `temporal/agentSdk/agentsdkReminderEndpoints.ts:1-18`) with
  1000 active per deployment (`reminderControlPlane.ts:45`) and a
  60-second minimum recurring interval
  (`reminderControlPlaneProtocol.ts:16`). July uses it on v2 (July 0.2.2
  `dist/internal/server.js:563-579`) and a reminder can name a handler
  with JSON args (`dist/internal/hosted-delivery-protocol.js:480-500`).
  `announce_plan` could start a 60-second reminder per plan that polls
  and cancels itself on a decision. Unverified: how a reminder binds to
  the Jira custom channel's continuation, since `announce_plan` runs from
  a Jira delivery, not a Slack one.
- **Jira webhooks: not useful.** The desk wakes on status transitions.
  Between "plan posted" and "approved" there is usually no Jira event on
  that ticket, so a poll on Jira wakes would see the 👍 only when someone
  touches the ticket for another reason.

### Why it still needs a platform change

`reactions.get` requires `reactions:read`. `conversations.replies`
(covered by `channels:history` and `groups:history`, which the app has)
reportedly omits the `reactions` array without `reactions:read` too; that
comes from a Slack MCP plugin issue and needs a live check before anyone
relies on it. The wizard manifest has no `reactions:read` (base
`agentServeSlackManifest.ts:102-116`; July 0.2.2
`dist/channels/slack/manifest.js:17-31`), and the validator rejects it on
mint and on manifest update (base `agentServeSlackProvisioning.ts:793`,
`:998-1003`). Adding the scope by hand in Slack's app settings would
drift from the custody row and be overwritten by the next `slack create`;
whether our admins are even collaborators on the minted app is
unverified. So the poll needs the scope half of the same patch.

### Cost if it were built

- Latency: 60 seconds minimum per poll, plus pod wake.
- Limits: one reminder per open plan against 1000 per deployment, one
  `reactions.get` per open plan per minute against Slack's rate limits.
- Complexity: a reminder lifecycle to create, cancel, and clean up on
  replan, for a result that is worse than the event path.

It is not gated by `agent_sdk_slack_events_dispatch` (it is outbound
Slack), which is its one advantage. That is also why a Jira-side approval
is the better interim: it needs no Slack inbound at all.

## 3. Recommendation

1. **Now.** Treat a person moving the ticket to Approved in Jira as the
   approval. It works today: Jira events already reach our slugs and the
   factory worker wakes on Approved. Add one line to the plan post
   saying so.
2. **Next.** Ask the gate owner to open `agent_sdk_slack_events_dispatch`
   for team <CURSOR_TEAM_ID> (deployment issue 13). That turns on `approve KEY`,
   and the desk should add the approver allowlist to that path at the
   same time.
3. **Then.** Propose the draft on `simon/v2-slack-reaction-added`
   (`cc2305d`) to the Agent SDK owners. It is opt-in, keeps reactions
   behind the same gate and the same `event_id` claim, admits only a
   human's reaction on the app's own message, and leaves unflagged apps
   byte-for-byte the same. The desk-side work is about four files plus
   one eval.
4. **Skip** the reminder poll. It needs the same scope change and is
   slower and more complex than the event path it would stand in for.
