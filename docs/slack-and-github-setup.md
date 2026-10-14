# Slack and GitHub setup

How the factory's two chat and code integrations are wired, how to check
them, and what to look at when an event goes missing. Run every command
from ``. Team `<CURSOR_TEAM_ID>`, BDK
`@cursor/july` 0.2.18. Jira Automation rules are in
[`jira-automation.md`](jira-automation.md); the full deploy is in
[`factory-deployment.md`](factory-deployment.md). Secret names only
appear here; never put a value in a file.

## Slack

### The app

`factory-desk` is the only host with Slack. Its channel is
`factory-desk/agent/channels/slack.ts` (`slackChannel({ envPrefix:
"FACTORY_DESK" })`), so the app's tokens are the secrets
`FACTORY_DESK_SLACK_BOT_TOKEN` and `FACTORY_DESK_SLACK_APP_TOKEN`
(`factory-desk/agent/agent.ts`). The app is named Factory, lives in the
`<SLACK_WORKSPACE>` workspace, and is minted with the v2 Slack wizard, never
`slack create` (which still drafts v1 on this team; see
[`factory-deployment.md`](factory-deployment.md) section 3).

The desk listens in:

- `#mars-eng-intake` (`C0EXAMPLE1`): every post reaches the host
  (`engagement.channelPosts`, `posts: "all"`, from
  `factory-desk/agent/lib/desk-channels.ts`), and
  `factoryThreadReplies` drops everything that is not a reply in a factory
  thread. `FACTORY_DESK_INTAKE_CHANNEL` can name one more watched channel.
- DMs to the app.
- Mentions of the app in any channel it has been invited to. Outside the
  watched channels only a mention reaches it.

### Scopes and events

The desk needs the 0.2.11 manifest, the one July generates for every Slack
channel (`@cursor/july/dist/channels/slack/manifest.js`):

| Bot scopes | |
| --- | --- |
| Messages | `app_mentions:read`, `chat:write`, `assistant:write` |
| History | `channels:history`, `groups:history`, `im:history`, `mpim:history` |
| Conversations | `channels:read`, `groups:read`, `im:read`, `im:write` |
| Reactions | `reactions:read` (approvals), `reactions:write` (stage emoji and acks) |
| Files | `files:read`, `files:write` |
| People | `users:read`, `users:read.email`, `usergroups:read` |

| Bot events | Why |
| --- | --- |
| `app_mention` | New requests (`@Factory ...`) |
| `message.im` | DMs |
| `message.channels`, `message.groups` | Plain replies in factory threads in the watched channels |
| `reaction_added` | ✅ / ❌ approvals (`onReactionAdded: deskReactions()`) |
| `app_home_opened` | App home |

The app was first minted from the 0.2.2-era wizard, which had neither
`reactions:read` nor `reaction_added`. Print the current manifest and apply
it through the v2 wizard, reinstall when Slack asks for the new scope,
then redeploy the desk so `reaction_added` becomes a subscription edge:

```bash
npx -y -p @cursor/july@0.2.24 agent-sdk slack manifest --dir factory-desk --name Factory --channel-posts --env prod --print
```

### How people use it

- A new request starts with `@Factory` in `#mars-eng-intake` or in a DM.
  Jev triages it before anything is filed.
- Plain replies inside a factory thread need no mention: `approve file`,
  `approve KEY`, `retry KEY`, and questions all reach the desk.
- Approvals are ✅ / ❌ reactions, or the typed commands. There are no
  buttons or cards (`toolApprovals: false`).
  - The filing prompt takes ✅ (file it with that triage) or ❌ (nothing
    is filed). ✅ gives one Filed post.
  - The plan post takes ✅ (Planned → Approved, then the worker starts) or
    ❌ (a `Denied in Slack` comment; the ticket stays Planned).
  - Only the person the typed command would accept counts: the requester
    on the filing prompt, the filer on the plan post. Other people, bots,
    and the desk's own reactions are ignored with no reply. A ticket
    filed in Jira has no Slack filer, so only the board approves it.
- After approval the thread gets exactly one In Progress post, then the
  marsbank PR link, then review updates, then In Review.

The full reaction rules are in [`reaction-approvals.md`](reaction-approvals.md)
and [`../factory-desk/README.md`](../factory-desk/README.md).

### Check the scopes

1. In the Slack app's settings (api.slack.com, the Factory app):
   OAuth & Permissions → Bot Token Scopes lists `reactions:read`, and
   Event Subscriptions → Subscribe to bot events lists `reaction_added`.
   If either is missing, apply the manifest above and reinstall.
2. `npx -y -p @cursor/july@0.2.24 agent-sdk slack doctor --prefix FACTORY_DESK`
   with the tokens in your environment: `app_token`, `connections_open`,
   `bot_token`, `auth_test` all green.
3. `@Factory hello` in `#mars-eng-intake` gets one reply.
4. React ✅ to a new filing prompt you asked for, then read the session:

   ```bash
   npx -y -p @cursor/july@0.2.24 agent-sdk logs --prod --slug factory-desk --team <CURSOR_TEAM_ID>
   ```

### Troubleshooting

| Symptom | Check |
| --- | --- |
| ✅ / ❌ does nothing, typed `approve file` works | The app is missing `reactions:read` or the `reaction_added` event, or the desk was not redeployed after the manifest change. Apply the manifest, reinstall, redeploy `factory-desk` |
| Reaction ignored on one post only | Only a filing prompt or plan post the desk recorded counts, and only from the requester or filer. Posts from before 0.2.11 was deployed do nothing |
| Plain reply ignored, a mention works | The thread is outside `#mars-eng-intake` and DMs; there only a mention reaches the desk. Or `message.channels` / `message.groups` is missing |
| `[bdk/slack] warn setTitle not-ok error=no_permission` on channel messages | Not a scope problem: a missing scope reads `missing_scope`. July 0.2.11 (and still 0.2.13) sends `assistant.threads.setTitle` without waiting, alongside the `setStatus` that creates the thread's agent session, and Slack's bridge refuses to title a session that does not exist yet. The desk now opens the session before July's paint (`factory-desk/agent/lib/agent-session.ts`), so after a deploy the line should stop. If it continues, the live app is not declared as an agent: check that the Agents feature (`agent_view`) and `assistant:write` from the 0.2.11 manifest are applied, then reinstall. Cosmetic either way |
| Nothing reaches the desk at all | Tokens not set on the slug (`agent-sdk secrets list factory-desk --team <CURSOR_TEAM_ID>`), or inbound Slack is gated for the team; see [`deployment-issues.md`](deployment-issues.md) |

## GitHub

### Installation and event wiring

- The `cursor-demo-lab` GitHub installation is linked to team `<CURSOR_TEAM_ID>`
  (dashboard, team selected, Integrations → GitHub → Manage). The hosts use
  it through `cursorAccount` in each `agent/channels/github.ts`; there is
  no GitHub PAT or App key in any host.
- Sandbox `cursor-demo-lab/marsbank`, with a CI workflow, Bugbot on, and
  auto-merge off. Merges are human only.
- Every GitHub slug is deployed with
  `--cursor-events-repo cursor-demo-lab/marsbank`. A redeploy without it
  drops the subscription:

  ```bash
  npx -y -p @cursor/july@0.2.24 agent-sdk deploy --ref <full 40-char SHA> --dir <folder> --slug <slug> --cursor-events-repo cursor-demo-lab/marsbank --team <CURSOR_TEAM_ID>
  ```

- Check the subscription on each slug. Both should show
  `watching: cursor-demo-lab/marsbank`:

  ```bash
  npx -y -p @cursor/july@0.2.24 agent-sdk event-repos <slug> --team <CURSOR_TEAM_ID>
  npx -y -p @cursor/july@0.2.24 agent-sdk deployment <slug> --team <CURSOR_TEAM_ID>
  ```

  `agent-sdk event-repos <slug> --repo cursor-demo-lab/marsbank --team <CURSOR_TEAM_ID>`
  sets it without a redeploy.

### Who consumes what

From each host's `agent/channels/github.ts`:

| Slug | Permissions | GitHub events used |
| --- | --- | --- |
| `factory-desk` | `read` | `pull_request` (opened, reopened, ready_for_review, synchronize), `check_suite` and `workflow_run` completed, `pull_request_review` submitted. Posts review updates to the Slack thread |
| `factory-worker` | `pr-write` | `pull_request` on its implement PR (In Review, and Done when a person merges) |
| `factory-pr-autofixer` | `contents-write` | `check_suite`, `check_run`, `workflow_run`, `status` failures on a factory PR; a person's `factory: drive` comment; `pull_request` closed. Pushes to the PR branch |
| `factory-security-reviewer` | default | `pull_request` (opened, synchronize, reopened, ready_for_review, base retarget). Posts one `## Security review` review |
| `factory-planner` | `read` | None (`webhookEvents: []`); subscribed only so its sandbox checkout has repo access |
| `factory-triage-jira` | none | Jira only; deployed without `--cursor-events-repo` |

### Review gate lines

The desk writes review updates in the thread, one line per gate, in this
order: 🐛 Bugbot, 🔒 security review, 🏗️ CI, 📡 change review, 🔧 autofix.
Each carries its state, for example `🐛✅`, `🔒⚠️`, `🏗️❌`, `📡❔`, `🔧`.
The meanings are in the README's review table.

### Secrets

Since 0.2.11 GitHub, GitLab, and Bitbucket credentials on a channel are
referenced by name, `{ secretName: "NAME" }`, never as a literal or an env
getter. The factory hosts use `cursorAccount` and set none. If a host ever
takes App credentials, name them (for example
`privateKey: { secretName: "GITHUB_APP_PRIVATE_KEY" }`), add the name to
`hosting.secretNames`, and set the value with
`agent-sdk secrets set <slug> NAME --team <CURSOR_TEAM_ID>`.

## Same triggers as cursor-agent YAML

The live factory is the six hosted Agent SDK deployments above. The same
event wiring is also written as Cursor Automations config-as-code in
the old monorepo `.cursor/automations/` (not included in this snapshot), deployable with
`cursor-agent automations deploy`; the files ship `enabled: false`. See
[`cursor-agent-automations.md`](cursor-agent-automations.md) for the full
files and commands.

`factory-desk.yaml`, `workflow.triggers` (as in the file):

```yaml
triggers:
  - slackMention:
      channel: C0EXAMPLE1
  - slackReactionAdded:
      channel: C0EXAMPLE1
      emojiName: white_check_mark
  - slackReactionAdded:
      channel: C0EXAMPLE1
      emojiName: x
  - slackTrigger:
      channel: C0EXAMPLE1
      topLevelOnly: false
    agenticFilterPrompt: |-
      Pass only a plain reply inside a thread the factory started (a filing
      prompt, a Filed post, or a ticket status thread). Drop top-level posts
      and replies in threads the factory is not part of.
  - webhook: {}
```

`factory-security-reviewer.yaml` and `factory-pr-autofixer.yaml`,
`workflow.triggers` (as in the files):

```yaml
triggers:
  - git:
      pullRequest:
        repos:
          - https://github.com/cursor-demo-lab/marsbank
        prAction: GIT_PULL_REQUEST_ACTION_OPENED
  - git:
      pullRequest:
        repos:
          - https://github.com/cursor-demo-lab/marsbank
        prAction: GIT_PULL_REQUEST_ACTION_PUSHED
```

```yaml
triggers:
  - git:
      ciCompleted:
        repos:
          - https://github.com/cursor-demo-lab/marsbank
        condition: GIT_CI_COMPLETION_CONDITION_FAILURE
        ignoreBaseFailures: true
    agenticFilterPrompt: |-
      Pass only a failed check on a factory pull request: its head branch
      starts with an allowed Jira ticket key (for example `TLSSN-12`), or its
      title starts with such a key and the pull request author's login is
      exactly `cursor[bot]`. A keyed title on a pull request a person opened
      does not count. Drop every other pull request. Pull requests a person
      opts in with a `factory: drive` comment come through the other trigger.
  - git:
      pullRequest:
        repos:
          - https://github.com/cursor-demo-lab/marsbank
        prAction: GIT_PULL_REQUEST_ACTION_COMMENTED
        commentContains: "factory: drive"
    agenticFilterPrompt: |-
      Pass only a pull request comment whose first line is exactly `factory: drive`
      and whose author is an owner, member, or collaborator of the repository.
```

Automations have no Jira trigger, so Jira rules map to `webhook: {}`.
