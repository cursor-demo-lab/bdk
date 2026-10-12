// A staging desk refuses to run on the production Slack app. A copied
// FACTORY_DESK_SLACK_BOT_TOKEN would make every staging post (a thread reply,
// an intake root, a review update) come from the production Factory app, so
// on staging the desk asks Slack which app its token belongs to (auth.test
// names the bot, bots.info names its app) and, when that is a production app
// (factory-stage.ts `slackApps`), takes no Slack event, Jira delivery, or
// review wake, and says so on stderr. Production never asks.
//
// Hosted secrets are bound per request, so the token can change without a
// restart. The answer is cached under the SHA-256 of the token the client
// holds (the raw token is never stored or logged); a different token is
// looked up again. A failed lookup is asked again next time and refuses
// nothing.

import { createHash } from "node:crypto";
import { factoryStage, refusesProductionTarget } from "./factory-stage.js";

type SlackClient = { token?: string; apiCall(method: string, args?: Record<string, unknown>): Promise<unknown> };
export type SlackAppHost = { slack?: { getClient(): Promise<SlackClient> } };

let known: { tokenHash: string; appId: string } | undefined;
const asking = new Map<string, Promise<string | undefined>>();

function tokenHash(client: SlackClient): string {
  const token = client.token ?? process.env.FACTORY_DESK_SLACK_BOT_TOKEN ?? "";
  return createHash("sha256").update(token).digest("hex");
}

async function lookUpAppId(client: SlackClient): Promise<string | undefined> {
  const auth = (await client.apiCall("auth.test", {})) as { ok?: boolean; bot_id?: unknown };
  if (auth.ok !== true || typeof auth.bot_id !== "string") return undefined;
  const info = (await client.apiCall("bots.info", { bot: auth.bot_id })) as { ok?: boolean; bot?: { app_id?: unknown } };
  return info.ok === true && typeof info.bot?.app_id === "string" ? info.bot.app_id : undefined;
}

/** The Slack app id the desk's current bot token belongs to, or undefined when it cannot be read. */
export async function slackAppId(host: SlackAppHost | undefined): Promise<string | undefined> {
  if (host?.slack === undefined) return undefined;
  let client: SlackClient;
  try {
    client = await host.slack.getClient();
  } catch {
    return undefined;
  }
  const hash = tokenHash(client);
  if (known?.tokenHash === hash) return known.appId;
  let pending = asking.get(hash);
  if (pending === undefined) {
    pending = lookUpAppId(client)
      .then((appId) => {
        if (appId !== undefined) known = { tokenHash: hash, appId };
        return appId;
      })
      .catch(() => undefined)
      .finally(() => asking.delete(hash));
    asking.set(hash, pending);
  }
  return pending;
}

/** True on a staging slug whose Slack token is a production app's; logs the refusal loudly. Always false on production. */
export async function stagingRefusesSlackApp(host: SlackAppHost | undefined, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (factoryStage(env) === "production") return false;
  const appId = await slackAppId(host);
  if (appId === undefined || !refusesProductionTarget(env, { kind: "slackApps", value: appId })) return false;
  console.error(JSON.stringify({ desk: "staging_refused", slackApp: appId, why: "FACTORY_DESK_SLACK_BOT_TOKEN is the production Slack app's token; set the staging app's token (docs/factory-deployment.md §10)" }));
  return true;
}

/** Tests only. */
export function resetSlackAppId(): void {
  known = undefined;
  asking.clear();
}
