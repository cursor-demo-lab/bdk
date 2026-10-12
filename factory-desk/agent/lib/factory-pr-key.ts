// Whether a pull request is the factory's, and which ticket it belongs to.
// The worker's launch makes the cloud agent start the head branch with the
// ticket key (factory-worker launch.ts `prHandoff`), and the worker opens the
// PR from that branch, titled with the key (factory-worker implement-pr.ts),
// not through the platform's autoCreatePR (`autoCreatePR: false`), so the head
// branch is what marks it. A PR the platform's autoCreatePR opens is
// `cursor[bot]`'s. A key at the start of the head branch counts whoever opened
// the PR. A key only at the start of the title counts only when `cursor[bot]`
// opened it: anyone can title a PR "TLSSN-1: ...", and that alone must not
// move a ticket, announce a review, buy an early draft review, or hand the
// fixer push access. The login compare is exact, so `Cursor[bot]` is not the
// bot.
//
// Shared verbatim by factory-desk, factory-worker, pr-autofixer, and
// security-reviewer; its test is factory-worker's factory-pr-key.test.ts
// (scripts/copies-parity.test.mjs).

/** The login the platform's autoCreatePR opens a PR as. */
export const CURSOR_BOT = "cursor[bot]";

/** The key `text` starts with once trimmed, from one of `projects`. No projects matches nothing. */
export function issueKeyAtStart(text: string | undefined, projects: readonly string[]): string | undefined {
  if (projects.length === 0) return undefined;
  const pattern = new RegExp(`^(?:${projects.map(escapeRegExp).join("|")})-\\d+`);
  return text?.trim().match(pattern)?.[0];
}

/** The head branch's key, else the title's when `cursor[bot]` opened the PR. */
export function factoryPrKey(input: {
  headRef?: string | undefined;
  title?: string | undefined;
  authorLogin?: string | undefined;
  projects: readonly string[];
}): string | undefined {
  const fromBranch = issueKeyAtStart(input.headRef, input.projects);
  if (fromBranch !== undefined) return fromBranch;
  if (input.authorLogin !== CURSOR_BOT) return undefined;
  return issueKeyAtStart(input.title, input.projects);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
