import type {
  GitHubCheckRunEvent,
  GitHubCheckSuiteEvent,
  GitHubEventContext,
  GitHubPullRequestEvent,
  GitHubRawEvent,
  GitHubStatusEvent,
  GitHubWorkflowRunEvent,
} from "@cursor/july/channels/github";
import type { BufferedWebhookEvent } from "./webhook-buffer.js";

const PULL_REQUEST_ACTIONS = new Set([
  "reopened",
  "synchronize",
  "edited",
  "ready_for_review",
  "review_requested",
  "converted_to_draft",
]);

const CHECK_SUITE_CONCLUSIONS = new Set([
  "success",
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
]);

export const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
]);

/**
 * Bugbot reports findings as a `neutral` conclusion on its `Cursor Bugbot`
 * check run, in the `cursor` app's check suite (marsbank #38: "Bugbot — 1
 * finding" and no drive, since neutral is no failure). Only that run counts,
 * by name. Hosted v2 forwards check_suite, not check_run, so a neutral cursor
 * suite is a candidate (`isBugbotCandidate`) until its runs are read
 * (`confirmBugbotSuite`) and name the Bugbot run.
 */
export function isBugbotFindings(event: { eventName: string; conclusion?: string | null; checkName?: string }): boolean {
  if (event.conclusion !== "neutral") return false;
  if (event.eventName !== "check_run" && event.eventName !== "check_suite") return false;
  return isBugbotRunName(event.checkName);
}

export function isBugbotRunName(name: string | undefined): boolean {
  return /^cursor bugbot\b/i.test(name?.trim() ?? "");
}

/** A neutral check_suite from the cursor app whose runs have not been read yet. */
export function isBugbotCandidate(event: { eventName: string; conclusion?: string | null; app?: string; checkName?: string }): boolean {
  return event.eventName === "check_suite" && event.conclusion === "neutral" && event.app === BUGBOT_APP && event.checkName === undefined;
}

export const BUGBOT_APP = "cursor";

export function shouldBufferPullRequest(pr: GitHubPullRequestEvent): boolean {
  return PULL_REQUEST_ACTIONS.has(pr.action);
}

export function shouldBufferStatus(status: GitHubStatusEvent): boolean {
  return status.state === "failure" || status.state === "error";
}

function shouldBufferCheckSuite(suite: GitHubCheckSuiteEvent): boolean {
  return (
    suite.action === "completed" &&
    suite.conclusion != null &&
    (CHECK_SUITE_CONCLUSIONS.has(suite.conclusion) || isBugbotCandidate({ eventName: "check_suite", conclusion: suite.conclusion, ...(suite.app?.slug === undefined ? {} : { app: suite.app.slug }) }))
  );
}

function shouldBufferCheckRun(run: GitHubCheckRunEvent): boolean {
  return (
    run.action === "completed" &&
    run.conclusion != null &&
    (FAILING_CONCLUSIONS.has(run.conclusion) || isBugbotFindings({ eventName: "check_run", conclusion: run.conclusion, ...(run.name === undefined ? {} : { checkName: run.name }) }))
  );
}

function shouldBufferWorkflowRun(run: GitHubWorkflowRunEvent): boolean {
  return (
    run.action === "completed" &&
    run.conclusion != null &&
    FAILING_CONCLUSIONS.has(run.conclusion)
  );
}

function shouldBufferRawEvent(event: GitHubRawEvent): boolean {
  if (event.eventName === "pull_request_review") {
    return event.action === "submitted" || event.action === "dismissed";
  }
  if (event.eventName === "pull_request_review_thread") {
    return event.action === "resolved" || event.action === "unresolved";
  }
  return false;
}

// check_suite and workflow_run name their PR by its API URL
// (api.github.com/repos/o/r/pulls/N), and July passes that through as the
// conversation URL. drive_pr's parser takes only github.com/o/r/pull/N.
function pullUrl(ctx: GitHubEventContext, number: number): string {
  return `https://github.com/${ctx.repository.owner}/${ctx.repository.name}/pull/${number}`;
}

function fromConversation(
  ctx: GitHubEventContext,
  fields: {
    eventName: string;
    action?: string;
    headSha?: string;
    conclusion?: string;
  }
): BufferedWebhookEvent | null {
  if (ctx.conversation.kind !== "pull_request") {
    return null;
  }
  if (ctx.conversation.number <= 0) {
    return null;
  }
  return {
    eventName: fields.eventName,
    action: fields.action,
    prUrl: pullUrl(ctx, ctx.conversation.number),
    owner: ctx.repository.owner,
    repo: ctx.repository.name,
    number: ctx.conversation.number,
    headSha: fields.headSha,
    ...(fields.conclusion === undefined ? {} : { conclusion: fields.conclusion }),
  };
}

async function resolvePrFromCommitSha(input: {
  ctx: GitHubEventContext;
  sha: string;
}): Promise<{ number: number; url: string } | undefined> {
  try {
    const octokit = await input.ctx.github.getOctokit();
    const { data: pulls } = await octokit.request(
      "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls",
      {
        owner: input.ctx.repository.owner,
        repo: input.ctx.repository.name,
        commit_sha: input.sha,
      }
    );
    const open = pulls.find((pull) => pull.state === "open");
    if (open === undefined) {
      return undefined;
    }
    return {
      number: open.number,
      url: open.html_url,
    };
  } catch {
    return undefined;
  }
}

async function fromSha(input: {
  ctx: GitHubEventContext;
  sha: string;
  eligible: boolean;
  eventName: string;
  action?: string;
  conclusion?: string | null;
  app?: string;
  checkName?: string;
  checkSuiteId?: number;
}): Promise<BufferedWebhookEvent | null> {
  if (!input.eligible) {
    return null;
  }
  const conclusion = input.conclusion ?? undefined;
  const source = {
    ...(input.app === undefined ? {} : { app: input.app }),
    ...(input.checkName === undefined ? {} : { checkName: input.checkName }),
    ...(input.checkSuiteId === undefined ? {} : { checkSuiteId: input.checkSuiteId }),
  };
  const direct = fromConversation(input.ctx, {
    eventName: input.eventName,
    action: input.action,
    headSha: input.sha,
    conclusion,
  });
  if (direct !== null) {
    return { ...direct, ...source };
  }
  const resolved = await resolvePrFromCommitSha({
    ctx: input.ctx,
    sha: input.sha,
  });
  if (resolved === undefined) {
    return null;
  }
  return {
    eventName: input.eventName,
    action: input.action,
    prUrl: resolved.url,
    owner: input.ctx.repository.owner,
    repo: input.ctx.repository.name,
    number: resolved.number,
    headSha: input.sha,
    ...(conclusion === undefined ? {} : { conclusion }),
    ...source,
  };
}

export function bufferedEventFromPr(input: {
  ctx: GitHubEventContext;
  pr: GitHubPullRequestEvent;
}): BufferedWebhookEvent | null {
  if (!shouldBufferPullRequest(input.pr)) {
    return null;
  }
  return {
    eventName: "pull_request",
    action: input.pr.action,
    prUrl: input.pr.url,
    owner: input.ctx.repository.owner,
    repo: input.ctx.repository.name,
    number: input.pr.number,
    headSha: input.pr.headSha,
  };
}

export function bufferedEventFromComment(input: {
  ctx: GitHubEventContext;
  eventName: string;
}): BufferedWebhookEvent | null {
  return fromConversation(input.ctx, { eventName: input.eventName });
}

export function bufferedEventFromCheckSuite(input: {
  ctx: GitHubEventContext;
  suite: GitHubCheckSuiteEvent;
}): Promise<BufferedWebhookEvent | null> {
  return fromSha({
    ctx: input.ctx,
    sha: input.suite.headSha,
    eligible: shouldBufferCheckSuite(input.suite),
    eventName: "check_suite",
    action: input.suite.action,
    conclusion: input.suite.conclusion,
    ...(input.suite.app?.slug === undefined ? {} : { app: input.suite.app.slug }),
    checkSuiteId: input.suite.checkSuiteId,
  });
}

export function bufferedEventFromCheckRun(input: {
  ctx: GitHubEventContext;
  run: GitHubCheckRunEvent;
}): Promise<BufferedWebhookEvent | null> {
  return fromSha({
    ctx: input.ctx,
    sha: input.run.headSha,
    eligible: shouldBufferCheckRun(input.run),
    eventName: "check_run",
    action: input.run.action,
    conclusion: input.run.conclusion,
    ...(input.run.app?.slug === undefined ? {} : { app: input.run.app.slug }),
    ...(input.run.name === undefined ? {} : { checkName: input.run.name }),
  });
}

export function bufferedEventFromWorkflowRun(input: {
  ctx: GitHubEventContext;
  run: GitHubWorkflowRunEvent;
}): Promise<BufferedWebhookEvent | null> {
  return fromSha({
    ctx: input.ctx,
    sha: input.run.headSha,
    eligible: shouldBufferWorkflowRun(input.run),
    eventName: "workflow_run",
    action: input.run.action,
    conclusion: input.run.conclusion,
  });
}

export function bufferedEventFromStatus(input: {
  ctx: GitHubEventContext;
  status: GitHubStatusEvent;
}): Promise<BufferedWebhookEvent | null> {
  return fromSha({
    ctx: input.ctx,
    sha: input.status.sha,
    eligible: shouldBufferStatus(input.status),
    eventName: "status",
  });
}

export function bufferedEventFromRaw(input: {
  ctx: GitHubEventContext;
  event: GitHubRawEvent;
}): BufferedWebhookEvent | null {
  if (!shouldBufferRawEvent(input.event)) {
    return null;
  }
  return fromConversation(input.ctx, {
    eventName: input.event.eventName,
    action: input.event.action,
  });
}
