export const FACTORY_DRIVE_SENTINEL = "factory: drive";

/** First line is exactly `factory: drive`. That comment is a person's opt-in. */
export function isFactoryDriveComment(body: string): boolean {
  const first = body.replace(/\r\n/g, "\n").split("\n", 1)[0]?.trim() ?? "";
  return first.toLowerCase() === FACTORY_DRIVE_SENTINEL;
}

/**
 * GitHub `author_association` values trusted to start a drive: the repo
 * owner, a member of the owning organisation, or an invited collaborator
 * (which includes read-only outside collaborators). Not a push-access check.
 */
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type FactoryDriveAuthor = { login?: string; type?: string; association?: string };

export type FactoryDriveInput = {
  body: string;
  conversation: { kind: string; number: number; url: string };
  repository: { owner: string; name: string };
  repos: readonly string[];
  author: FactoryDriveAuthor;
};

export type FactoryDriveDecision =
  | { drive: true; pr: { owner: string; repo: string; number: number; url: string } }
  | { drive: false; reason: "not_sentinel" | "not_pull_request" | "out_of_scope" | "untrusted_author" };

export function isBotAuthor(author: FactoryDriveAuthor): boolean {
  return author.type === "Bot" || (author.login?.toLowerCase().endsWith("[bot]") ?? false);
}

/** `comment.author_association` from a webhook body, when the body carries one. */
export function payloadAuthorAssociation(payload: unknown): string | undefined {
  const comment = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)["comment"] : undefined;
  const association = typeof comment === "object" && comment !== null ? (comment as Record<string, unknown>)["author_association"] : undefined;
  return typeof association === "string" ? association : undefined;
}

// Host admission already limits deliveries to the channel's repos. The
// check is repeated because the dev HTTP route admits any repo, and a
// channel booted without a list (`cursorAccount: true`) has no scope of its
// own; an empty list drives nothing. The author is judged before the scope:
// `out_of_scope` is then a trusted person's comment on a repository the
// host delivered but the list omits, which the channel reports as a stale
// FACTORY_REPOS instead of dropping, and a stranger cannot raise that.
export function decideFactoryDrive(input: FactoryDriveInput): FactoryDriveDecision {
  if (!isFactoryDriveComment(input.body)) return { drive: false, reason: "not_sentinel" };
  if (input.conversation.kind !== "pull_request") return { drive: false, reason: "not_pull_request" };
  // The drive runs a cloud agent that can push to the PR head, so only an
  // owner, org member, or invited collaborator may start one, never a bot.
  if (isBotAuthor(input.author) || !TRUSTED_ASSOCIATIONS.has(input.author.association ?? "")) {
    return { drive: false, reason: "untrusted_author" };
  }
  const wanted = `${input.repository.owner}/${input.repository.name}`.toLowerCase();
  if (!input.repos.some((repo) => repo.toLowerCase() === wanted)) return { drive: false, reason: "out_of_scope" };
  return {
    drive: true,
    pr: {
      owner: input.repository.owner,
      repo: input.repository.name,
      number: input.conversation.number,
      url: input.conversation.url,
    },
  };
}
