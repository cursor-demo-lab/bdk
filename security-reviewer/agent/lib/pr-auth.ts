import type { AuthContext } from "@cursor/july";

// A session is bound to the principal that started it, and July's default is
// the event sender. A push by anyone other than the PR opener would then be
// refused as a different principal, so the review session is owned by the PR.
export function prReviewAuth(auth: AuthContext | null, fullName: string, number: number): AuthContext | null {
  if (auth === null) return null;
  return { ...auth, principalId: `github-pr:${fullName}#${number}`, principalType: "service" };
}
