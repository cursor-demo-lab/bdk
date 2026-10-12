import { deskSlackHandle } from "./config.js";
import { factoryStage, refusesProductionTarget, withoutProductionTargets } from "./factory-stage.js";

// The channels whose every post wakes the desk (slack.ts `engagement.channelPosts`).
// In these, and in a DM, a plain `approve KEY` reply in a factory thread
// reaches the desk; anywhere else only a mention does, so copy that asks
// for a reply must say which.
export const WATCHED_CHANNELS = ["C0EXAMPLE1", "#mars-eng-intake"] as const;

/** FACTORY_DESK_INTAKE_CHANNEL, trimmed; undefined when unset or a production channel this staging slug refuses (factory-stage.ts). */
export function intakeChannel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env["FACTORY_DESK_INTAKE_CHANNEL"]?.trim() ?? "";
  if (raw === "" || refusesProductionTarget(env, { kind: "slackChannels", value: raw })) return undefined;
  return raw;
}

/**
 * The watched channels a plain reply can reach on this slug. The manifest
 * subscribes WATCHED_CHANNELS on every stage (slack.ts), so a staging slug
 * keeps only the ones FACTORY_STAGING_ALLOW_PRODUCTION names, usually none.
 */
export function watchedChannels(env: NodeJS.ProcessEnv = process.env): string[] {
  return withoutProductionTargets(env, { kind: "slackChannels", values: WATCHED_CHANNELS });
}

/**
 * A DM, a watched channel, or on production the intake channel. A staging
 * intake channel is not in the manifest, so a plain reply there never
 * arrives and copy keeps the mention.
 */
export function bareReplyReaches(channelId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (channelId.startsWith("D")) return true;
  if (watchedChannels(env).includes(channelId)) return true;
  return factoryStage(env) === "production" && intakeChannel(env) === channelId;
}

/**
 * What in-thread copy writes before a command: nothing where a plain reply
 * reaches the desk (`approve file`), the mention in a channel the desk does
 * not watch (`@factory approve file`), where a plain reply never arrives.
 * A thread the caller cannot place is taken to be one the desk watches.
 */
export function replyPrefix(channelId: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return channelId === undefined || channelId === "" || bareReplyReaches(channelId, env) ? "" : `${deskSlackHandle(env)} `;
}
