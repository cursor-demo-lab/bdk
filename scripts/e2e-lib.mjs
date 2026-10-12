// Pure step and assertion logic for scripts/e2e-drive.mjs. Everything here
// takes fetched facts and returns a decision or a verdict; no I/O except the
// injected clock in poll().

import { parseArgs } from "node:util";

export const STATUSES = ["To Do", "Triaged", "Planned", "Approved", "In Progress", "In Review", "Done"];

export const STEPS = ["ticket", "triage", "plan", "announce", "approve", "progress", "prs", "review", "red-check", "drive", "cleanup"];
export const JIRA_HOPS = ["triage", "plan", "announce", "approve", "progress"];
export const GITHUB_STEPS = ["prs", "review", "red-check", "drive"];

export const DEFAULTS = {
  site: "<JIRA_SITE>.atlassian.net",
  email: "<OPERATOR_EMAIL>",
  project: "TLSSN",
  label: "factory-e2e",
  repo: "cursor-demo-lab/marsbank",
  base: "main",
  reviewHead: "factory-test/review",
  reviewTitle: "Factory e2e: review",
  redHead: "TLSSN-3-factory-red-check",
  redTitlePrefix: "TLSSN-3:",
  redTitle: "TLSSN-3: Factory e2e red check",
  fixerLogins: ["factory-pr-autofixer[bot]"],
  reviewerLogins: ["cursor[bot]"],
  timeoutSec: 600,
  githubTimeoutSec: 1800,
  quietSec: 180,
  pollSec: 15,
  agentTimeoutSec: 900,
};

export const GITHUB_MODES = ["token", "cloud-agent"];

/**
 * How `--github=cloud-agent` launches its writers. `startingRef` is where the
 * VM checks out; the agent changes nothing there. With `autoCreatePR: false`
 * the agent's PR tool only queues the PR for the key owner to approve, so it
 * must be true; the agent makes no commits, so nothing else is opened. The
 * API accepts only a full catalog variant, so every parameter is spelled out.
 * PRs open as the key owner; comments post as the Cursor GitHub App.
 */
export const CLOUD_AGENT = {
  repoUrl: `https://github.com/${DEFAULTS.repo}`,
  startingRef: "main",
  autoCreatePR: true,
  commentLogins: ["cursor[bot]"],
  model: {
    id: "claude-opus-5-5",
    params: [
      { id: "context", value: "300k" },
      { id: "effort", value: "medium" },
      { id: "fast", value: "false" },
    ],
  },
};

export const ROUTES = {
  triage: { slug: "factory-triage-jira", env: "FACTORY_ROUTE_TRIAGE" },
  planner: { slug: "factory-planner", env: "FACTORY_ROUTE_PLANNER" },
  worker: { slug: "factory-worker", env: "FACTORY_ROUTE_WORKER" },
  desk: { slug: "factory-desk", env: "FACTORY_ROUTE_DESK" },
};

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const SECURITY_REVIEW = "## Security review";
/** security-reviewer/agent/tools/post_findings.ts writes exactly this head, then one line per finding. */
const REVIEWER_BODY = /^## Security review\n\n\*\*Verdict:\*\* (CLEAN|FINDINGS)(?:\n|$)/;
const DRIVE_SENTINEL = "factory: drive";
const AGENT_URL = /https:\/\/cursor\.com\/agents\/[A-Za-z0-9_-]+/g;

export const USAGE = `usage: node scripts/e2e-drive.mjs [options]

Drives the Slack, Jira, GitHub factory end to end and asserts each hop.
Prints one row per step, marked pass, pass (prior run), fail, blocked, unverified, or skipped;
exits 1 on any fail.

  --ticket KEY          reuse this ticket (default: the newest open ${DEFAULTS.label} ticket, else create one)
  --new-ticket          create a new ticket even if an open ${DEFAULTS.label} ticket exists
  --reset               move a reused ticket back to To Do first so every hop runs again.
                        Comments stay; a hop counts only comments and moves from this run.
  --replay              POST signed synthetic Jira webhooks to each route (default)
  --live                rely on the real Jira webhooks; POST nothing
  --only a,b            run only these steps
  --skip a,b            skip these steps
  --cleanup             close the test PRs and move the ticket to Done
  --cleanup-branches    with --cleanup, also delete branches the fixer created (token needs Contents write)
  --assume-blocked x    atlassian and/or github: report their hops as blocked instead of waiting
  --github MODE         token: the driver writes to GitHub with FACTORY_E2E_GITHUB_TOKEN.
                        cloud-agent: each GitHub write (the two PRs, the factory: drive comment)
                        is one Cursor cloud agent; the driver only reads GitHub and verifies.
                        With no agent launcher only those writes are blocked; existing PRs,
                        review, and red-check are still read.
                        Default: token when FACTORY_E2E_GITHUB_TOKEN is set, else cloud-agent.
  --timeout S           seconds per Jira hop (default ${DEFAULTS.timeoutSec})
  --github-timeout S    seconds per GitHub wait (default ${DEFAULTS.githubTimeoutSec})
  --agent-timeout S     seconds per cloud agent run in cloud-agent mode (default ${DEFAULTS.agentTimeoutSec})
  --quiet S             quiet window after the first drive start (default ${DEFAULTS.quietSec})
  --poll S              poll interval (default ${DEFAULTS.pollSec})
  --help                this text

Steps: ${STEPS.join(", ")}

Credentials (names only are printed):
  JIRA_API_KEY, JIRA_EMAIL (default ${DEFAULTS.email}), JIRA_CLOUD_ID (else tenant_info)
  JIRA_WEBHOOK_SECRET   signs replayed webhooks
  FACTORY_ROUTE_TRIAGE, FACTORY_ROUTE_PLANNER, FACTORY_ROUTE_WORKER, FACTORY_ROUTE_DESK
                        override the URLs in docs/jira-webhooks.md
  FACTORY_E2E_GITHUB_TOKEN  fine-grained, ${DEFAULTS.repo}: Contents read, Pull requests write,
                        Issues write, Actions read. In cloud-agent mode it is only read.
  (cloud-agent)         GitHub reads fall back to \`gh auth token\`. Agents launch as a Cursor user:
                        FACTORY_E2E_CURSOR_API_KEY, else the stored \`agent-sdk login\` key.
                        CURSOR_API_KEY and service-account keys are never used.
  FACTORY_E2E_AGENT_JIRA_ACCOUNTS  comma list of Jira accountIds the agents write as (the Factory
                        Atlassian consent). Unset: any account but the driver's own (GET /myself).
                        A comment or status move by the driver's account never counts for an agent.
  FACTORY_E2E_FIXER_LOGINS  comma list of the fixer's GitHub logins; only their comments and pushes
                        count for drive and red-check. A push's login is the actor of the push or
                        pull_request workflow run on the commit, never the commit's author; with no
                        such run the push does not count. A pull_request run its
                        reopener started right after reopening the PR names no pusher. Nor does one
                        its author started right after opening it. Logins match case-insensitively.
                        A run counts only when its head_sha, head_branch, head_repository and
                        pull_requests name this commit, fixture branch, repo and PR alone.
                        Unset: those rows are unverified at best, naming the login as a non-driver
                        account. The driver's own login never counts.
  FACTORY_E2E_REVIEWER_LOGINS  comma list of reviewer logins (default ${DEFAULTS.reviewerLogins.join(", ")}); only
                        their COMMENTED review of the PR head whose body opens with "## Security review"
                        then "**Verdict:** CLEAN" or "FINDINGS" passes. A person, the driver, a dismissed
                        review, or an issue comment never passes
  FACTORY_E2E_AGENT_LOGINS  comma list; logins allowed to author the agent's comment
                        (default: cursor[bot], the GitHub reader, and this run's PR authors)`;

// ---------------------------------------------------------------- CLI

function csv(raw) {
  return String(raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function seconds(raw, name, fallback) {
  if (raw === undefined) return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return { ok: false, error: `--${name} must be a number of seconds` };
  return { ok: true, value };
}

/** Parsed options, or `{ error }` for a usage error. */
export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        ticket: { type: "string" },
        "new-ticket": { type: "boolean", default: false },
        reset: { type: "boolean", default: false },
        replay: { type: "boolean", default: false },
        live: { type: "boolean", default: false },
        only: { type: "string" },
        skip: { type: "string" },
        cleanup: { type: "boolean", default: false },
        "cleanup-branches": { type: "boolean", default: false },
        "assume-blocked": { type: "string", multiple: true },
        timeout: { type: "string" },
        "github-timeout": { type: "string" },
        "agent-timeout": { type: "string" },
        github: { type: "string" },
        quiet: { type: "string" },
        poll: { type: "string" },
        help: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const v = parsed.values;
  if (v.help) return { help: true };
  if (v.replay && v.live) return { error: "--replay and --live are exclusive" };
  if (v.ticket !== undefined && !ISSUE_KEY.test(v.ticket)) return { error: `"${v.ticket}" is not a Jira key such as TLSSN-3` };
  if (v.ticket !== undefined && v["new-ticket"]) return { error: "--ticket and --new-ticket are exclusive" };
  if (v["cleanup-branches"] && !v.cleanup) return { error: "--cleanup-branches needs --cleanup" };
  const assume = new Set((v["assume-blocked"] ?? []).flatMap(csv).map((part) => part.toLowerCase()));
  for (const name of assume) {
    if (name !== "atlassian" && name !== "github") return { error: `--assume-blocked takes atlassian or github, not "${name}"` };
  }
  if (v.github !== undefined && !GITHUB_MODES.includes(v.github)) return { error: `--github takes ${GITHUB_MODES.join(" or ")}, not "${v.github}"` };
  const steps = selectSteps({ only: v.only, skip: v.skip, cleanup: v.cleanup });
  if (steps.error !== undefined) return { error: steps.error };
  const timeout = seconds(v.timeout, "timeout", DEFAULTS.timeoutSec);
  const githubTimeout = seconds(v["github-timeout"], "github-timeout", DEFAULTS.githubTimeoutSec);
  const agentTimeout = seconds(v["agent-timeout"], "agent-timeout", DEFAULTS.agentTimeoutSec);
  const quiet = seconds(v.quiet, "quiet", DEFAULTS.quietSec);
  const poll = seconds(v.poll, "poll", DEFAULTS.pollSec);
  for (const item of [timeout, githubTimeout, agentTimeout, quiet, poll]) if (!item.ok) return { error: item.error };
  return {
    mode: v.live ? "live" : "replay",
    githubFlag: v.github,
    ticket: v.ticket,
    newTicket: v["new-ticket"],
    reset: v.reset,
    steps: steps.steps,
    skipReasons: steps.reasons,
    cleanup: v.cleanup,
    cleanupBranches: v["cleanup-branches"],
    assume,
    timeouts: {
      jiraMs: timeout.value * 1000,
      githubMs: githubTimeout.value * 1000,
      agentMs: agentTimeout.value * 1000,
      quietMs: quiet.value * 1000,
      pollMs: poll.value * 1000,
    },
  };
}

/** The steps to run, and why each other step is skipped. `cleanup` runs only when asked for. */
export function selectSteps({ only, skip, cleanup }) {
  const onlyList = csv(only);
  const skipList = csv(skip);
  for (const name of [...onlyList, ...skipList]) {
    if (!STEPS.includes(name)) return { error: `unknown step "${name}"; steps are ${STEPS.join(", ")}` };
  }
  const steps = new Set();
  const reasons = {};
  for (const name of STEPS) {
    if (onlyList.length > 0 && !onlyList.includes(name)) reasons[name] = "not in --only";
    else if (skipList.includes(name)) reasons[name] = "--skip";
    else if (name === "cleanup" && !cleanup && !onlyList.includes("cleanup")) reasons[name] = "pass --cleanup";
    else steps.add(name);
  }
  return { steps, reasons };
}

// ---------------------------------------------------------------- config

/** `| \`slug\` | \`https://...\` |` rows of docs/jira-webhooks.md. */
export function routesFromDoc(markdown) {
  const out = {};
  for (const line of String(markdown).split(/\r?\n/)) {
    const match = /^\|\s*`([a-z0-9-]+)`\s*\|\s*`(https?:\/\/[^`\s]+)`/.exec(line);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

/** Each route's URL and where it came from. An env override set to empty or `unknown` marks the route unknown. */
export function resolveRoutes(env, docText) {
  const fromDoc = routesFromDoc(docText ?? "");
  const out = {};
  for (const [role, { slug, env: name }] of Object.entries(ROUTES)) {
    const raw = env[name];
    if (raw !== undefined) {
      const value = String(raw).trim();
      out[role] = value === "" || value.toLowerCase() === "unknown" ? { slug, url: undefined, source: name } : { slug, url: value, source: name };
    } else if (fromDoc[slug] !== undefined) {
      out[role] = { slug, url: fromDoc[slug], source: "docs/jira-webhooks.md" };
    } else {
      out[role] = { slug, url: undefined, source: "none" };
    }
  }
  return out;
}

function envValue(env, name) {
  const value = env[name];
  return value === undefined ? "" : String(value).trim();
}

/** Resolved credentials. `value` fields are secrets; describeCredentials never prints them. */
export function resolveCredentials(env) {
  const tokenName = envValue(env, "JIRA_API_KEY") !== "" ? "JIRA_API_KEY" : envValue(env, "JIRA_API_TOKEN") !== "" ? "JIRA_API_TOKEN" : undefined;
  const emailSet = envValue(env, "JIRA_EMAIL") !== "";
  const cloudIdSet = envValue(env, "JIRA_CLOUD_ID") !== "";
  const siteSet = envValue(env, "JIRA_SITE") !== "";
  const jira =
    tokenName === undefined
      ? { ok: false, reason: "set JIRA_API_KEY in the factory root .env.local" }
      : {
          ok: true,
          tokenName,
          token: envValue(env, tokenName),
          email: emailSet ? envValue(env, "JIRA_EMAIL") : DEFAULTS.email,
          emailSource: emailSet ? "JIRA_EMAIL" : "default",
          cloudId: cloudIdSet ? envValue(env, "JIRA_CLOUD_ID") : undefined,
          cloudIdSource: cloudIdSet ? "JIRA_CLOUD_ID" : "tenant_info",
          site: siteSet ? envValue(env, "JIRA_SITE") : DEFAULTS.site,
        };
  const secret =
    envValue(env, "JIRA_WEBHOOK_SECRET") === ""
      ? { ok: false, reason: "set JIRA_WEBHOOK_SECRET in the factory root .env.local" }
      : { ok: true, name: "JIRA_WEBHOOK_SECRET", value: envValue(env, "JIRA_WEBHOOK_SECRET") };
  const github =
    envValue(env, "FACTORY_E2E_GITHUB_TOKEN") === ""
      ? { ok: false, reason: "set FACTORY_E2E_GITHUB_TOKEN" }
      : { ok: true, name: "FACTORY_E2E_GITHUB_TOKEN", token: envValue(env, "FACTORY_E2E_GITHUB_TOKEN") };
  return {
    jira,
    secret,
    github,
    fixerLogins: csv(env.FACTORY_E2E_FIXER_LOGINS),
    reviewerLogins: csv(env.FACTORY_E2E_REVIEWER_LOGINS),
    agentLogins: csv(env.FACTORY_E2E_AGENT_LOGINS),
    agentJiraAccounts: csv(env.FACTORY_E2E_AGENT_JIRA_ACCOUNTS),
  };
}

/** `--github` wins; without it, a write token means token mode and its absence means cloud-agent mode. */
export function githubMode({ flag, env }) {
  if (GITHUB_MODES.includes(flag)) return flag;
  return envValue(env, "FACTORY_E2E_GITHUB_TOKEN") === "" ? "cloud-agent" : "token";
}

/**
 * The Cursor key cloud agents launch with: FACTORY_E2E_CURSOR_API_KEY, else
 * the stored `agent-sdk login` key. `stored` is what `resolveApiKey()` gave
 * with every env key source removed; any source but `login` is refused so a
 * service-account or bind-file key never opens the PRs.
 */
export function pickCursorKey({ env, stored }) {
  const explicit = envValue(env, "FACTORY_E2E_CURSOR_API_KEY");
  if (explicit !== "") return { ok: true, name: "FACTORY_E2E_CURSOR_API_KEY", apiKey: explicit };
  if (stored === undefined) return { ok: false, reason: "no Cursor user key: set FACTORY_E2E_CURSOR_API_KEY or run `agent-sdk login`" };
  if (stored.source !== "login") return { ok: false, reason: `refusing the ${stored.source} Cursor key; only FACTORY_E2E_CURSOR_API_KEY or the stored agent-sdk login` };
  return { ok: true, name: "agent-sdk login", apiKey: stored.apiKey };
}

export function describeCredentials(creds, routes) {
  const lines = [];
  lines.push(
    creds.jira.ok
      ? `jira: ${creds.jira.tokenName} as ${creds.jira.emailSource === "JIRA_EMAIL" ? "JIRA_EMAIL" : `${DEFAULTS.email} (JIRA_EMAIL unset)`}, cloud id from ${creds.jira.cloudIdSource}`
      : `jira: missing (${creds.jira.reason})`
  );
  lines.push(creds.secret.ok ? `webhook signing: ${creds.secret.name}` : `webhook signing: missing (${creds.secret.reason})`);
  lines.push(creds.github.ok ? `github: ${creds.github.name}${creds.github.readOnly ? " (read only)" : ""}` : `github: missing (${creds.github.reason})`);
  if (creds.cursor !== undefined) lines.push(creds.cursor.ok ? `cloud agents: Cursor key from ${creds.cursor.name}` : `cloud agents: missing (${creds.cursor.reason})`);
  if (routes !== undefined) {
    lines.push(
      `routes: ${Object.values(routes)
        .map((route) => `${route.slug} from ${route.url === undefined ? `${route.source} (unknown)` : route.source}`)
        .join(", ")}`
    );
  }
  return lines;
}

// ---------------------------------------------------------------- Jira facts

const BLOCK_NODES = new Set(["doc", "bulletList", "orderedList", "listItem", "blockquote", "panel", "table", "tableRow", "tableCell", "tableHeader", "expand", "layoutSection", "layoutColumn"]);

const CARD_NODES = new Set(["inlineCard", "blockCard", "embedCard"]);

/**
 * Atlassian Document Format to text: blocks on their own lines, hard breaks
 * as newlines, smart links (inline, block, or embed cards) as their URL. The
 * connector turns a bare URL into an `inlineCard`, so `Implementing: <url>`
 * arrives with the URL in `attrs`. Link-marked text stays its own text: Jira
 * link-marks issue keys, and `Plan: <key>` must still read as written.
 */
export function adfText(node) {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfText).join("");
  if (node === null || typeof node !== "object") return "";
  if (node.type === "text") return typeof node.text === "string" ? node.text : "";
  if (node.type === "hardBreak") return "\n";
  if (CARD_NODES.has(node.type)) {
    const url = node.attrs?.url ?? node.attrs?.data?.url;
    return typeof url === "string" ? url : "";
  }
  const children = Array.isArray(node.content) ? node.content : [];
  if (BLOCK_NODES.has(node.type)) return children.map(adfText).filter((part) => part !== "").join("\n");
  return children.map(adfText).join("");
}

function byTime(a, b) {
  return Date.parse(a.created) - Date.parse(b.created) || Number(a.id) - Number(b.id);
}

/** A Jira `GET /issue/{key}?expand=changelog` response, flattened. */
export function issueFacts(raw, site = DEFAULTS.site) {
  const fields = raw?.fields ?? {};
  const key = String(raw?.key ?? "");
  const browse = `https://${site}/browse/${key}`;
  const comments = (fields.comment?.comments ?? [])
    .map((comment) => ({
      id: String(comment.id ?? ""),
      text: adfText(comment.body).trim(),
      created: String(comment.created ?? ""),
      author: String(comment.author?.displayName ?? ""),
      authorId: String(comment.author?.accountId ?? ""),
      url: `${browse}?focusedCommentId=${comment.id}`,
    }))
    .sort(byTime);
  const transitions = [];
  for (const history of raw?.changelog?.histories ?? []) {
    for (const item of history.items ?? []) {
      if (item.field !== "status") continue;
      transitions.push({
        id: String(history.id),
        created: String(history.created ?? ""),
        from: String(item.fromString ?? ""),
        to: String(item.toString ?? ""),
        author: String(history.author?.displayName ?? ""),
        authorId: String(history.author?.accountId ?? ""),
      });
    }
  }
  transitions.sort(byTime);
  return {
    key,
    id: String(raw?.id ?? ""),
    created: String(fields.created ?? ""),
    status: String(fields.status?.name ?? ""),
    summary: String(fields.summary ?? ""),
    description: adfText(fields.description).trim(),
    url: browse,
    comments,
    transitions,
  };
}

function norm(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function statusRank(name) {
  return STATUSES.findIndex((status) => norm(status) === norm(name));
}

export function firstLine(text) {
  const trimmed = String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  const end = trimmed.indexOf("\n");
  return (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
}

export function isTriageComment(text) {
  const first = firstLine(text);
  return first.startsWith("Triage:") && !/duplicate inbound/i.test(first);
}

export function isPlanComment(text, key) {
  const first = firstLine(text);
  return first === `Plan: ${key}` || first.startsWith(`Plan: ${key} `);
}

/** A `Brief:` heading on its own line, allowing Markdown or ADF decoration around it. */
export function hasBrief(text) {
  return String(text)
    .split(/\r?\n/)
    .some((line) => /^[#*_\s]*Brief:[*_\s]*$/.test(line));
}

/** The URL after `Implementing:`, on the same line or, when the connector renders it as a block card, the next. */
export function implementingUrl(text) {
  return /^Implementing:\s*(https?:\/\/\S+)/.exec(String(text).replace(/^\uFEFF/, "").trim())?.[1];
}

export function isNoPlanRefusal(text) {
  return /^Approved without a plan/i.test(firstLine(text));
}

export function isAgentComment(text, key) {
  return isTriageComment(text) || isPlanComment(text, key) || implementingUrl(text) !== undefined || isNoPlanRefusal(text);
}

/** Why the planner skips this triage verdict, mirroring planner/agent/lib/jira-event.ts. */
export function triageGate(text) {
  const first = firstLine(text);
  const head = first.slice("Triage:".length).trim().split(/[.,\s]/, 1)[0]?.toLowerCase() ?? "";
  if (head === "duplicate" || /duplicate of:/i.test(text)) return "duplicate";
  if (/^Needs info:/im.test(text)) return "needs_info";
  if (head === "question") return "question";
  return undefined;
}

/** Sentinel comments since `sinceIso` by an account that counts for the agent. */
export function agentCommentsSince(issue, sinceIso, identity) {
  const since = Date.parse(sinceIso);
  return issue.comments.filter((comment) => isAgentComment(comment.text, issue.key) && Date.parse(comment.created) >= since && countsForAgent(attribute(comment, identity)));
}

function latest(list, predicate) {
  for (let i = list.length - 1; i >= 0; i--) if (predicate(list[i])) return list[i];
  return undefined;
}

export function latestTransitionInto(issue, status) {
  return latest(issue.transitions, (t) => norm(t.to) === norm(status));
}

// ---------------------------------------------------------------- attribution

/**
 * Who wrote a comment or a status move, by Jira accountId. Both the driver's
 * REST token and the Factory Atlassian consent show as the same display
 * name, so only the id tells them apart. `identity.driverId` is the driver's
 * own account (GET /myself); without it nothing is attributed, not even a
 * pinned id, because a pin that names the driver's own account would then
 * pass the driver's writes. `identity.agentIds` (FACTORY_E2E_AGENT_JIRA_ACCOUNTS)
 * pins the agent: a match is `agent`, any other account `other`. Unpinned,
 * every account but the driver's is `non-driver`, which also counts for a
 * hop but is worded as such.
 */
export function attribute(item, identity) {
  const id = String(item?.authorId ?? "");
  const agentIds = identity?.agentIds ?? [];
  if (id === "" || identity?.driverId === undefined) return "unknown";
  if (id === identity.driverId) return "driver";
  if (agentIds.length === 0) return "non-driver";
  return agentIds.includes(id) ? "agent" : "other";
}

/** `agent` (pinned) or `non-driver` (unpinned): the author may be the agent. */
export function countsForAgent(by) {
  return by === "agent" || by === "non-driver";
}

function actor(item, identity) {
  return attribute(item, identity) === "agent" ? "the agent account" : `a non-driver account (${item.authorId})`;
}

function utc(iso) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? String(iso ?? "") : new Date(ms).toISOString();
}

function excerpt(text, max = 80) {
  const flat = String(text).replace(/\s*\n\s*/g, " / ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function commentEvidence(comment, identity) {
  return { kind: "comment", id: comment.id, by: attribute(comment, identity), author: comment.author, authorId: comment.authorId, at: utc(comment.created), excerpt: excerpt(comment.text) };
}

export function transitionEvidence(transition, identity) {
  return { kind: "transition", id: transition.id, from: transition.from, to: transition.to, by: attribute(transition, identity), author: transition.author, authorId: transition.authorId, at: utc(transition.created) };
}

export function issueEvidence(issue) {
  return { kind: "issue", key: issue.key, id: issue.id, at: utc(issue.created), summary: issue.summary };
}

export function prEvidence({ number, author, head, sha }) {
  return { kind: "pr", number, author: String(author ?? ""), head, ...(sha === undefined ? {} : { sha }) };
}

const byLabel = (by) => (by === undefined ? {} : { by });

export function reviewEvidence(item, by) {
  return { kind: "review", id: item.id === undefined ? "" : String(item.id), author: String(item.user?.login ?? ""), commitId: String(item.commit_id ?? ""), at: utc(item.submitted_at ?? item.created_at), ...byLabel(by) };
}

export function ciEvidence(sha, run) {
  return { kind: "ci", sha, runId: run.id === undefined ? "" : String(run.id), conclusion: String(run.conclusion ?? run.status ?? ""), ...(run.html_url === undefined ? {} : { url: run.html_url }) };
}

/**
 * A pushed commit. `author` is the git author email's GitHub account, which
 * anyone with push access can set, so it is printed but never scored.
 * `pusher` and `pushRun` come from `pusherOf`; `at` is the push time when
 * one is known, else the commit's own committer date.
 */
export function commitEvidence(commit, push, by) {
  return {
    kind: "commit",
    sha: String(commit.sha ?? ""),
    author: String(commit.author?.login ?? commit.commit?.author?.name ?? ""),
    pusher: String(push?.login ?? ""),
    pushRun: String(push?.runId ?? ""),
    at: utc(push?.at ?? commit.commit?.committer?.date),
    ...byLabel(by),
  };
}

/**
 * Every item of a paged GitHub list. `get(page)` reads one page of
 * `perPage` items and a short page is the last. `cap` is a hard limit of
 * the endpoint (the pull request commits list stops at 250): reaching it
 * throws, because the newest items, the tip among them, may be cut off.
 */
export async function readPages(get, { perPage = 100, cap = Infinity, maxPages = 30 } = {}) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await get(page);
    items.push(...batch);
    if (items.length >= cap) throw new Error(`the list reached GitHub's cap of ${cap} items, so its newest items cannot be read`);
    if (batch.length < perPage) return items;
  }
  throw new Error(`the list has more than ${maxPages * perPage} items`);
}

const PUSH_EVENTS = new Set(["push", "pull_request"]);
/** How long after a `reopened` event a `pull_request` run by the reopener is taken as started by the reopen. */
const REOPEN_RUN_MS = 10 * 60_000;
/** Clock skew allowed between a run's `created_at` and the (re)open event it follows. */
const REOPEN_SKEW_MS = 5_000;

/** GitHub logins are case-insensitive. */
function sameLogin(a, b) {
  return norm(a) !== "" && norm(a) === norm(b);
}

/**
 * True when a workflow run belongs to PR `number` on `repo`, from its
 * branch `head`, for commit `sha`. `GET /actions/runs?head_sha=` is
 * repository-wide, so a run of the same commit on another branch, fork or
 * PR comes back too. Every PR the run lists must be `number` on `repo`: a
 * run that also lists another PR is ambiguous and never counts.
 */
export function runOnPr(run, { number, repo, head, sha }) {
  const listed = Array.isArray(run?.pull_requests) ? run.pull_requests : [];
  const apiRepo = `https://api.github.com/repos/${repo}`;
  return (
    filled(sha) &&
    run.head_sha === sha &&
    filled(head) &&
    run.head_branch === head &&
    norm(run.head_repository?.full_name) === norm(repo) &&
    listed.length > 0 &&
    listed.every((pr) => pr?.number === number && norm(pr.base?.repo?.url) === norm(apiRepo))
  );
}

/** Keeps, per commit sha, only the runs `runOnPr` binds to this PR and branch. */
export function bindRuns(runsBySha, pr) {
  return Object.fromEntries(Object.entries(runsBySha).map(([sha, runs]) => [sha, (runs ?? []).filter((run) => runOnPr(run, { ...pr, sha }))]));
}

/**
 * Each (re)open event with `sha` set to the commit its own run is on: the
 * earliest `pull_request` run by the event's actor from `REOPEN_SKEW_MS`
 * before to `REOPEN_RUN_MS` after it, across every commit read. With no
 * such run, or a time that does not parse, `sha` stays undefined.
 */
export function pinRestarts(reopens = [], runsBySha = {}) {
  return reopens.map((reopen) => {
    const opened = Date.parse(reopen.created_at);
    const candidates = Object.entries(runsBySha)
      .flatMap(([sha, runs]) => (runs ?? []).map((run) => ({ sha, after: Date.parse(run.created_at) - opened, run })))
      .filter(({ run, after }) => run.event === "pull_request" && sameLogin(reopen.actor?.login, run.actor?.login) && !Number.isNaN(after) && after >= -REOPEN_SKEW_MS && after <= REOPEN_RUN_MS)
      .sort((a, b) => a.after - b.after);
    return { ...reopen, sha: candidates[0]?.sha };
  });
}

/**
 * Who pushed a commit, from the workflow runs GitHub started for it: the
 * `actor` of a `push` or `pull_request` run is the account whose push (or
 * pull request update) started it, and its `created_at` is when (a re-run
 * keeps both). Undefined when no such run names an actor, or the runs name
 * more than one. A run for another commit (`head_sha` other than `sha`)
 * never counts. Nor does a `pull_request` run started by one of `reopens`
 * (the PR's `reopened` events, and its opening as `openedEvent` gives it):
 * it names who opened or reopened the PR, not who pushed, and a commit
 * pushed while no PR was open may have no other run. An event `pinRestarts`
 * pinned to a commit drops its actor's `pull_request` runs on that commit
 * from `REOPEN_SKEW_MS` before it on, and none on another commit. An
 * unpinned event drops its actor's `pull_request` runs from
 * `REOPEN_SKEW_MS` before it to `REOPEN_RUN_MS` after it. When either time
 * does not parse, every `pull_request` run by that login is taken as
 * started by the event, so the gap is never read as a push.
 */
export function pusherOf(runs = [], { sha, reopens = [] } = {}) {
  const fromReopen = (run) =>
    run.event === "pull_request" &&
    reopens.some((reopen) => {
      if (!sameLogin(reopen.actor?.login, run.actor.login)) return false;
      const after = Date.parse(run.created_at) - Date.parse(reopen.created_at);
      if (Number.isNaN(after)) return true;
      if (reopen.sha !== undefined && sha !== undefined) return reopen.sha === sha && after >= -REOPEN_SKEW_MS;
      return after >= -REOPEN_SKEW_MS && after <= REOPEN_RUN_MS;
    });
  const pushed = runs
    .filter((run) => PUSH_EVENTS.has(run.event) && filled(run.actor?.login))
    .filter((run) => sha === undefined || run.head_sha === undefined || run.head_sha === sha)
    .filter((run) => !fromReopen(run))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (new Set(pushed.map((run) => norm(run.actor.login))).size !== 1) return undefined;
  const run = pushed[0];
  return { login: run.actor.login, runId: run.id === undefined ? "" : String(run.id), event: run.event, at: run.created_at };
}

/** The PR's opening as a `pusherOf` event: the `opened` run names who opened the PR, not who pushed. */
export function openedEvent(pull) {
  return { event: "opened", actor: { login: pull?.user?.login }, created_at: pull?.created_at };
}

export function githubCommentEvidence(comment, by) {
  return { kind: "gh-comment", id: comment.id === undefined ? "" : String(comment.id), author: String(comment.user?.login ?? ""), at: utc(comment.created_at), ...byLabel(by) };
}

/**
 * Who wrote a GitHub item that must be the fixer's or the reviewer's:
 * `driver` (the driver's own login, even if listed), `pinned` (in the
 * list), `other` (a list is set and the login is not in it), `non-driver`
 * (no list, so the driver cannot say whose it is), or `unknown` (no login).
 */
export function githubActor(login, { driverLogin, allowed = [] } = {}) {
  if (login === undefined || login === null || login === "") return "unknown";
  if (driverLogin !== undefined && sameLogin(login, driverLogin)) return "driver";
  if (allowed.length === 0) return "non-driver";
  return allowed.some((pin) => sameLogin(pin, login)) ? "pinned" : "other";
}

/** How a row names a GitHub actor that did not count, in the words the Jira rows use. */
function githubActorText(actor, login, pinName, nobody = "an author with no login") {
  switch (actor) {
    case "driver":
      return `the driver's own login (${login})`;
    case "non-driver":
      return `a non-driver account (${login}); set ${pinName} to pin it`;
    case "other":
      return `${login}, not one of ${pinName}`;
    default:
      return nobody;
  }
}

const NO_PUSHER = "an unknown pusher (no push or pull_request workflow run names exactly one actor)";

/** Actors that are positively not the agent: at the timeout they make a row `fail`, not `unverified`. */
const WRONG_ACTOR = new Set(["driver", "other", "person"]);

function refusedResult(step, text, extra, whos) {
  return whos.every((who) => WRONG_ACTOR.has(who))
    ? result(step, "fail", `${text} (wrong actor)`, { ...extra, kind: "wrong-actor" })
    : result(step, "unverified", text, extra);
}

/** A GitHub pass, or `pass (prior run)` when what decided it predates the run: then the run wrote nothing for it. */
function githubPass(step, reason, extra, reread) {
  return reread ? result(step, PRIOR_PASS, `${reason} (already done before this run, nothing written)`, extra) : result(step, "pass", reason, extra);
}

export function postEvidence({ slug, status, at, error }) {
  return { kind: "post", slug, status, at: utc(at), ...(error === undefined ? {} : { error }) };
}

/** The changelog a replay carried: a real one from the ticket, or a synthesized id. */
export function replayEvidence(input, issue, identity) {
  const real = input.synthesized ? undefined : issue.transitions.find((t) => t.id === input.changelogId);
  return { kind: "replay", changelogId: input.changelogId, from: input.fromStatus, to: input.toStatus, synthesized: input.synthesized, ...(real === undefined ? {} : { by: attribute(real, identity), authorId: real.authorId }) };
}

const tag = (item) => (item.by === undefined ? "" : ` [${item.by}]`);

export function formatEvidence(item) {
  const who = (e) => `${e.author || "?"} [${e.by}${e.authorId ? ` ${e.authorId}` : ""}]`;
  switch (item.kind) {
    case "comment":
      return `comment ${item.id} by ${who(item)} at ${item.at}: "${item.excerpt}"`;
    case "transition":
      return `changelog ${item.id} ${item.from} -> ${item.to} by ${who(item)} at ${item.at}`;
    case "post":
      return `POST ${item.slug} HTTP ${item.status}${item.error ? ` (${item.error})` : ""} at ${item.at}`;
    case "replay":
      return item.synthesized
        ? `replayed synthesized changelog ${item.changelogId} ${item.from} -> ${item.to} (no real move on the ticket)`
        : `replayed real changelog ${item.changelogId} ${item.from} -> ${item.to}${item.by ? ` (moved by [${item.by} ${item.authorId}])` : ""}`;
    case "issue":
      return `issue ${item.key} id ${item.id} created ${item.at}, summary "${item.summary}"`;
    case "pr":
      return `PR #${item.number} by ${item.author || "?"}, head ${item.head}${item.sha ? ` at ${item.sha.slice(0, 7)}` : ""}`;
    case "review":
      return `review ${item.id || "?"} by ${item.author || "?"} on commit ${item.commitId ? item.commitId.slice(0, 7) : "?"} at ${item.at}${tag(item)}`;
    case "ci":
      return `CI run ${item.runId || "?"} ${item.conclusion} on ${item.sha.slice(0, 7)}`;
    case "commit":
      return item.pusher
        ? `commit ${item.sha.slice(0, 7)} authored as ${item.author || "?"}, pushed by ${item.pusher} (actor of workflow run ${item.pushRun || "?"}) at ${item.at}${tag(item)}`
        : `commit ${item.sha.slice(0, 7)} authored as ${item.author || "?"}, pusher unknown, committed at ${item.at}${tag(item)}`;
    case "gh-comment":
      return `GitHub comment ${item.id || "?"} by ${item.author || "?"} at ${item.at}${tag(item)}`;
    default:
      return JSON.stringify(item);
  }
}

// ---------------------------------------------------------------- results

export function result(step, status, reason, extra = {}) {
  return {
    step,
    status,
    reason,
    links: extra.links ?? [],
    evidence: extra.evidence ?? [],
    ...(extra.kind === undefined ? {} : { kind: extra.kind }),
    ...(extra.reread === true ? { reread: true } : {}),
  };
}

/** A step that finished before this run started: re-read from Jira or GitHub, nothing sent or written. Counted apart from this run's passes. */
export const PRIOR_PASS = "pass (prior run)";

export function isPass(status) {
  return status === "pass" || status === PRIOR_PASS;
}

function hasEvidence(entry, kind, byAgent) {
  return (entry.evidence ?? []).some((item) => item.kind === kind && (!byAgent || countsForAgent(item.by)));
}

const filled = (value) => value !== undefined && value !== null && String(value) !== "";

/** What a GitHub pass row must print, each as [what is missing, test]. */
const GITHUB_EVIDENCE = {
  prs: [["a PR line with its number and author", (e) => e.kind === "pr" && filled(e.number) && filled(e.author)]],
  review: [["a review line with its id, author, and commit, by an allowed reviewer", (e) => e.kind === "review" && filled(e.id) && filled(e.author) && filled(e.commitId) && e.by === "reviewer"]],
  "red-check": [
    ["a failed CI run line with its run id", (e) => e.kind === "ci" && filled(e.runId) && RED.has(e.conclusion)],
    ["a commit line pushed by a pinned fixer login, with the workflow run that names the pusher", (e) => pushedByFixer(e)],
    ["a successful CI run line with its run id", (e) => e.kind === "ci" && filled(e.runId) && e.conclusion === "success"],
  ],
  drive: [["a fixer comment id with its author, or a commit pushed by the fixer with the workflow run that names the pusher", (e) => pushedByFixer(e) || (e.kind === "gh-comment" && filled(e.id) && filled(e.author) && e.by === "fixer")]],
};

function pushedByFixer(e) {
  return e.kind === "commit" && filled(e.sha) && filled(e.pusher) && filled(e.pushRun) && e.by === "fixer";
}

/**
 * A pass row must be reproducible from what it prints: the ticket row needs
 * its issue line, every Jira hop row a comment line and a changelog line,
 * both by an account that counts for the agent, and every GitHub row the
 * GitHub ids and authors in GITHUB_EVIDENCE. Anything less is `unverified`.
 */
export function requireEvidence(results) {
  return results.map((entry) => {
    if (!isPass(entry.status)) return entry;
    if (entry.step === "ticket" && !hasEvidence(entry, "issue", false)) {
      return { ...entry, status: "unverified", reason: `${entry.reason} (no issue evidence, so not a pass)` };
    }
    if (JIRA_HOPS.includes(entry.step) && !(hasEvidence(entry, "comment", true) && hasEvidence(entry, "transition", true))) {
      return { ...entry, status: "unverified", reason: `${entry.reason} (evidence lacks a comment line and a changelog line by a non-driver account, so not a pass)` };
    }
    const missing = (GITHUB_EVIDENCE[entry.step] ?? []).filter(([, ok]) => !(entry.evidence ?? []).some(ok)).map(([what]) => what);
    if (missing.length > 0) {
      return { ...entry, status: "unverified", reason: `${entry.reason} (evidence lacks ${missing.join(" and ")}, so not a pass)` };
    }
    return entry;
  });
}

const WAIT = (note) => ({ wait: true, note });

// ---------------------------------------------------------------- Jira decisions

/** Which ticket to use. `create: false` is the read-only lookup when the ticket step is skipped. */
export function decideTicket({ ticketArg, openTickets, newTicket, create = true }) {
  if (ticketArg !== undefined) return { action: "reuse", key: ticketArg, source: "--ticket" };
  if (!newTicket && openTickets.length > 0) return { action: "reuse", key: openTickets[0].key, source: `open ${DEFAULTS.label} ticket` };
  if (!create) return { action: "missing" };
  return { action: "create" };
}

export function openTicketsJql(project = DEFAULTS.project, label = DEFAULTS.label) {
  return `project = ${project} AND labels = "${label}" AND statusCategory != Done ORDER BY created DESC`;
}

/**
 * One summary per run. Triage marks an exact title match as a duplicate and
 * the planner does not plan duplicates, so a fixed summary would stop every
 * ticket after the first. The worker names its cloud agent
 * `factory <KEY>: <summary>` and the API caps names at 100 characters, so
 * the stamp is short (MMDD-HHMMSS, UTC).
 */
export function ticketSummary(stamp) {
  const iso = new Date(Date.parse(stamp)).toISOString();
  const short = `${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  return `Factory e2e ${short}: CSV export 500 on empty filter`;
}

export function newTicketFields({ project = DEFAULTS.project, label = DEFAULTS.label, stamp }) {
  const text = `Exporting a report to CSV returns HTTP 500 when the filter matches no rows. Expected an empty CSV with the header row. Filed by scripts/e2e-drive.mjs at ${stamp}.`;
  return {
    project: { key: project },
    issuetype: { name: "Bug" },
    summary: ticketSummary(stamp),
    labels: [label],
    description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  };
}

/** The transition id that lands on `target`, by destination status first, then by transition name. */
export function pickTransition(transitions, target) {
  return (transitions.find((t) => norm(t.to?.name) === norm(target)) ?? transitions.find((t) => norm(t.name) === norm(target)))?.id;
}

/**
 * The ticket as the run found it, before any reset. Comments and status
 * moves already on it are not this run's work; `--reset` moves the status
 * but leaves every comment in place.
 */
export function captureBaseline(issue, at) {
  return {
    at,
    status: issue.status,
    commentIds: issue.comments.map((comment) => comment.id),
    latestCommentAt: issue.comments.at(-1)?.created,
    transitionIds: issue.transitions.map((transition) => transition.id),
  };
}

/** Comments and transitions written after the baseline. No baseline keeps everything. */
export function sinceBaseline(issue, baseline) {
  if (baseline === undefined) return issue;
  const floor = baseline.latestCommentAt === undefined ? -Infinity : Date.parse(baseline.latestCommentAt);
  return {
    ...issue,
    comments: issue.comments.filter((comment) => !baseline.commentIds.includes(comment.id) && Date.parse(comment.created) >= floor),
    transitions: issue.transitions.filter((transition) => !baseline.transitionIds.includes(transition.id)),
  };
}

export function decideReset({ reset, issue }) {
  return reset && norm(issue.status) !== norm("To Do") ? { action: "transition", to: "To Do" } : { action: "none" };
}

/**
 * The driver moves the ticket itself only when the stage that would have
 * moved it was not run, so a hop can be exercised on its own.
 */
export function decideAdvance({ issue, target, upstreamRan }) {
  if (upstreamRan || statusRank(issue.status) >= statusRank(target)) return { action: "none" };
  return { action: "transition", to: target };
}

export function decideApprove(issue) {
  const rank = statusRank(issue.status);
  if (rank === statusRank("Planned")) return { action: "transition", to: "Approved" };
  if (rank >= statusRank("Approved")) return { action: "none", reason: `already ${issue.status}` };
  return { action: "blocked", reason: `ticket is in ${issue.status || "an unknown status"}, not Planned; the plan hop has not finished` };
}

/**
 * The inputs for a replayed transition into `toStatus`. When the ticket
 * really made that move, reuse its changelog id and current status so the
 * replay is a redelivery the handler dedupes; otherwise synthesize one.
 */
export function replayTransition(issue, toStatus, { now, fallbackFrom }) {
  const real = latestTransitionInto(issue, toStatus);
  if (real !== undefined) {
    return { toStatus, fromStatus: real.from, changelogId: real.id, currentStatus: issue.status, synthesized: false };
  }
  return { toStatus, fromStatus: fallbackFrom, changelogId: String(now), currentStatus: toStatus, synthesized: true };
}

const HOPS = {
  triage: { target: "Triaged", sentinel: "Triage:", match: (c) => isTriageComment(c.text) },
  plan: { target: "Planned", sentinel: "Plan:", match: (c, key) => isPlanComment(c.text, key) },
  approve: { target: "In Progress", sentinel: "Implementing:", match: (c) => implementingUrl(c.text) !== undefined },
};

/**
 * The ticket as the baseline saw it: its status then, and only the comments
 * and status moves the baseline recorded that were written no later than
 * the baseline read. A recorded item stamped in the same millisecond as the
 * read existed before anything was sent, so it is the baseline's; anything
 * newer is this run's to score.
 */
export function atBaseline(issue, baseline) {
  const start = Date.parse(baseline.at);
  const before = (item) => Date.parse(item.created) <= start;
  return {
    ...issue,
    status: baseline.status,
    comments: issue.comments.filter((comment) => baseline.commentIds.includes(comment.id) && before(comment)),
    transitions: issue.transitions.filter((transition) => baseline.transitionIds.includes(transition.id) && before(transition)),
  };
}

/**
 * The hop's verdict when it finished before this run started and the ticket
 * is still past it, so there is nothing to send; else undefined. Scored on
 * the baseline snapshot, so a comment or move written during the run never
 * makes a hop "done before". Undefined after a reset moved the ticket back.
 */
export function priorRun(hop, issue, baseline, identity) {
  if (baseline === undefined) return undefined;
  if (statusRank(issue.status) < statusRank(HOPS[hop].target)) return undefined;
  const done = evaluateHop(hop, atBaseline(issue, baseline), { timedOut: false, identity });
  return done.status === "pass" ? done : undefined;
}

/**
 * Verdict for a Jira hop from the ticket as it is now, or a wait. A pass
 * needs the hop's comment and the status move into its own target (a later
 * hop's move does not stand in for it), both written by the agent's Jira
 * account; a move by the driver's own account (its
 * stand-in moves, a concurrent run, a person with the same token) never
 * counts. Authors that cannot be told apart make the hop `unverified`. With
 * a baseline, only a comment and a move written after it count; an older
 * one on the ticket is a `stale` fail, never a pass. A missing artifact is
 * `fail` unless a precondition is known unmet.
 */
export function evaluateHop(hop, issue, { timedOut, assumeAtlassian = false, timeoutSec = 0, baseline, identity }) {
  const def = HOPS[hop];
  const by = (item) => attribute(item, identity);
  const counts = (c) => def.match(c, issue.key) && by(c) !== "driver";
  const fresh = sinceBaseline(issue, baseline);
  const artifact = latest(fresh.comments, counts);
  const stale = artifact === undefined && baseline !== undefined ? latest(issue.comments, counts) : undefined;
  const into = fresh.transitions.filter((t) => statusRank(t.to) === statusRank(def.target));
  const agentMove = latest(into, (t) => countsForAgent(by(t)));
  const anyMove = latest(into, () => true);
  const statusReached = statusRank(issue.status) >= statusRank(def.target);
  const reached = statusReached && agentMove !== undefined;
  const links = [issue.url, ...(artifact === undefined ? [] : [artifact.url])];
  const evidence = [
    ...(artifact === undefined ? [] : [commentEvidence(artifact, identity)]),
    ...((agentMove ?? anyMove) === undefined ? [] : [transitionEvidence(agentMove ?? anyMove, identity)]),
  ];

  if (hop === "plan" && artifact === undefined) {
    const triage = latest(issue.comments, (c) => isTriageComment(c.text));
    const gate = triage === undefined ? undefined : triageGate(triage.text);
    if (gate !== undefined) return result(hop, "blocked", `triage verdict is ${gate}; the planner does not plan it by design`, { links: [issue.url, triage.url], evidence: [commentEvidence(triage, identity)] });
  }
  if (hop === "approve") {
    const approvedAt = latestTransitionInto(issue, "Approved")?.created;
    const refusal = latest(issue.comments, (c) => isNoPlanRefusal(c.text));
    const approvedNow = statusRank(issue.status) >= statusRank("Approved");
    if (approvedNow && refusal !== undefined && approvedAt !== undefined && Date.parse(refusal.created) >= Date.parse(approvedAt) && artifact === undefined) {
      return result(hop, "fail", "the worker refused: Approved without a plan (no Brief: on the Plan: comment)", { links: [issue.url, refusal.url], kind: "refused", evidence: [commentEvidence(refusal, identity)] });
    }
    if (timedOut && artifact !== undefined && !reached && norm(issue.status) === norm("Approved") && approvedAt !== undefined && Date.parse(artifact.created) < Date.parse(approvedAt)) {
      return result(hop, "blocked", `implement/${issue.key} was launched before this approval; a second approval re-posts nothing and does not move the ticket (by design)`, { links, evidence });
    }
  }

  const briefOk = artifact !== undefined && (hop !== "plan" || hasBrief(artifact.text));
  if (briefOk && countsForAgent(by(artifact)) && reached) {
    const who = artifact.authorId === agentMove.authorId ? `comment and move into ${agentMove.to} by ${actor(artifact, identity)}` : `comment by ${actor(artifact, identity)} and move into ${agentMove.to} by ${actor(agentMove, identity)}`;
    return result(hop, "pass", `${def.sentinel} ${who}; ticket in ${issue.status}`, { links, evidence });
  }
  const unattributable = [artifact, agentMove === undefined ? anyMove : undefined].filter((item) => item !== undefined && ["unknown", "other"].includes(by(item)));
  if (briefOk && statusReached && anyMove !== undefined && unattributable.length > 0) {
    const whose = unattributable.map((item) => `${item.text === undefined ? `changelog ${item.id}` : `comment ${item.id}`} is by ${by(item) === "other" ? `account ${item.authorId}, not one of FACTORY_E2E_AGENT_JIRA_ACCOUNTS` : "an account the driver cannot tell apart from its own"}`);
    return result(hop, "unverified", `${def.sentinel} comment and ticket in ${issue.status}, but ${whose.join("; ")}`, { links, evidence });
  }
  if (!timedOut && !assumeAtlassian) return WAIT(`ticket in ${issue.status || "?"}, ${artifact === undefined ? `no ${def.sentinel} comment yet` : `${def.sentinel} comment present`}`);
  if (assumeAtlassian) return result(hop, "blocked", "Atlassian connector assumed not authorised (--assume-blocked atlassian); not observed", { links, evidence });
  if (artifact !== undefined && hop === "plan" && !hasBrief(artifact.text)) {
    return result(hop, "fail", "Plan: comment has no Brief: section", { links, kind: "stuck", evidence });
  }
  if (artifact !== undefined && statusReached && anyMove !== undefined && by(anyMove) === "driver") {
    return result(hop, "fail", `${def.sentinel} comment landed, but the move into ${anyMove.to} (changelog ${anyMove.id}) was made by the driver's own Jira account, not the agent`, { links, kind: "stuck", evidence });
  }
  if (artifact !== undefined && statusReached && anyMove === undefined) {
    return result(hop, "fail", `${def.sentinel} comment landed but nothing moved the ticket into ${def.target} this run (it was ${baseline?.status ?? issue.status} before the run)`, { links, kind: "stuck", evidence });
  }
  if (artifact !== undefined) {
    return result(hop, "fail", `${def.sentinel} comment landed but the ticket stayed in ${issue.status}, expected ${def.target}`, { links, kind: "stuck", evidence });
  }
  if (stale !== undefined) {
    return result(
      hop,
      "fail",
      `no new ${def.sentinel} comment within ${timeoutSec}s (ticket in ${issue.status || "?"}); the ${def.sentinel} comment on the ticket is from before this run and does not count, and the agent may skip a ticket that already has one (--reset leaves comments in place)`,
      { links: [issue.url, stale.url], kind: "stale", evidence: [commentEvidence(stale, identity), ...evidence] }
    );
  }
  return result(hop, "fail", `no ${def.sentinel} comment within ${timeoutSec}s (ticket in ${issue.status || "?"})`, { links, kind: "missing", evidence });
}

/** Result of one replay POST. The control plane answers 202; anything else is a failure. */
export function postOutcome(hop, slug, response) {
  if (response.status === 202) return undefined;
  const detail = response.status === 0 ? `failed: ${response.error ?? "network error"}` : `answered HTTP ${response.status}`;
  return result(hop, "fail", `POST to ${slug} ${detail}`, { kind: "http" });
}

/** The desk steps and the status each replays to factory-desk. */
export const DESK_HOPS = {
  announce: { status: "Planned", fallbackFrom: "Triaged", post: "the plan post" },
  progress: { status: "In Progress", fallbackFrom: "Approved", post: "the implementation post" },
};

/**
 * A desk hop's verdict. The desk writes only to Slack, which the driver
 * cannot read, so the best it can be is `unverified` with the route's
 * answer and the replayed changelog as evidence.
 */
export function deskOutcome({ step, mode, issue, response, slug, evidence = [] }) {
  const { status, post } = DESK_HOPS[step];
  if (mode === "live") {
    return result(step, "unverified", `live: relies on the Jira webhook to ${slug}; ${post} is unverified without Slack access`, { links: [issue.url], evidence });
  }
  const failed = postOutcome(step, slug, response);
  if (failed !== undefined) return { ...failed, links: [issue.url], evidence };
  return result(step, "unverified", `${slug} accepted the ${status} transition (HTTP ${response.status}); ${post} to Slack is unverified without Slack access`, { links: [issue.url], evidence });
}

/**
 * What the run observed about the Atlassian connector. The driver cannot read
 * the connector's state, so the only positive signal is a sentinel comment
 * the agent account wrote during this run; anything else is `unknown`, never
 * "not authorised".
 */
export function connectorSignal(agentComments, identity) {
  const first = agentComments[0];
  if (first === undefined) return { state: "unknown", note: "Atlassian connector: unknown (not observable from the driver; no agent-account comment this run)" };
  return { state: "authorised", note: `Atlassian connector: authorised (${actor(first, identity)} wrote comment ${first.id} this run)` };
}

/** Appends the connector signal to Jira hops that failed for a missing or stuck artifact. Verdicts are unchanged. */
export function annotateConnector({ results, signal }) {
  return results.map((entry) =>
    JIRA_HOPS.includes(entry.step) && entry.status === "fail" && ["missing", "stuck", "stale"].includes(entry.kind) ? { ...entry, reason: `${entry.reason}; ${signal.note}` } : entry
  );
}

// ---------------------------------------------------------------- GitHub decisions

/**
 * Reuse the one open PR with this head into `base`, retitle it when its
 * title is not `title` (or lacks `titlePrefix`, when one is set), else
 * create one. Two or more open PRs on the head are `duplicate`; one into
 * another base is `wrong-base`. Neither is reused.
 */
export function decidePr({ pulls, repo, head, base, title, titlePrefix, create = true }) {
  const open = pulls.filter((pull) => pull.state === "open" && pull.head?.ref === head && norm(pull.head?.repo?.full_name) === norm(repo));
  if (open.length > 1) return { action: "duplicate", numbers: open.map((pull) => pull.number) };
  const match = open[0];
  if (match !== undefined) {
    if (base !== undefined && match.base?.ref !== base) return { action: "wrong-base", number: match.number, url: match.html_url, base: match.base?.ref };
    const author = match.user?.login === undefined ? {} : { author: match.user.login };
    if (titlePrefix !== undefined ? !String(match.title).startsWith(titlePrefix) : title !== undefined && match.title !== title) {
      return { action: create ? "retitle" : "reuse", number: match.number, url: match.html_url, title: create ? title : match.title, ...author };
    }
    return { action: "reuse", number: match.number, url: match.html_url, title: match.title, ...author };
  }
  if (!create) return { action: "missing" };
  return { action: "create", head, title };
}

const RED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
const IGNORED = new Set(["cancelled", "skipped", "stale"]);
/** `ciState` values that cannot change on their own; `pending` and `none` can. */
const CI_SETTLED = new Set(["red", "green"]);

/**
 * Actions workflow runs for one commit: none, pending, red, or green.
 * Superseded runs do not count. One failed run is red even while a sibling
 * is still running, because the fixer wakes on that failed check; green
 * means every run completed and none failed.
 */
export function ciState(runs) {
  const counted = runs.filter((run) => !(run.status === "completed" && IGNORED.has(run.conclusion)));
  if (counted.length === 0) return "none";
  if (counted.some((run) => run.status === "completed" && RED.has(run.conclusion))) return "red";
  if (counted.some((run) => run.status !== "completed")) return "pending";
  return "green";
}

/** Two different shas, each cut to 7 characters or to the first character where they differ. */
function distinctShas(a, b) {
  let n = 7;
  while (n < Math.max(a.length, b.length) && a.slice(0, n) === b.slice(0, n)) n += 1;
  return [a.slice(0, n), b.slice(0, n)];
}

function commitLink(commit) {
  return commit.html_url ?? commit.sha;
}

/**
 * Why a verdict on `headSha` cannot stand when `recheck`, the pull request
 * read again after the evidence, is not open or has another head: the
 * evidence came from a snapshot the PR has left. Undefined when it holds or
 * no recheck was read.
 */
export function headMoved(headSha, recheck) {
  if (recheck === undefined) return undefined;
  if (recheck.state !== "open") return `the PR is ${recheck.state ?? "in no state"} on the second read`;
  const now = recheck.head?.sha;
  if (now === headSha) return undefined;
  if (!filled(now)) return `the PR shows no head commit on the second read, after ${headSha.slice(0, 7)} on the first`;
  const [was, is] = distinctShas(headSha, now);
  return `the PR head moved from ${was} to ${is} while the driver read it`;
}

/** True when a GitHub timestamp is before the run started, so the row only re-read it. */
function beforeRun(iso, since) {
  return since !== undefined && Date.parse(iso) < Date.parse(since);
}

/**
 * Red check fixed: some commit went red, the fixer pushed after it, and the
 * head is green. `runs` (sha to workflow runs) supplies the run ids and
 * conclusions a pass prints, and the pusher of each commit (`pusherOf`).
 * The green tip must have been pushed by a login in `fixerLogins` other
 * than the driver's. The driver's login or another pinned-out login is a
 * `fail` (wrong actor); no pin, or no workflow run that names the pusher,
 * is `unverified`. The commit's author login is never read as the pusher.
 * A green tip pushed before `since` (the run start) is `pass (prior run)`.
 * `commits` is the newest end of the PR's list; `older` counts the commits
 * before it that were not read, so a red commit among them is unknown.
 * `headSha` is the PR head from the pull request itself; the list is cut
 * there, since its order is not the push order. With no `headSha` the row
 * waits, then is `unverified`, as `review` is: the list order never stands
 * in for the head. `recheck` is the pull request read again after the
 * commits and runs: when it is not open or its head is not `headSha`, the
 * row waits, then is `unverified` (`headMoved`). `reopens` (the PR's
 * `reopened` events and its opening) are pinned over `runs`
 * (`pinRestarts`) and go to `pusherOf`.
 * With no red commit yet, any commit whose CI is `pending` or `none` could
 * still go red, so the row waits; only at the timeout, or once every commit
 * is red or green, is "no red commit" a verdict.
 */
export function evaluateRedCheck({ commits: listed, headSha, recheck, reopens = [], ci, runs = {}, older = 0, timedOut, head = DEFAULTS.redHead, timeoutSec = 0, driverLogin, fixerLogins = [], since }) {
  if (listed.length === 0) return timedOut ? result("red-check", "fail", "the PR has no commits", { kind: "missing" }) : WAIT("no commits yet");
  if (!filled(headSha)) {
    return timedOut ? result("red-check", "unverified", `the PR shows no head commit within ${timeoutSec}s, so no commit can be taken as its head`) : WAIT("the PR shows no head commit yet");
  }
  const moved = headMoved(headSha, recheck);
  if (moved !== undefined) return timedOut ? result("red-check", "unverified", `${moved}, still at ${timeoutSec}s, so no read is one snapshot`) : WAIT(moved);
  const pinned = pinRestarts(reopens, runs);
  const headAt = listed.findIndex((commit) => commit.sha === headSha);
  if (headAt === -1) {
    const missing = `the PR head ${headSha.slice(0, 7)} is not among the ${listed.length} newest commits read`;
    return timedOut ? result("red-check", "fail", `${missing} within ${timeoutSec}s`, { kind: "missing" }) : WAIT(`${missing} yet`);
  }
  const commits = listed.slice(0, headAt + 1);
  const tip = commits[commits.length - 1];
  const tipState = ci[tip.sha] ?? "none";
  const redIndex = commits.findIndex((commit) => ci[commit.sha] === "red");
  if (redIndex === -1) {
    const open = commits.filter((commit) => !CI_SETTLED.has(ci[commit.sha] ?? "none"));
    if (open.length > 0 && !timedOut) return WAIT(`no red commit yet; CI not finished on ${open.length} of ${commits.length} commit(s), ${tipState} on ${tip.sha.slice(0, 7)}`);
    if (older > 0) {
      return result("red-check", "unverified", `no red commit among the newest ${commits.length} of ${commits.length + older} commits on ${head}; the driver reads workflow runs for the newest ${commits.length} only`, { links: [commitLink(tip)] });
    }
    if (open.length === 0) {
      return result("red-check", "blocked", `${head} is green and no commit on it ever failed CI; a person must restore the red commit (the driver never force-pushes)`, { links: [commitLink(tip)] });
    }
    return result("red-check", "fail", `CI never went red on ${tip.sha.slice(0, 7)} within ${timeoutSec}s (state ${tipState})`, { links: [commitLink(tip)], kind: "missing" });
  }
  const red = commits[redIndex];
  const pushes = commits.slice(redIndex + 1);
  if (pushes.length === 0) {
    return timedOut
      ? result("red-check", "fail", `CI failed on ${red.sha.slice(0, 7)} but no commit was pushed after it within ${timeoutSec}s`, { links: [commitLink(red)], kind: "missing" })
      : WAIT(`red on ${red.sha.slice(0, 7)}, waiting for the fixer's push`);
  }
  if (tipState === "green") {
    const push = (commit) => pusherOf(runs[commit.sha], { sha: commit.sha, reopens: pinned });
    const actor = (commit) => githubActor(push(commit)?.login, { driverLogin, allowed: fixerLogins });
    const label = (commit) => (actor(commit) === "pinned" ? "fixer" : actor(commit));
    const evidence = [
      ...(runs[red.sha] ?? []).filter((run) => run.status === "completed" && RED.has(run.conclusion)).map((run) => ciEvidence(red.sha, run)),
      ...pushes.map((commit) => commitEvidence(commit, push(commit), label(commit))),
      ...(runs[tip.sha] ?? []).filter((run) => run.status === "completed" && !IGNORED.has(run.conclusion)).map((run) => ciEvidence(tip.sha, run)),
    ];
    const links = [commitLink(red), commitLink(tip)];
    const tipPush = push(tip);
    if (actor(tip) !== "pinned") {
      const who = githubActorText(actor(tip), tipPush?.login, "FACTORY_E2E_FIXER_LOGINS", NO_PUSHER);
      return refusedResult("red-check", `red on ${red.sha.slice(0, 7)}, green on ${tip.sha.slice(0, 7)} pushed by ${who}, so not the fixer's fix`, { links, evidence }, [actor(tip)]);
    }
    const fixerPushes = pushes.filter((commit) => actor(commit) === "pinned").length;
    return githubPass(
      "red-check",
      `red on ${red.sha.slice(0, 7)}, ${fixerPushes} fixer push(es), green on ${tip.sha.slice(0, 7)} pushed by the fixer account ${tipPush.login} (actor of workflow run ${tipPush.runId})`,
      { links, evidence },
      beforeRun(tipPush.at, since)
    );
  }
  return timedOut
    ? result("red-check", "fail", `${pushes.length} commit(s) pushed after the red one, but CI on ${tip.sha.slice(0, 7)} is ${tipState} after ${timeoutSec}s`, { links: [commitLink(red), commitLink(tip)], kind: "missing" })
    : WAIT(`${pushes.length} commit(s) after the red one; CI ${tipState} on ${tip.sha.slice(0, 7)}`);
}

/**
 * The security reviewer's review: a PR review in state `COMMENTED` by an
 * allowed reviewer login, whose body opens with `## Security review` then
 * `**Verdict:** CLEAN` or `FINDINGS` (the shape its post_findings tool
 * writes), on `headSha`, the PR head. A dismissed review, a pinned login's
 * item of any other shape, no pin, or no login is `unverified` at the
 * timeout. When every candidate is by a person (GitHub user type `User`),
 * the driver's own login, or a login outside `reviewerLogins`, the row is a
 * `fail` (wrong actor). A review submitted before `since` (the run start) is
 * `pass (prior run)`. `recheck` is the pull request read again after the
 * reviews: when it is not open or its head is not `headSha`, the row
 * waits, then is `unverified` (`headMoved`).
 */
export function evaluateSecurityReview({ reviews, comments, number, headSha, recheck, timedOut, timeoutSec = 0, driverLogin, reviewerLogins = DEFAULTS.reviewerLogins, since }) {
  const moved = filled(headSha) ? headMoved(headSha, recheck) : undefined;
  if (moved !== undefined) return timedOut ? result("review", "unverified", `${moved}, still at ${timeoutSec}s, so no read is one snapshot`) : WAIT(moved);
  const candidates = [...reviews, ...comments].filter((item) => String(item.body ?? "").includes(SECURITY_REVIEW));
  const actor = (item) => {
    if (item.state === "DISMISSED") return "dismissed";
    if (item.user?.type === "User") return "person";
    return githubActor(item.user?.login, { driverLogin, allowed: reviewerLogins });
  };
  const misfit = (item) => {
    if (item.state === undefined) return "an issue comment, not a PR review";
    if (item.state !== "COMMENTED") return `a review in state ${item.state}, not COMMENTED`;
    if (!REVIEWER_BODY.test(String(item.body))) return "a body that does not open with ## Security review then **Verdict:** CLEAN or FINDINGS";
    if (!filled(headSha)) return "no PR head to compare its commit with";
    if (item.commit_id !== headSha) {
      if (!filled(item.commit_id)) return `a review of no commit, not the head ${headSha.slice(0, 7)}`;
      const [reviewed, headText] = distinctShas(item.commit_id, headSha);
      return `a review of ${reviewed}, not the head ${headText}`;
    }
    return undefined;
  };
  const found = candidates.find((item) => actor(item) === "pinned" && misfit(item) === undefined);
  if (found !== undefined) {
    return githubPass(
      "review",
      `${SECURITY_REVIEW} (${REVIEWER_BODY.exec(found.body)[1]}) by the reviewer account ${found.user.login} on #${number} at the head ${headSha.slice(0, 7)}`,
      { links: [found.html_url], evidence: [reviewEvidence(found, "reviewer")] },
      beforeRun(found.submitted_at, since)
    );
  }
  const refused = candidates.map((item) => {
    const who = actor(item);
    const login = item.user?.login;
    if (who === "dismissed") return `a dismissed review by ${login ?? "an unknown login"}`;
    if (who === "person") return `${login}, a person`;
    if (who === "pinned") return `${login}, but ${misfit(item)}`;
    return githubActorText(who, login, "FACTORY_E2E_REVIEWER_LOGINS");
  });
  if (!timedOut) return WAIT(refused.length > 0 ? `${SECURITY_REVIEW} on #${number} only from ${refused.join("; ")}` : `no ${SECURITY_REVIEW} on #${number} yet`);
  if (refused.length > 0) {
    return refusedResult(
      "review",
      `${SECURITY_REVIEW} on #${number} only from ${refused.join("; ")}; none by the reviewer within ${timeoutSec}s`,
      { links: candidates.map((item) => item.html_url).filter(Boolean), evidence: candidates.map((item) => reviewEvidence(item, actor(item))) },
      candidates.map(actor)
    );
  }
  return result("review", "fail", `no ${SECURITY_REVIEW} on #${number} within ${timeoutSec}s`, { kind: "missing" });
}

export function isDriveComment(body) {
  return firstLine(body ?? "") === DRIVE_SENTINEL;
}

/** Post `factory: drive` once. A second opt-in from the driver would be noise, so an earlier one is reused. */
export function decideDriveComment({ comments, driverLogin }) {
  const mine = latest(comments, (comment) => sameLogin(comment.user?.login, driverLogin) && isDriveComment(comment.body));
  return mine === undefined ? { action: "post", body: DRIVE_SENTINEL } : { action: "reuse", comment: mine };
}

function isReviewerNoise(item) {
  const body = String(item.body ?? "");
  return body.includes(SECURITY_REVIEW) || /bugbot/i.test(item.user?.login ?? "") || /bugbot/i.test(body.slice(0, 400));
}

/**
 * One drive start after `factory: drive`, and nothing that looks like a
 * second one for `quietMs` after it. A drive start is the first fixer
 * comment or push. A second drive is the fixer echoing the sentinel or a
 * second distinct cloud agent URL. With no `driverLogin` (a cloud agent
 * posted the sentinel, maybe as the fixer's own identity) only the
 * sentinel itself is excluded. Only a comment written by, or a commit
 * pushed by, a login in `fixerLogins` starts a drive. The pusher and push
 * time come from the commit's workflow runs (`pusherOf` over `runs`, sha to
 * runs, and `reopens` pinned by `pinRestarts`); a commit with no pusher evidence never counts, whatever its author
 * login says. With no pin the start is named "a non-driver account" and the
 * row is `unverified`. At the timeout, activity only by pinned-out logins
 * is a `fail` (wrong actor). A drive that started before `since` (the run
 * start) is `pass (prior run)`.
 */
export function evaluateDrive({ sentinel, comments, commits, runs = {}, reopens = [], driverLogin, fixerLogins = [], now, quietMs, timedOut, timeoutSec = 0, since }) {
  const after = (iso) => Date.parse(iso) > Date.parse(sentinel.created_at);
  const notDriver = (item) => item.id !== sentinel.id && !sameLogin(item.user?.login, driverLogin);
  const actor = (login) => githubActor(login, { driverLogin, allowed: fixerLogins });
  const counts = (login) => actor(login) === (fixerLogins.length > 0 ? "pinned" : "non-driver");
  const echo = comments.find((comment) => after(comment.created_at) && notDriver(comment) && isDriveComment(comment.body));
  if (echo !== undefined) {
    return result("drive", "fail", `${echo.user?.login ?? "someone"} posted factory: drive after the driver; the fixer's own comment can start a second drive`, { links: [sentinel.html_url, echo.html_url], kind: "loop" });
  }
  const label = (login) => (actor(login) === "pinned" ? "fixer" : actor(login));
  const pinned = pinRestarts(reopens, runs);
  const seen = [
    ...comments
      .filter((comment) => after(comment.created_at) && notDriver(comment) && !isReviewerNoise(comment))
      .map((comment) => ({ kind: "comment", login: comment.user?.login, at: comment.created_at, url: comment.html_url, body: comment.body, evidence: githubCommentEvidence(comment, label(comment.user?.login)) })),
    ...commits
      .map((commit) => ({ commit, push: pusherOf(runs[commit.sha], { sha: commit.sha, reopens: pinned }) }))
      .map(({ commit, push }) => ({ commit, push, at: push?.at ?? commit.commit?.committer?.date }))
      .filter(({ push, at }) => after(at) && actor(push?.login) !== "driver")
      .map(({ commit, push, at }) => ({ kind: "push", login: push?.login, run: push?.runId, at, url: commit.html_url, body: "", evidence: commitEvidence(commit, push, label(push?.login)) })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const activity = seen.filter((item) => counts(item.login));
  const agents = new Set(activity.flatMap((item) => String(item.body).match(AGENT_URL) ?? []));
  if (agents.size > 1) {
    return result("drive", "fail", `two drives: ${[...agents].join(", ")}`, { links: [sentinel.html_url, ...agents], kind: "loop" });
  }
  const who = (item) => githubActorText(actor(item.login), item.login, "FACTORY_E2E_FIXER_LOGINS", item.kind === "push" ? NO_PUSHER : undefined);
  if (activity.length === 0) {
    if (!timedOut) return WAIT("no fixer comment or push yet");
    if (seen.length > 0) {
      const others = [...new Set(seen.map(who))];
      return refusedResult("drive", `no fixer comment or push within ${timeoutSec}s of factory: drive; activity only from ${others.join("; ")}`, { links: [sentinel.html_url], evidence: seen.map((item) => item.evidence) }, seen.map((item) => actor(item.login)));
    }
    return result("drive", "fail", `no fixer comment or push within ${timeoutSec}s of factory: drive`, { links: [sentinel.html_url], kind: "missing" });
  }
  const first = activity[0];
  const quietFor = now - Date.parse(first.at);
  if (quietFor < quietMs) return WAIT(`drive started (${first.kind}); quiet window ${Math.round(quietFor / 1000)}s of ${Math.round(quietMs / 1000)}s`);
  const quiet = `no second drive for ${Math.round(quietMs / 1000)}s`;
  const links = [sentinel.html_url, first.url];
  if (fixerLogins.length === 0) {
    return result("drive", "unverified", `one drive start (${first.kind}) by ${who(first)}; ${quiet}`, { links, evidence: [first.evidence] });
  }
  const source = first.kind === "push" ? ` (actor of workflow run ${first.run})` : "";
  return githubPass("drive", `one drive start (${first.kind}) by the fixer account ${first.login}${source}; ${quiet}`, { links, evidence: [first.evidence] }, beforeRun(first.at, since));
}

// ---------------------------------------------------------------- cloud-agent writes

export function prBody(head) {
  return `Opened by scripts/e2e-drive.mjs. Fixture branch \`${head}\`; do not merge.`;
}

/** Stable across re-runs. The platform did not dedupe a re-run minutes later with this key, so the driver reads GitHub before each launch. */
export function agentIdempotencyKey(step, head) {
  return `factory-e2e/${step}/${head}`;
}

const HANDS_OFF = [
  "Do nothing else. Do not edit, create, or delete any file. Do not commit. Do not push.",
  "Do not create, rename, or delete any branch. Do not open any other pull request.",
  "Do not post any other comment, review, or reaction. Do not change the title, body, labels, reviewers, or state of any pull request.",
];

/** The whole instruction for the agent that opens one fixture PR. */
export function openPrPrompt({ repo, head, base, title, body }) {
  return [
    `You have exactly one task: open one pull request in the GitHub repository ${repo}.`,
    "",
    `- head branch: ${head} (it already exists on GitHub; use it as it is)`,
    `- base branch: ${base}`,
    `- title, exactly: ${title}`,
    `- body, exactly: ${body}`,
    "- ready for review, not a draft",
    "",
    `If an open pull request with head ${head} already exists, do not open another one; reply with its URL.`,
    "",
    ...HANDS_OFF,
    "",
    "When you are done, reply with only the pull request URL.",
  ].join("\n");
}

/** The whole instruction for the agent that posts the `factory: drive` opt-in. */
export function driveCommentPrompt({ repo, number, url }) {
  return [
    `You have exactly one task: post one comment on pull request #${number} in the GitHub repository ${repo} (${url}).`,
    "",
    "The comment body must be exactly this one line, with nothing before or after it:",
    DRIVE_SENTINEL,
    "",
    `If that pull request already has a comment whose body is exactly \`${DRIVE_SENTINEL}\`, post nothing; reply with that comment's URL.`,
    "",
    ...HANDS_OFF,
    "",
    "When you are done, reply with only the comment URL.",
  ].join("\n");
}

const AGENT_DONE = new Set(["finished", "error", "cancelled"]);

/** A cloud agent run's status as a verdict or a wait. Pass means the run ended; GitHub still decides the step. */
export function evaluateAgentRun({ status, timedOut, timeoutSec = 0, url }) {
  if (AGENT_DONE.has(status)) return result("agent", status === "finished" ? "pass" : "fail", `agent run ${status}`, { links: [url] });
  return timedOut ? result("agent", "fail", `agent run still ${status ?? "unknown"} after ${timeoutSec}s`, { links: [url], kind: "missing" }) : WAIT(`agent run ${status ?? "unknown"}`);
}

function sameRepo(pull, repo) {
  return norm(pull.head?.repo?.full_name) === norm(repo);
}

/**
 * The fixture PR as GitHub shows it after the agent ran. `before` and `after`
 * are the head branch as `{ sha, ahead }` of base; the agent must leave it as
 * it found it. Nothing here reads the agent's reply.
 */
export function verifyAgentPr({ pulls, commits, repo, head, base, title, titlePrefix, before, after }) {
  const open = pulls.filter((pull) => pull.state === "open" && pull.head?.ref === head && sameRepo(pull, repo));
  if (open.length === 0) return { ...result("prs", "fail", `no open PR with head ${head}`, { kind: "missing" }), facts: undefined };
  const pr = open[0];
  const facts = {
    number: pr.number,
    url: pr.html_url,
    author: pr.user?.login ?? "unknown",
    head: pr.head.ref,
    base: pr.base?.ref,
    title: pr.title,
    draft: pr.draft === true,
    commits: commits.length,
    shaBefore: before.sha,
    shaAfter: after.sha,
    aheadBefore: before.ahead,
    aheadAfter: after.ahead,
  };
  const problems = [];
  if (open.length > 1) problems.push(`duplicate PRs ${open.map((pull) => `#${pull.number}`).join(", ")}`);
  if (facts.base !== base) problems.push(`base is ${facts.base}, expected ${base}`);
  if (facts.draft) problems.push("opened as a draft");
  if (titlePrefix !== undefined ? !String(facts.title).startsWith(titlePrefix) : facts.title !== title) {
    problems.push(`title is "${facts.title}", expected ${titlePrefix !== undefined ? `a "${titlePrefix}" prefix` : `"${title}"`}`);
  }
  if (after.sha !== before.sha) problems.push(`${head} moved from ${before.sha.slice(0, 7)} to ${after.sha.slice(0, 7)}`);
  if (after.ahead !== before.ahead) problems.push(`${head} was ${before.ahead} commit(s) ahead of ${base}, now ${after.ahead}`);
  if (commits.length !== before.ahead) problems.push(`PR has ${commits.length} commit(s), the branch had ${before.ahead}`);
  const summary = `#${facts.number} by ${facts.author}, ${facts.head} into ${facts.base}, ${facts.commits} commit(s)`;
  if (problems.length > 0) return { ...result("prs", "fail", `${summary}: ${problems.join("; ")}`, { links: [facts.url], kind: "agent" }), facts };
  return { ...result("prs", "pass", `${summary}, title "${facts.title}", ${head} unchanged at ${facts.shaAfter.slice(0, 7)}`, { links: [facts.url], evidence: [prEvidence({ number: facts.number, author: pr.user?.login, head, sha: facts.shaAfter })] }), facts };
}

/** A cloud agent's PR or comment not found yet is a wait until the timeout; any other verdict is final. */
export function settleVerdict(out, { timedOut }) {
  return out.kind === "missing" && !timedOut ? WAIT(out.reason) : out;
}

export function isExactDriveComment(body) {
  return String(body ?? "").trim() === DRIVE_SENTINEL;
}

/**
 * The `factory: drive` comment as GitHub shows it. Exactly one comment whose
 * body is the sentinel, no near miss, an allowed author, and no other
 * comment from that author while the agent ran (`since` to `until`, when
 * there was a launch). The bound matters when the fixer posts as the same
 * Cursor app identity right after.
 */
export function verifyAgentComment({ comments, number, allowedLogins = [], since, until }) {
  const exact = comments.filter((comment) => isExactDriveComment(comment.body));
  const near = comments.filter((comment) => isDriveComment(comment.body) && !isExactDriveComment(comment.body));
  if (exact.length === 0) {
    return { ...result("drive", "fail", near.length > 0 ? `a factory: drive comment on #${number} has more than the sentinel in its body` : `no factory: drive comment on #${number}`, { links: near.map((c) => c.html_url), kind: near.length > 0 ? "agent" : "missing" }), facts: undefined };
  }
  const comment = exact[0];
  const author = comment.user?.login ?? "unknown";
  const facts = { id: comment.id, url: comment.html_url, author, body: comment.body, createdAt: comment.created_at };
  const problems = [];
  if (exact.length > 1) problems.push(`${exact.length} factory: drive comments`);
  if (near.length > 0) problems.push(`${near.length} near miss comment(s) starting with factory: drive`);
  if (allowedLogins.length > 0 && !allowedLogins.some((login) => sameLogin(login, author))) problems.push(`author ${author} is not one of ${allowedLogins.join(", ")}`);
  if (since !== undefined) {
    const during = (iso) => Date.parse(iso) >= Date.parse(since) && (until === undefined || Date.parse(iso) <= Date.parse(until));
    const extra = comments.filter((c) => c.id !== comment.id && sameLogin(c.user?.login, author) && during(c.created_at) && !isExactDriveComment(c.body));
    if (extra.length > 0) problems.push(`${author} also posted ${extra.length} other comment(s)`);
  }
  if (problems.length > 0) return { ...result("drive", "fail", `factory: drive by ${author}: ${problems.join("; ")}`, { links: [facts.url], kind: "agent" }), facts };
  return { ...result("drive", "pass", `factory: drive by ${author}, body exact`, { links: [facts.url] }), facts };
}

// ---------------------------------------------------------------- cleanup

export function protectedRefs(defaults = DEFAULTS) {
  return [defaults.base, "main", "master", defaults.reviewHead, defaults.redHead];
}

export function isSafeToDelete(ref, protectedList) {
  return typeof ref === "string" && ref !== "" && !protectedList.some((name) => norm(name) === norm(ref));
}

/** What `--cleanup` does: close the test PRs, move the ticket to Done, and with `--cleanup-branches` delete branches the fixer created. */
export function cleanupPlan({ prs, issue, allPulls, repo, fixerLogins, cleanupBranches, protectedList }) {
  const closePrs = prs.filter((pr) => pr !== undefined && pr.state !== "closed").map((pr) => pr.number);
  const ticketToDone = issue !== undefined && norm(issue.status) !== norm("Done");
  const deleteBranches = cleanupBranches
    ? [
        ...new Set(
          allPulls
            .filter((pull) => fixerLogins.includes(pull.user?.login ?? "") && norm(pull.head?.repo?.full_name) === norm(repo))
            .map((pull) => pull.head.ref)
            .filter((ref) => isSafeToDelete(ref, protectedList))
        ),
      ]
    : [];
  return { closePrs, ticketToDone, deleteBranches };
}

// ---------------------------------------------------------------- polling and output

/**
 * Fetch and evaluate until the evaluation stops waiting. `graceMs` extends
 * the hard stop past the timeout for evaluations that wait on a quiet window.
 */
export async function poll({ fetch, evaluate, clock, timeoutMs, intervalMs, graceMs = 0, onWait, step }) {
  const start = clock.now();
  let lastError;
  for (;;) {
    let facts;
    try {
      facts = await fetch();
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const now = clock.now();
    const elapsed = now - start;
    const timedOut = elapsed >= timeoutMs;
    if (facts !== undefined) {
      const out = evaluate(facts, { now, timedOut, elapsedMs: elapsed });
      if (!out.wait) return out;
      if (elapsed >= timeoutMs + graceMs) return result(step, "fail", `still waiting at the deadline: ${out.note}`, { kind: "missing" });
      onWait?.(out.note, elapsed);
    } else if (timedOut) {
      return result(step, "fail", `could not read state: ${lastError}`, { kind: "io" });
    } else {
      onWait?.(`read failed, retrying: ${lastError}`, elapsed);
    }
    await clock.sleep(intervalMs);
  }
}

export function summarizeResults(results) {
  const counts = { pass: 0, [PRIOR_PASS]: 0, fail: 0, blocked: 0, unverified: 0, skipped: 0 };
  for (const entry of results) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  return { counts, exitCode: counts.fail > 0 ? 1 : 0 };
}

/**
 * A pass row that only re-read state from before the run: any
 * `pass (prior run)` row (a Jira hop done before it, reused PRs, or a
 * review, fixer push, or drive start that predates it), or a reused ticket
 * the run did not reset, which stays `pass` and carries `reread`.
 */
export function isReread(entry) {
  return entry.status === PRIOR_PASS || (entry.status === "pass" && entry.reread === true);
}

/**
 * The summary line, plus a note when some pass rows only re-read state from
 * before the run. The note counts what the run sent, not what passed.
 */
export function renderSummary(results) {
  const { counts } = summarizeResults(results);
  const lines = [`e2e: ${Object.entries(counts).map(([name, count]) => `${count} ${name}`).join(", ")}`];
  const passes = results.filter((entry) => isPass(entry.status));
  const reread = passes.filter(isReread);
  if (reread.length > 0) {
    const posts = results.flatMap((entry) => entry.evidence ?? []).filter((item) => item.kind === "post").length;
    lines.push(
      `note: ${reread.length} pass row(s) re-read Jira or GitHub state from before this run and sent or wrote nothing (${reread.map((entry) => entry.step).join(", ")}); ${passes.length - reread.length} pass row(s) came from this run's sends or writes; ${posts} route POST(s) this run`
    );
  }
  return lines.join("\n");
}

export function renderTable(results) {
  const rows = results.map((entry) => [entry.step, entry.status, entry.reason]);
  const widths = [4, 6].map((min, i) => Math.max(min, ...rows.map((row) => row[i].length)));
  const lines = [`${"step".padEnd(widths[0])}  ${"status".padEnd(widths[1])}  detail`];
  for (const [index, row] of rows.entries()) {
    lines.push(`${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2]}`);
    const indent = "".padEnd(widths[0] + widths[1] + 4);
    for (const item of results[index].evidence ?? []) lines.push(`${indent}evidence: ${formatEvidence(item)}`);
    for (const link of results[index].links) lines.push(`${indent}${link}`);
  }
  return lines.join("\n");
}

/** What the driver prints after a run: its start time above the table, so evidence timestamps compare against it, then the summary. */
export function renderReport(startedAt, results) {
  return [`run started ${startedAt}; evidence before this time is from an earlier run`, renderTable(results), "", renderSummary(results)].join("\n");
}
