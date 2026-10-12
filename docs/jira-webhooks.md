# Jira system webhooks for the hosted factory

**Optional / legacy.** Live hosted ingress is project-scoped Automation
in TLSSN, authenticated by `X-Factory-Webhook-Secret` (or
`Authorization: Bearer`) against `JIRA_WEBHOOK_SECRET`. Setup:
[`jira-automation.md`](jira-automation.md).

Keep this page for site-admin HMAC hooks and for
`e2e-drive --replay` / `scripts/replay-jira-transition.mjs`, which still
sign the native `webhookEvent` + `issue` + `changelog` body.

**Either these webhooks or the TLSSN Automation rules, never both.** A
slug that gets both sees every transition twice under two changelog ids:
two planning sessions per entry into Triaged, and every desk status line
twice ([`jira-automation.md`](jira-automation.md), "One delivery
source"). Disable the Automation rules before enabling these, or leave
these disabled.

Four webhooks, one per consuming slug (Automation has five rules because the
desk's comment rule is separate; here the desk's one webhook takes both). Register them as a Jira site admin
at `https://<JIRA_SITE>.atlassian.net/plugins/servlet/webhooks`
(Settings cog → System → WebHooks → Create a WebHook). Status: **enabled**.
Leave "Exclude body" unchecked.

Each slug holds its own `JIRA_WEBHOOK_SECRET` deployment secret, and each
webhook's **Secret** field must match the slug it points at. Today all four
slugs hold the same value (kept in the operator's gitignored root
`.env.local`; never in git or chat), so the same Secret goes on all four.
Rotate one slug's value and only that webhook changes. Jira signs each
delivery with it as `X-Hub-Signature: sha256=<hmac>`.

Application ids below are the current deployments. A redeploy keeps them; deleting and
recreating a slug changes them, and `agent-sdk deployment <slug> --json`
(`engineAlias`) is the source of truth.

| Name in Jira | URL | Events | JQL filter |
| --- | --- | --- | --- |
| `factory-triage-jira` | `https://api.cursor.com/internal/agentsdk/agents/120f01ef-bfc5-4b4b-bd11-17346c093763/engine/v1/channels/webhook/` | Issue: **created** | `project = TLSSN` |
| `factory-planner` | `https://api.cursor.com/internal/agentsdk/agents/289bb13d-92b7-4397-9cb3-907638dc147b/engine/v1/channels/webhook/` | Issue: **updated** | `project = TLSSN` |
| `factory-worker` | `https://api.cursor.com/internal/agentsdk/agents/ef9d65dd-3a25-4a22-912a-aef3efae8f9e/engine/v1/channels/jira/` | Issue: **updated** | `project = TLSSN` |
| `factory-desk` | `https://api.cursor.com/internal/agentsdk/agents/c77993af-8f22-4389-8498-38bf64306d85/engine/v1/channels/jira/` | Issue: **updated**; Comment: **created** | `project = TLSSN` |

Tick only the events named. The desk needs comment events: it relays the
factory's outcome comments (`Triage stopped:`, `Needs info:`,
`Plan stopped:`, `Launch failed:`, …) into the ticket thread, the job the
`factory-desk-comments` Automation rule does
([`jira-automation.md`](jira-automation.md)). The planner does not need
them: it also accepts `comment_created` for the legacy `Plan requested:`
path, but the status transition is the product path.

## Check each one

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' <URL>
```

`202` means the control plane accepted the delivery (the handler drops
the unsigned body with a 401 inside the pod). Then, in Jira, open the
webhook and use its **Test** link, or create an issue in `TLSSN` and
watch for the `Triage:` comment and the move to `Triaged`.

HMAC replay proves the handler saw a signed body. It does not bypass
planner gates: a ticket whose governing `Triage:` comment has
`Needs info:` still returns `{ plan: false, reason: "needs_info" }`
and never writes `Plan:` (same as live Automation). See
[`jira-automation.md`](jira-automation.md).

A signed synthetic transition, from this directory with
`JIRA_WEBHOOK_SECRET` exported:

```bash
node scripts/replay-jira-transition.mjs <URL> TLSSN-3 Approved
```

## Why Automation is the default now

Automation's "Send web request" cannot compute an HMAC over the body.
Handlers now accept the shared header secret as well as HMAC, so TLSSN
project rules can deliver without a site-admin system webhook. The v3
`POST /rest/api/3/webhook` API is still limited to Connect and OAuth 2.0
apps, and a scoped API token still gets `401 scope does not match` on the
legacy `/rest/webhooks/1.0/webhook`.

The TLSSN rules can also target Cursor Automations instead of the hosts;
those authenticate with a Bearer key, not HMAC or the shared header. See
[`cursor-agent-automations.md`](cursor-agent-automations.md).
