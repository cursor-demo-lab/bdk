import type { CommentFacts } from "./review-update.js";

// change-monitor's sticky comment on marsbank#32 (TLSSN-37, head fc478b1),
// issuecomment-5851078796: created at 23:57:17Z while it drafted, then edited
// at 00:00:35Z into the published plan (summary lines, `Services:`, the
// "Mention @change-monitor" footer, a `<details>` Plan block, and the
// `<!-- cursor:plan:<base64 json> -->` marker). marsbank is not readable from
// the desk's CI, so these follow that comment's structure, not its bytes,
// with #32's own risk line ("Users may think restore failed"). Its prose and
// Plan block name failures on purpose: neither is a result.

export const TLSSN_37_COMMENT_URL = "https://github.com/cursor-demo-lab/marsbank/pull/32#issuecomment-5851078796";

const PLAN_JSON = Buffer.from(JSON.stringify({ services: ["marsbank-web"], signals: ["settings restore errors", "a11y announcement failures"] })).toString("base64");

export const TLSSN_37_DRAFTING = [
  "<!-- cursor:sticky:change-monitor-plan -->",
  "### Change monitor",
  "",
  "Reading this pull request to plan what to watch once it ships.",
  "",
  "Mention @change-monitor with questions or changes to the plan.",
].join("\n");

export const TLSSN_37_PUBLISHED = [
  "<!-- cursor:sticky:change-monitor-plan -->",
  "### Change monitor",
  "",
  "This change makes the Settings \"All six registers restored.\" confirmation an ARIA live-region announcement.",
  "Nothing in the restore request path changes. Risk: without the announcement, users may think restore failed.",
  "",
  "Services: marsbank-web",
  "",
  "Mention @change-monitor with questions or changes to the plan.",
  "",
  "<details>",
  "<summary>Plan</summary>",
  "",
  "- Watch: settings restore errors and failed restore requests after deploy.",
  "- Watch: console errors from the Settings page.",
  "- Issues found in these signals are filed on the ticket and escalated in this comment.",
  "",
  "</details>",
  "",
  `<!-- cursor:plan:${PLAN_JSON} -->`,
].join("\n");

/** Escalation-sounding prose with no structured state behind it: still just a published plan. */
export const TLSSN_37_ESCALATION_PROSE = TLSSN_37_PUBLISHED.replace(
  "Services: marsbank-web",
  "Services: marsbank-web\n\nStatus: Attention. Escalated: settings restore errors doubled; issues found, rollout failed."
);

const FACTORY_DESK_PLAN_JSON = Buffer.from(JSON.stringify({ services: ["factory-desk"], signals: ["settings restore errors"] })).toString("base64");

/**
 * What Rollouts published on marsbank PRs: it linked the Agent SDK deploy's
 * `factory-desk` catalog service, so both the `Services:` line and the plan
 * marker name the desk instead of a marsbank service.
 */
export const TLSSN_37_FACTORY_DESK = TLSSN_37_PUBLISHED.replace("Services: marsbank-web", "Services: factory-desk").replace(
  `<!-- cursor:plan:${PLAN_JSON} -->`,
  `<!-- cursor:plan:${FACTORY_DESK_PLAN_JSON} -->`
);

export function stickyComment(body: string): CommentFacts {
  return { authorLogin: "cursor[bot]", authorType: "Bot", body, htmlUrl: TLSSN_37_COMMENT_URL };
}
