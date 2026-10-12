// The bot's own Slack identity for host copy (`deskSlackHandle`): its user id
// and the `auth.test` username. The desk reads `auth.test` itself through the
// host client instead of July's `resolveSlackSelfIdentity`, which since July
// 0.2.12 names the bot from its `users.info` profile (display name, then real
// name) and keeps the `auth.test` username only when that lookup fails. The
// handle people type stays the username, whatever the profile says; July's
// `self_name` in `<slack_context>` may differ, and the model is told to write
// the `<slack_reply>` handle, never `@` plus `self_name`.

import { deskSelfIdentity, setDeskSelfIdentity, type DeskSelfIdentity } from "./config.js";

type SlackHost = { slack?: { getClient(): Promise<{ apiCall(method: string, args?: Record<string, unknown>): Promise<unknown> }> } };

let learning: Promise<DeskSelfIdentity | undefined> | undefined;

async function readAuthTest(host: Required<SlackHost>): Promise<DeskSelfIdentity | undefined> {
  const result = (await (await host.slack.getClient()).apiCall("auth.test", {})) as Record<string, unknown> | undefined;
  const userId = typeof result?.["user_id"] === "string" ? result["user_id"] : "";
  if (result?.["ok"] !== true || userId === "") return undefined;
  const name = result["user"];
  return typeof name === "string" && name !== "" ? { userId, name } : { userId };
}

/**
 * Reads the bot's user id and username once and keeps them in config. Never
 * throws; a failure leaves the fallback handle and is asked again on the
 * next call. One request at a time: `@slack/web-api` retries for minutes.
 */
export function learnDeskSelfIdentity(host: SlackHost | undefined): Promise<DeskSelfIdentity | undefined> {
  const known = deskSelfIdentity();
  if (known !== undefined) return Promise.resolve(known);
  if (host?.slack === undefined) return Promise.resolve(undefined);
  learning ??= readAuthTest(host as Required<SlackHost>)
    .then((identity) => {
      if (identity !== undefined) setDeskSelfIdentity(identity);
      return identity;
    })
    .catch(() => undefined)
    .finally(() => {
      learning = undefined;
    });
  return learning;
}

/** Tests only. */
export function resetDeskSelfIdentity(): void {
  setDeskSelfIdentity(undefined);
  learning = undefined;
}
