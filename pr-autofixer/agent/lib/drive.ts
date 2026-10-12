import { prompt, type AgentCloudOptions } from "@cursor/july";
import {
  extractGithubPrRef,
  type GithubPrRef,
} from "@cursor/july/channels/slack";

export type { GithubPrRef };

export function githubPrRef(input: {
  owner: string;
  repo: string;
  number: number;
  url: string;
}): GithubPrRef {
  return {
    owner: input.owner,
    repo: input.repo,
    number: input.number,
    url: input.url,
    label: `${input.owner}/${input.repo}#${input.number}`,
  };
}

export function parsePrRef(raw: string): GithubPrRef | undefined {
  return extractGithubPrRef(raw.trim());
}

/**
 * The PR's session key on the `drive` channel and for buffered wakes. Each
 * close of the PR bumps its generation (lib/pr-generation.ts), and a
 * generation past 0 is appended as `@g<n>`, so a reopened PR starts new
 * sessions instead of resuming the ones from before its close. Generation 0
 * is the key as it always was.
 */
export function continuationTokenFor(pr: GithubPrRef, generation = 0): string {
  const base = `pr:${pr.owner}/${pr.repo}#${pr.number}`;
  return generation > 0 ? `${base}@g${generation}` : base;
}

export function prRefFromContinuationToken(
  token: string | null | undefined
): GithubPrRef | undefined {
  if (token === undefined || token === null || !token.startsWith("pr:")) {
    return undefined;
  }
  return parsePrRef(token.slice("pr:".length).replace(/@g\d+$/, ""));
}

/** `PR owner/repo#n`, the title startDrive gives every drive session. */
export function prRefFromSessionTitle(title: string | null | undefined): GithubPrRef | undefined {
  const match = title?.match(/^PR (\S+\/\S+#\d+)$/);
  return match?.[1] === undefined ? undefined : parsePrRef(match[1]);
}

export function cloudOptionsFor(pr: GithubPrRef): AgentCloudOptions {
  return {
    repos: [
      {
        url: `https://github.com/${pr.owner}/${pr.repo}`,
        prUrl: pr.url,
      },
    ],
  };
}

export function driveMessage(
  pr: GithubPrRef,
  extras?: { hint?: string }
): string {
  const lines = [
    prompt`
      Drive this pull request: ${pr.url}

      Auto-fix this PR. Push verified fixes to the PR head. Never merge, enable auto-merge, or force-push.
    `,
  ];
  if (extras?.hint) {
    lines.push(`Owner hint: ${extras.hint}`);
  }
  return lines.join("\n\n");
}

export function buildGenericPrUpdatePrompt(prUrl: string): string {
  return prompt`
    Something changed on this pull request.

    PR: ${prUrl}

    Auto-fix if an action is warranted. Push verified fixes to the PR head. Never merge, enable auto-merge, or force-push.

    Refresh the current PR state, then decide whether any autofix action is needed. Do not rely on webhook payload details from this follow-up.
  `;
}
