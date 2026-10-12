# Jira project Automation for the hosted factory

Project-scoped Automation in **TLSSN** is the live ingress. Each rule
sends a web request that carries the same `JIRA_WEBHOOK_SECRET` already
on the slug, as a static header. Site-wide system WebHooks (HMAC
`X-Hub-Signature`) stay optional for replay and any leftover admin UI
hooks; see [`jira-webhooks.md`](jira-webhooks.md).

**Automation or system WebHooks, never both.** Each slug takes one live
source. With both, every transition reaches it twice with two different
changelog ids (the Status template's fallback below, and Jira's own
numeric id), so each counts as its own transition: the planner starts
two planning sessions per entry into Triaged (and two `Needs info:`
comments when the sandbox disagrees), and the desk posts every status
line twice. No agent can drop the second one safely; see "One delivery
source" under the operator checklist. Signed replays
(`scripts/replay-jira-transition.mjs`, `e2e-drive --replay`) are fine:
they send one delivery per hop on purpose.

Do not enable a rule that posts with no secret. Handlers refuse unsigned
bodies.

Application ids below are the current deployments. A redeploy keeps them;
deleting and recreating a slug changes them. `agent-sdk deployment <slug>
--json` (`engineAlias`) is the source of truth.

## Auth

Primary header (set this on every rule):

```text
X-Factory-Webhook-Secret: <the slug's JIRA_WEBHOOK_SECRET>
```

Also accepted:

```text
Authorization: Bearer <the slug's JIRA_WEBHOOK_SECRET>
```

The value is the deployment secret already stored on the slug. Today all
four slugs hold the same value (operator gitignored root `.env.local`;
never in git or chat). Rotate one slug and only that rule's header
changes.

After any secret rotate or rule recreate, re-paste
`X-Factory-Webhook-Secret` from the **same** `JIRA_WEBHOOK_SECRET` that
is on the hosted slug. A stale header from an older rule or a rotated
secret is a pod `401`. A local paste helper named
`.jira-webhook-secret.paste` is gitignored in this folder; never commit
it.

HMAC `X-Hub-Signature` / `X-Hub-Signature-256` over the raw body still
verifies, so `e2e-drive --replay` and `scripts/replay-jira-transition.mjs`
keep working.

A request is accepted when **either** method succeeds. Missing or wrong
auth is `401` **inside the pod**. The hosted edge always answers HTTP
`202` first. There is no unsigned fallback.

Jira Automation audit **Success** / **Successfully published web
request** only means Atlassian got an HTTP 202 from the control plane.
It does **not** prove the factory handler accepted the body. A
bad or missing secret still audits as Success while the pod returns
401 and triage never runs. Confirm with a `Triage:` comment (or an
HMAC replay that you signed), not the audit row.

## Scope

Create the rules in the **TLSSN** project only (Project settings →
Automation). Do not create them as global / multi-project rules.

## Five rules

Every rule's action is **Send web request**: method POST, headers
`Content-Type: application/json` and a hidden `X-Factory-Webhook-Secret`
(the value is the slug's secret; never paste it into docs or chat), web
request body **Custom data**, "Wait for response" **unticked**. Tick only
the trigger named. Newer sites label the triggers "Work item created",
"Work item transitioned", and "Comment added" (older ones: "Issue …").

| Name in Automation | URL | When | Body |
| --- | --- | --- | --- |
| `factory-triage-jira` | `https://api.cursor.com/internal/agentsdk/agents/120f01ef-bfc5-4b4b-bd11-17346c093763/engine/v1/channels/webhook/` | Work item created | Created template |
| `factory-planner` | `https://api.cursor.com/internal/agentsdk/agents/289bb13d-92b7-4397-9cb3-907638dc147b/engine/v1/channels/webhook/` | Work item transitioned **to Triaged** | Status template |
| `factory-desk` | `https://api.cursor.com/internal/agentsdk/agents/c77993af-8f22-4389-8498-38bf64306d85/engine/v1/channels/jira/` | Work item transitioned to In Progress, **Planned**, Approved, In Review, Done or **Triaged** | Status template |
| `factory-desk-comments` | same URL as `factory-desk` | Comment added (all comments) | Comment template |
| `factory-worker` | `https://api.cursor.com/internal/agentsdk/agents/ef9d65dd-3a25-4a22-912a-aef3efae8f9e/engine/v1/channels/jira/` | Work item transitioned **to Approved** | Status template |

The desk handler announces **Triaged**, **Planned**, **Approved**,
**In Progress**, **In Review**, and **Done**, so the `factory-desk`
rule's trigger lists all six (same URL and status template). Only
Planned is required for triage → plan → launch; the rest are what the
thread hears. Without Triaged, the thread is silent between filing and
the plan, a ticket triage ruled a question, needs-info, or duplicate
(which the planner skips) is never explained, and a ticket filed in Jira
gets no intake root, reactions, or `Slack thread:` backlink until an
outcome comment opens one (#131). Triaged and Approved also arm the
desk's plan and launch hop watches (#132). Without In Review and
Done, a finished ticket stays silent after `KEY is In Progress`.

### The thread always hears why a ticket did not move on

The planner does not always plan. When the sandbox does not show the
failure the ticket claims, it writes `Needs info: <KEY>` with what it
checked; when a planning run ends with neither a plan nor that verdict
(the run failed, the plan was refused, or the plan landed but the move
to Planned did not), it writes `Plan stopped: <KEY>` with one `Why:`
line. Both leave the ticket in **Triaged**, so no status rule fires and,
without a second desk rule, the thread goes silent after its Triaged
line (TLSSN-22, 2026-09-25: the planner found no CSV export on
`marsbank@main`, wrote `Needs info:`, and the thread heard nothing).
The same `Plan stopped:` comment covers every move into Triaged the
planner does not start a run for because the governing triage verdict is
a question, a duplicate, or an unanswered needs-info: without it, a desk
`plan KEY` bounce the planner skipped left the thread on "planner is
checking the code…" (TLSSN-40, 2026-09-27). The planner cannot tell
triage's own move from a bounce, so it always writes it; the desk posts it
unless the thread already heard that gate (no planner crumb up, and no
`plan` / `retry` / Needs-info send by the desk in the last 30 minutes,
which it records before the move), so a bounce is always answered and
triage's own move is not announced twice. It is claimed once per
changelog id and moves nothing; the planner's hosted route takes no
comment events, and its legacy comment path reads only `Triage:` and
`Plan requested:`, so the comment cannot wake it.

The same holds on either side of the planner. A triage run that fails,
ends without a verdict, cannot write it, or cannot move the ticket
leaves it in **To Do**; its `triage-outcome` hook then writes
`Triage stopped: <KEY>` with one `Why:` line, after the filing reply
promised a Triaged line. After the Approved line promised an agent
link, `factory-worker` leaves `Launch failed: <code>. Moving the card to
Approved again retries.` when the launch throws, or `Approved without a
plan on the ticket; nothing was launched. …` when there is no brief, and
the ticket stays **Approved**. When its implement PR opens or merges but
the ticket is not where the move starts from, it leaves `In Review not
set from <repo>#<n>: …` (or `Done not set from …`). None of these is a
status change.

`factory-desk-comments` is that rule: trigger **Issue commented** (the
trigger may read "Work item commented" on newer sites), the desk's URL
and secret, the Comment template. The desk reads only a comment whose
first line is one of those outcomes for its own ticket
(`factory-desk/agent/lib/outcomes.ts`); every other comment, triage's
own `Needs info:` line included, is answered `ignored` before any Jira
read, so no condition is needed. Do not add a `contains` condition on
the key: the worker's `Launch failed:` and `not set from` lines do not
name it, and a missed comment is a silent thread. Tick **Allow rule
trigger** as on the status rule. Every agent comments through the
Atlassian connector as the consenting user, so the rule fires for each.

A replan that still finds nothing writes a new `Needs info:` comment and
posts again; the desk claims each comment once, so a redelivery does
not. A comment that landed before this rule existed can be posted with
`node scripts/replay-jira-comment.mjs <desk URL> <KEY> --comment-id <id>`
(signed with `JIRA_WEBHOOK_SECRET`; the id is `focusedCommentId=` in the
comment's link). Add `--kind triage-stopped`, `launch-failed`, or
`approved-without-plan` for those comments, or `--first-line "<the
comment's first line>" --status "<its status>"` for a `not set from`
note.

### In Review and Done from the pull request

`factory-worker` makes both moves in its own code; no Jira Automation rule
moves the card. It watches `cursor-demo-lab/marsbank` through a read-only
GitHub channel (deploy with `--cursor-events-repo cursor-demo-lab/marsbank`)
and acts only on the implement PR: head branch starting with the key (or a
`cursor[bot]` PR whose title does), base `FACTORY_SANDBOX_REF`, and a ticket
the worker launched an agent for.

| GitHub event | Worker moves the ticket |
| --- | --- |
| PR opened, reopened, ready for review, or pushed to | In Progress → In Review. Any other status: no move |
| PR merged by a person (GitHub user type `User`, no `[bot]`, auto-merge not set) | In Review → Done. In Progress, or drifted back to Approved, Planned, Triaged, or To Do: → In Review → Done. Any other status: no move, one `Done not set from` note |
| Merged by a bot or app, auto-merged, or closed without a merge | No move |

No factory agent merges and none turns on auto-merge; a person pressing
Merge is the trigger. Each move is claimed once per ticket, stage, and PR,
so a redelivery or a later push does not move the card twice. The desk
hears each move through the `factory-desk` rule above, like any other
status change, and posts the In Review and Done lines into the ticket's
thread. That is why In Review and Done must be on that rule's trigger.

Tick **Allow rule trigger** ("Check to allow other rule actions to trigger
this rule") under Rule details on the `factory-desk` rule too. The
worker's moves go through the Atlassian connector as the consenting user,
not as a rule action, so they should fire the desk's rule without it; a
worker-made move reaching the desk is not yet observed on hosted
(`verification.md`, "In Progress announce"). Any rule that moves a card (a
leftover rule, or one added later) reaches the desk only with it ticked,
so keep it ticked.

Do not keep Jira Automation "Pull request created" / "Pull request merged"
rules (the GitHub for Jira ones, earlier named `factory-pr-opened` and
`factory-pr-merged`) that transition these tickets. A "merged" rule fires
on any merge, including one a bot makes, which the worker refuses on
purpose. Disable them if you created them. The GitHub for Jira app can
still link the PR to the ticket; only the transitions move to the worker.
Dragging the card by hand still posts the same Slack lines.

Use **Issue transitioned** (destination status set) or **Field value
changed** on Status. Either way the body must include `changelog.items`
with `field` = `status` and `fromString` / `toString`.

## Body templates

**Every free-text smart value uses `.jsonEncode`** (summary, description,
reporter name, comment body). Automation pastes smart values into the body
as raw text. A ticket title with a double quote in it produced invalid
JSON; the host could not parse it and dropped the delivery without a
trace, while Jira's audit log still said "Successfully published web
request". That is what broke planning for TLSSN-40 and TLSSN-41: the
Triaged move happened, the planner never saw it. Keys, status names, ids,
and URLs are safe unencoded; anything a person types is not.

`decide()` on each slug already reads the native system-webhook shape
(`webhookEvent` + `issue` +, for updates, `changelog`). Automation's
"Send web request" body is custom, so the templates below fill that
shape with smart values. Do not send a different envelope.

Triage requires `webhookEvent` to be exactly `jira:issue_created`. The
other three accept `jira:issue_updated` or `issue_updated`. `issue.key`
must look like `TLSSN-42`. `issue.fields.status.name` must still be the
status the changelog says it entered, or the handler treats the delivery
as stale.

`changelog.id` must be a non-empty string (or number). Automation does
not always expose the native changelog id, so the status template uses a
stable fallback from the issue key, the current status, and
`issue.updated`. A redelivery of the same transition keeps that id; a
later move gets a new `issue.updated`.

The desk also reads the ticket's status entry time from the end of that
fallback id (`{{issue.updated}}`), so the planner-liveness check compares
a `Planning started:` marker against when the ticket entered Triaged, not
when the delivery arrived. A body may instead carry a top-level
`"timestamp"` (epoch milliseconds), which wins when present. A native
numeric changelog id carries no time; the desk then uses receipt time.

### Every free-text smart value needs `.jsonEncode`

Automation pastes a smart value into the body as raw text. Inside a
JSON string, a title, comment, name, or description that contains a
double quote, a backslash, or a newline ends the string early, and the
whole body stops being JSON. So every free-text value in every template
below carries `.jsonEncode`: `issue.summary`, `issue.description`,
`comment.body`, and any `displayName`. Keep the surrounding quotes;
`jsonEncode` escapes the value, it does not wrap it. Keys, the issue
URL, status names, project keys, ids, and `issue.updated` are safe raw.
`.jsonEncode` is a documented Jira Cloud Automation text function
([smart values — text fields](https://support.atlassian.com/cloud-automation/docs/jira-smart-values-text-fields/)).
`scripts/jira-automation-templates.test.mjs` fails when a template here
drops it, or adds a smart value that is neither encoded nor on its
safe-raw list.

A broken body fails silently everywhere you can see. Jira still audits
the rule **Success** / "Successfully published web request" (the edge
answers `202` before anything parses the body). On the pod, every Jira
route (triage and planner `webhook`, desk and worker `jira`) declares a
`bodySchema`, so July's route layer (`invokeChannelRoute`,
`@cursor/july` 0.2.11 to 0.2.13) answers `400 Request body must be valid JSON`
before the factory handler runs; no handler code sees the request, so
there is no factory log line to add. Hosted delivery turns that `4xx`
into a `skipped` delivery with no session. July prints one line on the
catch VM, `[bdk] catch replay rejected by handler … status=400
reason=handler_rejected` (the reason is `handler_rejected`, not
`invalid_json`, because the error text is not a token), and that line is
lost with the VM ([`bugs.md`](bugs.md)). On a local serve the caller
gets the 400 `Request body must be valid JSON` directly and no line
prints; hosted, the line prints on the catch VM and is lost with it.

The delivery binding,
`GET https://api.cursor.com/internal/agentsdk/deployments/<slug>/session-deliveries/<deliveryId>?teamId=<team>`
with a Cursor API key, is no help for a live rule. It needs the
`deliveryId` from the edge's `202` body, which Jira does not show with
"Wait for response" off, and it answers only `skipped`, `failed`, or
`allocated` with a `sessionId`, with no reason: a body that is not JSON, a stale
secret, and an ignored event all read `skipped`, and on `factory-desk`
so does every accepted delivery ([`verification.md`](verification.md),
"Evidence for decisions that start no turn"). Catch it before it ships
instead: read each rule's custom data (step 6 of the operator
checklist) and run a ticket whose title has a double quote (step 7).

It bites only on some tickets, which makes it look like a stall. The
live status and comment rules (`factory-planner`, `factory-desk`,
`factory-desk-comments`, `factory-worker`) sent raw `{{issue.summary}}`
while the triage rule used `.jsonEncode`. Tickets planned normally until
TLSSN-40 and TLSSN-41 (2026-09-27 UTC), whose titles contain double quotes
(`every "Freeze card" button`, `the "Sol 214"-style day separators`):
their Triaged deliveries were dropped, so the planner never ran and the
desk posted no planner crumb, while triage (encoded) still worked. Jira's
**Validate** on a quote-free ticket such as TLSSN-39 still showed `202`.

The rules had drifted from this doc. Its Status and Comment templates
have used `.jsonEncode` since 2026-09-24 09:30 UTC (62ecc21); the raw
`{{issue.summary}}` was the template #79 shipped 90 minutes earlier, and
the rules were pasted from it. The test guards this doc, not the live
rules: after any template change here, re-paste each rule's custom data
(step 6 of the operator checklist).

Because the desk rule carries the same summary, a broken desk rule also
drops the Triaged delivery that arms the desk's plan hop watch, so no
hop-watch line posts. `retry KEY` and `plan KEY` do not help until the
rule is fixed: they move the ticket in Jira, which fires the same rule
with the same title. Fix the custom data first, then `plan KEY` (or
`retry KEY`), or drive the hop by signed replay
(`node scripts/replay-jira-transition.mjs <URL> <KEY> Triaged --from "To Do"`).

### Created (triage)

Use `.jsonEncode` on every free-text field, as above. Raw
`{{issue.description}}` can dump ADF, wiki markup, or quotes and
break the JSON; a broken body never reaches `parseQueueEvent`.

Prefer `{{issue.description.plainText.jsonEncode}}` so the handler
gets a string. If that smart value is empty on your site (some
fields only expose `.text` or the wiki body), fall back to
`{{issue.description.text.jsonEncode}}`, then
`{{issue.description.jsonEncode}}`.

```json
{
  "webhookEvent": "jira:issue_created",
  "issue": {
    "key": "{{issue.key}}",
    "self": "{{issue.url}}",
    "fields": {
      "summary": "{{issue.summary.jsonEncode}}",
      "description": "{{issue.description.plainText.jsonEncode}}",
      "status": { "name": "{{issue.status.name}}" },
      "project": { "key": "{{issue.project.key}}" },
      "reporter": { "displayName": "{{issue.reporter.displayName.jsonEncode}}" }
    }
  }
}
```

### Status (planner, desk, worker)

`issue.summary` is the only free text here, and it needs `.jsonEncode`
like the others: a title with a double quote otherwise drops the
delivery (TLSSN-40, TLSSN-41).

```json
{
  "webhookEvent": "jira:issue_updated",
  "issue": {
    "key": "{{issue.key}}",
    "fields": {
      "summary": "{{issue.summary.jsonEncode}}",
      "status": { "name": "{{issue.status.name}}" },
      "project": { "key": "{{issue.project.key}}" }
    }
  },
  "changelog": {
    "id": "{{issue.key}}:{{issue.status.name}}:{{issue.updated}}",
    "items": [
      {
        "field": "status",
        "fromString": "{{#changelog.status}}{{fromString}}{{/}}",
        "toString": "{{#changelog.status}}{{toString}}{{/}}"
      }
    ]
  }
}
```

If the rule trigger is **Field value changed** (Status) and the
`changelog.status` loop is empty, substitute:

```text
{{fieldChange.fromString}}
{{fieldChange.toString}}
```

If `{{changelog.id}}` is present in your site's smart values, it can
replace the `id` fallback.

### Comment (desk outcomes)

Both `issue.summary` and `comment.body` need `.jsonEncode`; factory
outcome comments are multi-line and often quote a title.

```json
{
  "webhookEvent": "comment_created",
  "issue": {
    "key": "{{issue.key}}",
    "fields": {
      "summary": "{{issue.summary.jsonEncode}}",
      "status": { "name": "{{issue.status.name}}" },
      "project": { "key": "{{issue.project.key}}" }
    }
  },
  "comment": {
    "id": "{{comment.id}}",
    "body": "{{comment.body.jsonEncode}}"
  }
}
```

`comment.id` lets the desk read the exact comment back and link to it;
without it the desk claims a hash of the body and reads the newest
planner comment of that kind. The body only has to carry the first line;
the desk posts what it reads back from Jira, and falls back to this body
only when the read fails.

The planner's `decideStatusEvent` (`planner/agent/lib/jira-event.ts`)
requires `changelog.items` to contain one entry with `field` =
`status` and string `fromString` / `toString`. The template above
already matches that shape. A body that omits the items array, uses
other field names, or leaves `fromString` / `toString` empty is
`not_status_change` and never plans. Do not change the planner to
guess a status from `issue.fields.status` alone.

## Operator checklist

Run this after every deploy of `factory-triage-jira`, `factory-planner`,
or `factory-desk`, and after any rule edit. It needs a TLSSN project
admin for the rule screens; nothing here needs a Jira API token.

1. **Rules.** Project settings → Automation in `TLSSN`. Five rules,
   enabled, scoped to this project (not global or multi-project).
   **One delivery source:** ask a site admin to open Settings → System →
   WebHooks and confirm no enabled webhook points at a factory engine
   alias ([`jira-webhooks.md`](jira-webhooks.md)). Disable any that do,
   or disable these rules instead; never keep both.
2. **`factory-triage-jira`.** Trigger **Issue created**, no condition
   on the actor or issue type. One action, Send web request: POST, the
   triage engine alias plus `/v1/channels/webhook/` (trailing slash),
   headers `Content-Type: application/json` and
   `X-Factory-Webhook-Secret` = that slug's `JIRA_WEBHOOK_SECRET`,
   custom data = the Created template (`"webhookEvent":
   "jira:issue_created"`), "Wait for response" off.
3. **`factory-planner`.** Trigger **Issue transitioned** with
   destination status **Triaged** and no "from" status, so triage's move
   and the desk's bounce (To Do → Triaged) both fire it. Send web
   request to the planner alias plus `/v1/channels/webhook/`, the same
   two headers with the planner's secret, custom data = the Status
   template. Both moves are made through the Atlassian connector as the
   consenting user, not by a rule, so "Allow rule trigger" is not needed
   for them; tick it only if another rule moves cards into Triaged.
4. **`factory-desk`.** Trigger **Issue transitioned** to Triaged,
   Planned, Approved, In Progress, In Review, and Done, **Allow rule
   trigger** ticked, the desk alias plus `/v1/channels/jira/`, the
   desk's secret, the Status template.
5. **`factory-desk-comments`.** Trigger **Issue commented**, **Allow
   rule trigger** ticked, the same desk URL and secret, the Comment
   template, no condition. Without it a ticket the planner does not
   plan leaves the thread silent after its Triaged line, a stopped
   triage after the filing reply, and a failed launch after the
   Approved line.
6. **Receipt.** `curl` each URL unsigned (below) and expect `202`. That
   proves only the URL; the pod's `401` for a bad secret, and its `400`
   for a body that is not JSON, are invisible from here and from the
   audit log. Open each rule's custom data and confirm every
   free-text smart value ends in `.jsonEncode` ("Every free-text smart
   value needs `.jsonEncode`" above).
7. **One concrete ticket, watched in Slack.** `@factory file a bug:
   <symptom>; expect <behaviour>`, then `approve file`. Put a double
   quote in the symptom (for example `the "Export" button`) so the
   title carries one and an unencoded summary shows up as a stall at
   the first rule that has it. Read the thread and the ticket:

   | You see | It proves, or where to look |
   | --- | --- |
   | `KEY is Triaged: bug, … severity. The planner checks it against the code next…` within a minute or two | triage rule, triage pod and secret, desk rule on Triaged |
   | Every status line (Triaged, Approved, In Progress, In Review, Done) posts twice, or two `Needs info:` lines land for one planning pass | Both a TLSSN Automation rule and a site system WebHook deliver to the slugs. Keep one (step 1). The desk's claim settle (#133) absorbs two deliveries of one changelog id, not one transition under two ids |
   | `KEY is Triaged … so the planner skips it` | Not a stall. Triage's verdict (question, needs info, duplicate) is one the planner skips; the line says which |
   | No Triaged line; the ticket has a `Triage:` comment and is in Triaged | Triaged is missing from the desk rule (step 4) |
   | `KEY is still in To Do: triage stopped…` with a `Why:` line | Not a stall. The triage run ended with the ticket in To Do; the `Why:` names it (a failed run, no verdict, a verdict that could not be written, or a move into Triaged that Jira refused). `plan KEY` sends it to the planner. Proves the triage rule and the desk comment rule |
   | No Triaged line; a `Triage:` comment but still in To Do, and no `Triage stopped:` comment | Triage could not move it and its end hook did not report (the pod was replaced, or the status could not be read): the connector consent or the workflow's transition into Triaged |
   | A `Triage stopped:` comment on the ticket, no line in the thread | The desk comment rule is missing or its secret is stale (step 5); `replay-jira-comment.mjs --kind triage-stopped` posts it. A ticket filed in Jira gets its intake root from this line, so the root itself is missing too |
   | No Triaged line and no `Triage:` comment after three minutes | The triage rule did not fire, or its secret is stale: the rule's audit log first (step 2), then `node scripts/e2e-drive.mjs --ticket <KEY> --only triage` to drive that ticket by signed replay |
   | `KEY is planned` several minutes after the Triaged line | planner rule, planner pod and secret. A planner run takes minutes |
   | Filed (or Triaged) line, the ticket is in Triaged, and no planner crumb, no plan, no `Needs info:` and no `Plan stopped:` after ten minutes, while quote-free titles plan | A rule body with a raw free-text smart value (usually `{{issue.summary}}` without `.jsonEncode`): the title's double quote made the body invalid JSON, and the delivery was skipped before any handler ran. When the desk rule is broken too, no hop-watch line comes. Fix the rule's custom data first, then `plan KEY` / `retry KEY` or a signed `replay-jira-transition.mjs` ("Every free-text smart value needs `.jsonEncode`") |
   | `KEY needs more information, so it has no plan…` with what the planner checked and searched | Not a stall. The sandbox does not show the claimed failure. Reply in the thread with a failing path, error, or steps. Proves the planner rule and the desk comment rule |
   | `Added your reply to KEY and sent it back to the planner.` after a reply to a Needs info, then a Triaged line | The reply is a `Detail from Slack: KEY` comment and the ticket was bounced To Do → Triaged; the planner rule fires again. Then a plan or a new Needs info line |
   | A reply to a Needs info, and no `Added your reply…` line | The reply was a desk command (it went to the model) or a bare thanks (no reply at all), the ticket had already left Triaged, or the desk was deployed before thread replies were taken. Say it again, or `plan KEY` after editing the ticket |
   | `KEY has no plan: the planner stopped…` with a `Why:` line | The planning run ended without a plan or a Needs info verdict; the `Why:` names it (a failed run, a refused plan, a plan that did not move to Planned) |
   | A `Needs info:` or `Plan stopped:` comment on the ticket, no line in the thread | The desk comment rule is missing, its secret is stale, or its body has a raw `{{comment.body}}` or `{{issue.summary}}` (step 5). `scripts/replay-jira-comment.mjs` posts that comment by signed replay |
   | `KEY has not been triaged N minutes after it was filed.` | The desk's triage hop watch: no Triaged move and no `Triage stopped:` 15 minutes after filing. The triage rule did not fire, or its run was lost (row "No Triaged line and no `Triage:` comment"). `retry KEY` sends it to the planner without a verdict |
   | `KEY still has no plan N minutes after it went to the planner…` | The desk's plan hop watch: no plan outcome 15 minutes after the move into Triaged. It reads the planner's `Planning started: KEY` comment: "the planner is still running (N min)" means a run is live and `retry KEY` is refused until it ends or passes 40 minutes; "never reported starting" means no run began (the wake was lost); "probably lost" means a run started over 40 minutes ago and never ended. `retry KEY` starts a fresh run in the last two cases |
   | `KEY's planning hasn't started 4 minutes after it went to the planner, so I've sent it to the planner again.` | The desk's plan start check: no `Planning started: KEY`, plan, or plan outcome for this Triaged entry at 4 minutes, so the planner's wake was lost (on hosted v2 usually a delivery that never started its turn, [`deployment-issues.md`](deployment-issues.md) issue 28). The desk re-sent the ticket once (To Do and back to Triaged), as `retry KEY` would. Nothing to do unless the final line follows. `…and I could not send it to the planner again (reason).` means the re-send's move failed; `retry KEY` (or the board move) sends it |
   | `KEY's planning still hasn't started after one automatic retry, so planning couldn't start. The next step is a planner redeploy or asking ops; …` | The retried entry did not start either, and the desk never retries twice per episode (a later entry in the episode, a person's `retry`, hears the same line without "after one automatic retry"). Redeploy the planner at the same ref (that is what recovered TLSSN-60), then `retry KEY` in the thread or To Do and back to Triaged on the board. The 15-minute "still has no plan" line for that entry stays quiet |
   | `KEY was approved N minutes ago, but no implementation has started.` | The desk's launch hop watch: no `Implementing:`, In Progress, `Launch failed:`, or "Approved without a plan" 7 minutes after Approved (a minute after the worker's own relaunch could last land). The worker rule did not fire, or its body is not JSON for this title (a raw `{{issue.summary}}`). A run lost after the worker's claim now relaunches itself about 4 minutes after the approval (TLSSN-51; `factory-worker` README, "Lost launches"), and a delivery the worker saw but did not launch leaves `Launch pending:` or `Launch skipped:` on the ticket; a ticket with none of those lines never reached the worker. `retry KEY` redelivers the approval; for a body that is not JSON, fix the worker rule's custom data first, or the redelivery is dropped the same way. A redelivery that finds the worker's `launched` claim does not start a second agent |
   | `KEY is still Approved … though implementation started: <url>` | The worker's `Implementing:` comment landed but its move to In Progress did not. `retry KEY` redelivers the approval, and the worker makes the move |
   | `KEY is In Progress. Implementation started: <url>`, the agent finished, and no In Review line (TLSSN-35) | The worker opens the implement PR from the agent's pushed branch (`factory-worker/agent/lib/implement-pr.ts`) through its reminder, or, when that reminder was never created or stopped firing, through the worker's backstop sweep on its next Jira or `pull_request` delivery; a ticket launched before that, or one on a factory quiet since, has no PR yet. `retry KEY` moves it In Progress → Approved; the worker moves it back, opens the PR ready for review, and the thread gets the In Review line with the link. No second agent starts. From the board, drag the card to Approved |
   | `The desk could not read KEY from Jira for N minutes…` | A hop watch fired, but three status reads in a row failed: the desk's Jira connection (Factory Atlassian team server or its consent) |
   | A ticket that sat silent past these deadlines, and no watch line | The desk's hop-watch reminder did not fire: check the desk's log for `could not be armed`. `retry KEY` still works. A Jira-filed ticket whose triage never ran has no root and no watch: check the triage rule (step 2) |
   | `retry KEY` in a Jira-filed ticket's intake thread gets `KEY was not filed from Slack…`, not a retry | Expected: one host line, no model turn (#144). `retry KEY` needs the Slack filer, and a Jira filing has none, so that thread's hop-watch line names the board move instead of `retry`. Recover from the board: move the card back to Triaged to replan, or to Planned and then Approved to relaunch |
   | A Jira-filed ticket reached Triaged, but no root in the intake channel | `FACTORY_DESK_INTAKE_CHANNEL` is unset on the desk, the project is not in `FACTORY_JIRA_PROJECTS`, or the description carries a `Slack thread:` line (a Slack filing that lost its binding, which never gets a second thread) |
   | A Triaged line, then no `Plan:`, `Needs info:`, or `Plan stopped:` comment after ten minutes | The planner rule did not fire, its secret is stale, or its body is not JSON for this title (row "…while quote-free titles plan"): its audit log should show one execution for the move into Triaged. For a body that is not JSON, fix the rule first; then `retry KEY` or `node scripts/replay-jira-transition.mjs <planner URL> <KEY> Triaged --from "To Do"` drives it by signed replay |
   | After `approve KEY`: a ✅ reaction, then only `KEY is In Progress. Implementation started: <url>` | Expected. A Slack approval gets no Approved line; the In Progress line with the agent link is the answer. A card dragged to Approved on the board does get `KEY is Approved…` first |
   | After `approve KEY`: a ✅ reaction and nothing else for several minutes | The worker has not moved it to In Progress: its rule, pod, or launch. A launch that fails or finds no plan posts its own line |
   | After `approve KEY`: `KEY is Approved, but nothing is being built: the cloud agent launch failed (<code>)…` | The worker's launch threw; the code names why (`unauthorized`, `rate_limited`, `service_unavailable`, …). Move the card to Planned, then `approve KEY` to launch again |
   | After `approve KEY`: `KEY is Approved, but nothing is being built: the ticket has no plan…` | The card reached Approved with no `Plan:` comment carrying a `Brief:`. Move it back to Triaged; approve the plan that lands |
   | `The factory did not move KEY to In Review for <repo>#<n>: …` | The implement PR opened (or merged) while the ticket was elsewhere; the line names the status it found. Move the card by hand if that PR is the implementation |
   | A `Launch failed:`, "Approved without a plan", or `not set from` comment on the ticket, no line in the thread | The desk comment rule is missing or its secret is stale (step 5) |

   Pass bar: every stop in the run ends in a line in the thread that says
   why and what to do next. A ticket that stops with only a Jira comment
   or move is a bug, even when the agent did the right thing
   ([`event-driven-factory.md`](event-driven-factory.md), "The thread
   always hears why"). A stop that writes nothing at all (a lost run, a
   rule that is off) still ends in a hop-watch line within the triage,
   plan, or launch deadline
   ([`event-driven-factory.md`](event-driven-factory.md), "Hop
   watchdogs").

8. **Do not nudge a ticket that is being planned.** Every entry into
   Triaged (triage's move, a `plan KEY` bounce, a replay) opens its own
   planning session. The first to finish plans the ticket; a later one
   finds it out of Triaged and writes nothing, but it still spends a
   run. Before this was guarded, a late session dragged TLSSN-21 from
   In Progress back to Planned (`deployment-issues.md` issue 15).

The status template's fallback changelog id includes `issue.updated`.
A delivery Automation renders again after the ticket changed carries a
new id, so it counts as a new transition and opens another session.
When your site exposes `{{changelog.id}}`, use it.

### One delivery source

The planner claims `plan/<KEY>:Triaged:<changelog id>` and the desk
claims each line per changelog id, so a transition that arrives twice
under two ids is two transitions to both. Nothing in the two bodies
names the transition the same way: Automation's fallback id is
`<key>:<status>:<issue.updated>`, a system webhook's is Jira's numeric
changelog id, and the planner's connector reads (comments, status,
transitions) never see the changelog. The only way left to tell a second delivery of one entry into
Triaged from a new entry is how close together they arrive. A time window
would drop a real re-entry (a `plan KEY` after a fast `Plan stopped:`, a
reply to a `Needs info:`) whenever one source throttles or loses its
delivery of it, and that drop is silent: the thread says the ticket went
back to the planner and no plan ever comes. The duplicate is noise; the
drop would be a stall. So the handlers keep every delivery, and the
operator keeps one source (step 1).

## Check each one

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' <URL>
```

`202` means the control plane accepted the delivery (the handler drops
the unsigned body with a 401 inside the pod). Automation's audit
Success is the same receipt: it is not a handler accept. Then create
an issue in `TLSSN` and watch for the `Triage:` comment and the move
to `Triaged`.

Smoke tip: file a **concrete** bug (symptom + expected behaviour),
not a one-line "something is wrong". Vague tickets make triage write
`Needs info:` and the planner will then skip Plan (see below). A
concrete bug that is not on `marsbank@main` ends in the planner's own
`Needs info:` and a line in the thread saying what it searched.

A signed synthetic transition (HMAC, from this directory with
`JIRA_WEBHOOK_SECRET` exported) still works:

```bash
node scripts/replay-jira-transition.mjs <URL> TLSSN-3 Approved
```

## What each slug does with the body

| Slug | Predicate | Actuation |
| --- | --- | --- |
| `factory-triage-jira` | `webhookEvent` is `jira:issue_created` and `issue.key` is a ticket | Model turn; `record_triage` comments and moves to Triaged. A turn that ends with the ticket still in To Do writes `Triage stopped:` with the reason (`agent/hooks/triage-outcome.ts`) |
| `factory-planner` | `jira:issue_updated` / `issue_updated`, status item **to** Triaged, current status still Triaged, project allowed, **and** the governing `Triage:` comment (the desk's marked one, else the first a triage run wrote, unless a person's later one corrects it) is not a question, duplicate, or unanswered `needs_info` | Plans; writes `Plan:`; moves to Planned. Or writes `Needs info:` (sandbox disagrees) or `Plan stopped:` (the run ended with neither, or the verdict gate skipped the move, once per changelog id; the desk relays it unless the thread already heard that gate) and leaves it in Triaged. Logs one `[planner] webhook …` line per delivery |
| `factory-desk` | same event, status item **to** Triaged, Planned, Approved, In Progress, In Review, or Done | Slack announcement in the ticket thread. Triaged posts the `Triage:` verdict once per verdict, after the claim settle (#125, #133). For a Jira-filed ticket with no thread, Triaged opens the intake root in `FACTORY_DESK_INTAKE_CHANNEL`, reacts on it, and comments `Slack thread: <permalink>` on the ticket once (#131). Triaged and Approved arm the plan and launch hop watches (#132). A move into Planned from Approved or later posts a move-back line, not the plan |
| `factory-desk` (comments) | `comment_created` / `jira:comment_created` whose first line is a factory outcome for that issue: `Triage stopped: <KEY>` (ticket still To Do), `Needs info: <KEY>` or `Plan stopped: <KEY>` (still Triaged), `Launch failed: …` or `Approved without a plan …` (still Approved), `<In Review\|Done> not set from <repo>#<n>: …` (any status); project allowed | Slack post in the ticket's thread: why the ticket did not move on and the next step. Claimed once per comment. For a Jira-filed ticket with no thread yet, every outcome but the worker's `not set from` note opens the intake root (#131). Never edits a root's status line. Also clears the hop watch that outcome ends |
| `factory-worker` | same event, status item **to** Approved, current status still Approved | Launches from the `Brief:` on the latest `Plan:` comment; with none, or when the launch throws, comments why and leaves it Approved. Its GitHub channel, not Automation, moves the ticket to In Review and Done from the implement PR (above) |

Hosted, in-process peers are stubbed (`FACTORY_INPROCESS_PEERS`
unset). `record_triage` reports `event_bus` and does **not** call
`plan_issue`. The only hosted path that writes `Plan:` is this
planner webhook on the Triaged transition.

After Triaged, `planFromStatus` reads the governing `Triage:` comment
(the desk's marked comment, else the first comment a triage run wrote, unless a person's later `Triage:` comment (no `Triaged by:` line) corrects it; `governingTriage` in the shared `desk-triaged.ts`) and runs
`parseTriage` → `decide`. A skip writes `Plan stopped: <KEY>` with one
`Why:` line, so the thread hears it. A comment that contains a line
`Needs info:` sets `needsInfo: true` and returns
`{ plan: false, reason: "needs_info" }`. That ticket never gets a
`Plan:` comment or a Planned transition via Automation. HMAC replay
of the same Triaged event is accepted (not 401) and still skips:
the gate is the comment, not the signature. Question and duplicate
verdicts skip the same way. Do not change the planner to plan
`needs_info` tickets.

## Same rules as Cursor Automations (cursor-agent YAML)

The five rules above are also written down as Cursor Automations
config-as-code in the old monorepo `.cursor/automations/` (not included in this snapshot)
(`factory-triage-jira.yaml`, `factory-planner.yaml`, `factory-worker.yaml`,
and the two desk rules folded into `factory-desk.yaml`). There is no Jira
trigger kind, so each one is a `webhook: {}` trigger: the rule would keep
its trigger and body, POST to
`https://api2.cursor.sh/automations/webhook/<automationId>`, and send
`Authorization: Bearer <owner's Cursor API key>` in place of
`X-Factory-Webhook-Secret`. The files ship `enabled: false`; the rules on
this page stay the live path. Details, commands, and what the automation
cannot do that the hosts do: [`cursor-agent-automations.md`](cursor-agent-automations.md).
