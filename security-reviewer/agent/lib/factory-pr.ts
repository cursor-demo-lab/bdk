// A PR the factory opened carries the ticket key at the start of its head
// branch and its title. The factory's goal is every PR ready for review on
// open (Bugbot skips drafts): factory-worker's launch tells the cloud agent
// to open its PR ready (autoCreatePR: false, factory-worker/agent/lib/launch.ts)
// and marks one that still arrives a draft ready as soon as a delivery for it
// arrives (factory-worker/agent/lib/pr-ready.ts). Reviewing a factory draft
// early is defense in depth for that brief hop, or for a PR the worker could
// not undraft, so the channel reviews a draft only when it carries a key from
// FACTORY_JIRA_PROJECTS. factoryIssueKey is the key match itself (branch or
// title, whoever opened the PR); factoryDraftKey below is the factory PR rule
// in factory-pr-key.ts, which the desk, the worker, and the fixer share.

import { factoryPrKey, issueKeyAtStart } from "./factory-pr-key.js";

export function factoryIssueKey(input: {
  headRef: string | undefined;
  title: string | undefined;
  projects: readonly string[];
}): string | undefined {
  return issueKeyAtStart(input.headRef, input.projects) ?? issueKeyAtStart(input.title, input.projects);
}

// A draft is the factory's when its head branch carries the key (the worker
// names the branch), or when only its title does and the Cursor bot opened
// it (platform autoCreatePR). Anyone can title a draft "TLSSN-1: ...", and a
// title alone from a person does not buy a review before ready_for_review,
// a ticket move from the worker, or an automatic drive from the fixer. Here
// the author only decides whether a draft is reviewed early; every
// non-draft PR is reviewed either way.
export const factoryDraftKey = factoryPrKey;
