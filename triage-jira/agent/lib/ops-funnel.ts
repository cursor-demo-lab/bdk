import { createHash } from "node:crypto";
import type { HostFilesApi, HostOtelApi, JsonValue } from "@cursor/july";
import { exportConfigured } from "./factory-otel.js";
import { factoryStage } from "./factory-stage.js";
import { factorySlug, opsAlertKey, type KeyedKv } from "./kv-keys.js";

// Structured kv warnings and the Slack ops failure funnel (KV Phase 1 K7).
//
// `warnKv(site, err)` replaces a silent catch on a kv call. It logs one JSON
// line, `{"kv":"warn","slug":…,"site":…,"status":…,"reasonCode":…,"message":…}`,
// and never throws, so the caller behaves exactly as before. The message is
// July's error text, cut to 200 characters with anything shaped like a token
// (Slack `xox*-` / `xapp-`, GitHub `gh?_` / `github_pat_`, a JWT, a Bearer
// header) masked; no value, Slack text or user id is logged. A best-effort
// Slack or Jira step beside a kv call reports with `warnStep(site, err)`
// instead: a `{"step":"warn"}` line and no funnel, so a `kv` line is always kv.
// A failure that is not kv but must still reach a person, because the usual
// place to say so is the thing that failed (the worker's Jira connector: no
// Jira comment can be written), reports with `warnOps({ site, kind,
// reasonCode })`: an `{"ops":"warn"}` line, and the funnel with the alert
// naming that kind instead of kv.
//
// Unexpected kv or claim failures also go to the funnel: a warnKv error that
// carries a hosted `reasonCode`, and every `unavailable` from the verified
// helpers (kv-verified.ts). The funnel posts one line per (slug, site,
// reason, and `subject` when given) per hour to `FACTORY_OPS_SLACK_CHANNEL` with
// `FACTORY_OPS_SLACK_BOT_TOKEN`, a separate low-scope bot (plan L8). It never
// uses the desk's Slack token. Dedupe:
// 1. A kv claim at `v1/ops-alert/<hash16>/<hour>` (read, then put), whose
//    value carries `exp` two hours on.
// 2. When kv fails, a create-only `host.files` write at the same path, which
//    also removes that signature's marker for the hour before, so files
//    markers stay at about one per signature.
// 3. When both fail, at most one line per execution, marked "dedupe
//    unavailable". An execution is one process: hosted runs one delivery per
//    pod, and a process serving several counts once.
// A post that fails releases the hour's marker (best effort), so the next
// execution tries again instead of the signature going quiet for an hour.
// No host bound counts as both stores failing. Either env unset (the ops bot
// does not exist yet): no post, and one `{"ops":"funnel_unconfigured"}` line
// per execution. An ops token equal to `FACTORY_DESK_SLACK_BOT_TOKEN` is
// refused the same way (`{"ops":"funnel_misconfigured"}`): the ops bot is a
// separate app. Nothing here can fail validate or deploy: both names are
// optional secrets.
// `FACTORY_OPS_FUNNEL=off` turns the funnel off, metrics included (the warn
// lines stay). Otherwise, with `OTEL_EXPORTER_OTLP_HEADERS` set (the OTLP
// switch, lib/factory-otel.ts) and a meter running, every funnel failure
// counts `apj_factory.kv.failure` on `host.otel`. Bind emits one
// `increment(..., 0, { ...OPS_METRIC_BASELINE, slug })` so the series exists
// before the first failure (`slug`: factorySlug, or `${factorySlug}-staging`
// when `FACTORY_ENV` is staging; `site`/`reason` `"none"`). July's
// `host.otel.increment` always adds `agent_sdk.agent` (the July project
// name), so the bind baseline matches a real failure's labels under scope
// `@cursor/july`. Queries should sum by (`slug`, `site`, `reason`).
// The funnel sees each helper call, not a caller's final outcome: an
// `unavailable` inside a caller's own retry loop that later succeeds still
// reports, and the hourly dedupe keeps it to one line.
//
// Hosts bind their services with `bindOpsFunnel(ctx.host)` at each entry point;
// host services are per deployment, never per delivery. Env is read per report,
// since hosted secrets reach process.env only with a request. A post runs in the
// background: an admission that returns first may lose it, and its warn line
// stays in the logs.
//
// Shared verbatim by all six agents (scripts/copies-parity.test.mjs); its test
// is factory-desk's ops-funnel.test.ts. Each agent's kv-keys.ts supplies
// factorySlug and opsAlertKey.

export const OPS_SLACK_TOKEN_ENV = "FACTORY_OPS_SLACK_BOT_TOKEN";
export const OPS_SLACK_CHANNEL_ENV = "FACTORY_OPS_SLACK_CHANNEL";
export const OPS_FUNNEL_ENV = "FACTORY_OPS_FUNNEL";
export const OPS_METRIC = "apj_factory.kv.failure";
/** site/reason bind sends. `slug` is always `slugOf(env)` — `factorySlug`, or `${factorySlug}-staging` when `FACTORY_ENV` is staging — so the zero series matches a real failure. July adds `agent_sdk.agent`. */
export const OPS_METRIC_BASELINE = { site: "none", reason: "none" };

const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";
const POST_TIMEOUT_MS = 5_000;
const MARKER_TTL_MS = 2 * 3_600_000;
const MESSAGE_MAX = 200;
const SEEN_MAX = 500;

/** The host services the funnel uses; ctx.host fits as is. */
export type OpsHost = {
  kv?: KeyedKv;
  files?: Pick<HostFilesApi, "write" | "remove">;
  otel?: Pick<HostOtelApi, "enabled" | "increment">;
};

/**
 * `kind` names what failed in the alert; absent, it is kv. `subject` names
 * what it concerns (a ticket, an agent id): it joins the dedupe key and the
 * alert text, never the metric, whose labels stay a fixed set.
 */
export type OpsFailure = { site: string; reasonCode?: string; status?: number; kind?: string; subject?: string };

export type OpsOutcome = "off" | "unconfigured" | "misconfigured" | "seen" | "deduped" | "posted" | "posted_undeduped" | "skipped_undeduped" | "post_failed";

export type OpsFunnelDeps = {
  /** Read on every report. Default `process.env`. */
  env?: () => NodeJS.ProcessEnv;
  now?: () => Date;
  fetch?: typeof fetch;
  /** Receives each JSON line. Default `console.warn`. */
  log?: (line: string) => void;
  /** How long one Slack post may take. Default 5 s. */
  postTimeoutMs?: number;
};

export type OpsFunnel = {
  bind(host: OpsHost | undefined): void;
  /** Runs the funnel for one failure; resolves, never rejects. */
  report(failure: OpsFailure): Promise<OpsOutcome>;
  warnKv(site: string, err: unknown): undefined;
  warnKvUnavailable(input: { site: string; error: unknown; logged?: boolean }): undefined;
  warnStep(site: string, err: unknown): undefined;
  warnOps(input: { site: string; kind: string; reasonCode: string; message?: string; subject?: string }): undefined;
  /** Resolves once every background report has finished. */
  settled(): Promise<void>;
};

type Described = { status?: number; reasonCode?: string; message?: string };

/** A failure's HTTP status and hosted reason code, and its message cut and masked. */
export function describeKvError(err: unknown): Described {
  if (typeof err === "string") return { message: maskMessage(err) };
  if (typeof err !== "object" || err === null) return {};
  const record = err as Record<string, unknown>;
  const status = record["status"];
  const reasonCode = record["reasonCode"];
  const message = record["message"];
  return {
    status: typeof status === "number" ? status : undefined,
    reasonCode: typeof reasonCode === "string" ? reasonCode.slice(0, 80) : undefined,
    message: typeof message === "string" ? maskMessage(message) : undefined,
  };
}

function maskMessage(message: string): string {
  return message
    .replace(/xox[a-z]-[A-Za-z0-9-]+/gi, "xox…")
    .replace(/xapp-[A-Za-z0-9-]+/gi, "xapp…")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat…")
    .replace(/\bgh[pousr]_[A-Za-z0-9]+/g, "gh…")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, "jwt…")
    .replace(/Bearer\s+\S+/gi, "Bearer …")
    .slice(0, MESSAGE_MAX);
}

function envValue(env: NodeJS.ProcessEnv, name: string): string {
  const value: unknown = env[name];
  return typeof value === "string" ? value.trim() : "";
}

function reasonOf(failure: OpsFailure): string {
  if (failure.reasonCode !== undefined && failure.reasonCode !== "") return failure.reasonCode;
  return failure.status === undefined ? "none" : `http_${failure.status}`;
}

function alertText(input: { slug: string; failure: OpsFailure; undeduped: boolean }): string {
  const { slug, failure } = input;
  const status = failure.status === undefined ? "" : `, HTTP ${failure.status}`;
  const lines = [
    `:rotating_light: ${slug}: ${failure.kind ?? "kv"} failure at \`${failure.site}\` (reason \`${reasonOf(failure)}\`${status})${failure.subject === undefined ? "" : ` for \`${failure.subject}\``}.`,
    input.undeduped
      ? "Dedupe unavailable (kv and files both failed), so this can repeat once per delivery."
      : `One line per site and reason${failure.subject === undefined ? "" : " and subject"} per hour; the slug's logs carry each {"kv":…} line.`,
  ];
  return lines.join("\n");
}

export function createOpsFunnel(deps: OpsFunnelDeps = {}): OpsFunnel {
  const readEnv = deps.env ?? (() => process.env);
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.warn(line));
  let host: OpsHost | undefined;
  let unconfiguredLogged = false;
  let misconfiguredLogged = false;
  let undedupedPosted = false;
  let baseline = false;
  const seen = new Set<string>();
  const pending = new Set<Promise<unknown>>();

  const warn = (fields: Record<string, JsonValue | undefined>): void => {
    try {
      log(JSON.stringify(fields));
    } catch {
      // Logging must not break the no-throw contract.
    }
  };

  const envNow = (): NodeJS.ProcessEnv => {
    try {
      return readEnv() ?? {};
    } catch {
      return {};
    }
  };

  const slugOf = (env: NodeJS.ProcessEnv): string => (factoryStage(env) === "staging" ? `${factorySlug}-staging` : factorySlug);

  const count = (input: { env: NodeJS.ProcessEnv; failure: OpsFailure; slug: string }): void => {
    if (!exportConfigured(input.env)) return;
    try {
      const otel = host?.otel;
      if (otel?.enabled === true) otel.increment(OPS_METRIC, { slug: input.slug, site: input.failure.site, reason: reasonOf(input.failure) });
    } catch {
      // A metric is optional.
    }
  };

  /** A zero sample so `apj_factory.kv.failure` exists before the first failure. */
  const emitBaseline = (env: NodeJS.ProcessEnv): void => {
    if (baseline || !exportConfigured(env) || envValue(env, OPS_FUNNEL_ENV).toLowerCase() === "off") return;
    try {
      const otel = host?.otel;
      if (otel?.enabled !== true) return;
      otel.increment(OPS_METRIC, 0, { ...OPS_METRIC_BASELINE, slug: slugOf(env) });
      baseline = true;
    } catch {
      // A metric is optional.
    }
  };

  /** Where this caller took the hour's marker, "held" when another has it, "failed" when neither store answered. */
  const claim = async (input: { key: ReturnType<typeof opsAlertKey>; previous: ReturnType<typeof opsAlertKey>; record: { [key: string]: JsonValue } }): Promise<"kv" | "files" | "held" | "failed"> => {
    const kv = host?.kv;
    if (kv !== undefined) {
      try {
        const current = await kv.get(input.key);
        if (current !== undefined && current !== null) return "held";
        await kv.put(input.key, input.record);
        return "kv";
      } catch (error) {
        warn({ ops: "dedupe_kv_failed", ...describeKvError(error) });
      }
    }
    const files = host?.files;
    if (files === undefined) return "failed";
    try {
      await files.write(String(input.key), JSON.stringify(input.record), { scope: "deployment", ifMatch: null });
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "FileConflictError") return "held";
      warn({ ops: "dedupe_files_failed", ...describeKvError(error) });
      return "failed";
    }
    try {
      await files.remove(String(input.previous), { scope: "deployment" });
    } catch (error) {
      warn({ ops: "marker_cleanup_failed", ...describeKvError(error) });
    }
    return "files";
  };

  /** A failed post gives the hour's marker back, so the next execution tries again. Best effort. */
  const release = async (input: { key: ReturnType<typeof opsAlertKey>; store: "kv" | "files" }): Promise<void> => {
    try {
      if (input.store === "kv") await host?.kv?.delete(input.key);
      else await host?.files?.remove(String(input.key), { scope: "deployment" });
    } catch (error) {
      warn({ ops: "marker_release_failed", store: input.store, ...describeKvError(error) });
    }
  };

  const post = async (input: { token: string; channel: string; text: string }): Promise<{ ok: boolean; error?: string }> => {
    try {
      const response = await (deps.fetch ?? fetch)(SLACK_POST_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel: input.channel, text: input.text, unfurl_links: false, unfurl_media: false }),
        signal: AbortSignal.timeout(deps.postTimeoutMs ?? POST_TIMEOUT_MS),
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      const ok = response.ok && typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
      const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
      return ok ? { ok } : { ok, error: typeof error === "string" ? error.slice(0, 80) : `http_${response.status}` };
    } catch (error) {
      return { ok: false, error: describeKvError(error).message ?? "fetch_failed" };
    }
  };

  const run = async (failure: OpsFailure): Promise<OpsOutcome> => {
    const env = envNow();
    const slug = slugOf(env);
    if (envValue(env, OPS_FUNNEL_ENV).toLowerCase() === "off") return "off";
    count({ env, failure, slug });
    const token = envValue(env, OPS_SLACK_TOKEN_ENV);
    const channel = envValue(env, OPS_SLACK_CHANNEL_ENV);
    if (token === "" || channel === "") {
      if (!unconfiguredLogged) {
        unconfiguredLogged = true;
        const missing = [token === "" ? OPS_SLACK_TOKEN_ENV : undefined, channel === "" ? OPS_SLACK_CHANNEL_ENV : undefined].filter((name): name is string => name !== undefined);
        warn({ ops: "funnel_unconfigured", slug, missing });
      }
      return "unconfigured";
    }
    if (token === envValue(env, "FACTORY_DESK_SLACK_BOT_TOKEN")) {
      if (!misconfiguredLogged) {
        misconfiguredLogged = true;
        warn({ ops: "funnel_misconfigured", slug, why: `${OPS_SLACK_TOKEN_ENV} is the desk's bot token; the ops bot must be a separate app` });
      }
      return "misconfigured";
    }
    const reason = reasonOf(failure);
    const at = now();
    const hour = at.toISOString().slice(0, 13);
    const previousHour = new Date(at.getTime() - 3_600_000).toISOString().slice(0, 13);
    const signed = failure.subject === undefined ? `${slug}\n${failure.site}\n${reason}` : `${slug}\n${failure.site}\n${reason}\n${failure.subject}`;
    const hash = createHash("sha256").update(signed).digest("hex").slice(0, 16);
    const signature = `${hash}/${hour}`;
    if (seen.has(signature)) return "seen";
    if (seen.size >= SEEN_MAX) seen.clear();
    seen.add(signature);
    const key = opsAlertKey({ hash, hour });
    const held = await claim({ key, previous: opsAlertKey({ hash, hour: previousHour }), record: { slug, site: failure.site, reason, at: at.toISOString(), exp: at.getTime() + MARKER_TTL_MS } });
    if (held === "held") {
      warn({ ops: "alert", outcome: "deduped", slug, site: failure.site, reason });
      return "deduped";
    }
    const undeduped = held === "failed";
    if (undeduped) {
      if (undedupedPosted) return "skipped_undeduped";
      undedupedPosted = true;
    }
    const posted = await post({ token, channel, text: alertText({ slug, failure, undeduped }) });
    const outcome: OpsOutcome = !posted.ok ? "post_failed" : undeduped ? "posted_undeduped" : "posted";
    warn({ ops: "alert", outcome, slug, site: failure.site, reason, subject: failure.subject, error: posted.error });
    if (!posted.ok && (held === "kv" || held === "files")) await release({ key, store: held });
    return outcome;
  };

  const report = async (failure: OpsFailure): Promise<OpsOutcome> => {
    try {
      return await run(failure);
    } catch (error) {
      warn({ ops: "funnel_failed", ...describeKvError(error) });
      return "post_failed";
    }
  };

  const track = (failure: OpsFailure): void => {
    const promise = report(failure);
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  };

  return {
    bind(next) {
      if (next !== undefined) host = next;
      emitBaseline(envNow());
    },
    report,
    warnKv(site, err) {
      try {
        const described = describeKvError(err);
        warn({ kv: "warn", slug: slugOf(envNow()), site, ...described });
        if (described.reasonCode !== undefined) track({ site, reasonCode: described.reasonCode, status: described.status });
      } catch {
        // warnKv never throws.
      }
      return undefined;
    },
    warnKvUnavailable({ site, error, logged }) {
      try {
        const described = describeKvError(error);
        if (logged !== true) warn({ kv: "unavailable", slug: slugOf(envNow()), site, ...described });
        track({ site, reasonCode: described.reasonCode, status: described.status });
      } catch {
        // Never throws.
      }
      return undefined;
    },
    warnStep(site, err) {
      try {
        const { status, message } = describeKvError(err);
        warn({ step: "warn", slug: slugOf(envNow()), site, status, message });
      } catch {
        // Never throws.
      }
      return undefined;
    },
    warnOps({ site, kind, reasonCode, message, subject }) {
      try {
        const about = subject === undefined ? {} : { subject: maskMessage(subject).slice(0, 120) };
        warn({ ops: "warn", slug: slugOf(envNow()), site, kind, reasonCode, ...about, ...(message === undefined ? {} : { message: maskMessage(message) }) });
        track({ site, kind, reasonCode, ...about });
      } catch {
        // Never throws.
      }
      return undefined;
    },
    async settled() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}

const FUNNEL = createOpsFunnel();

/** Hands the funnel this deployment's kv, files and otel (ctx.host). Safe to call on every delivery. */
export function bindOpsFunnel(host: OpsHost | undefined): void {
  try {
    FUNNEL.bind(host);
  } catch {
    // Binding must never break a handler.
  }
}

/** One structured warning line for a swallowed kv failure, and the funnel when it carries a reason code. Returns undefined. */
export function warnKv(site: string, err: unknown): undefined {
  return FUNNEL.warnKv(site, err);
}

/** A verified helper's `unavailable`: a warning line unless the helper already logged why, and always the funnel. */
export function warnKvUnavailable(input: { site: string; error: unknown; logged?: boolean }): undefined {
  return FUNNEL.warnKvUnavailable(input);
}

/** One structured line for a best-effort non-kv step (Slack, Jira) that failed beside a kv call. No funnel. Returns undefined. */
export function warnStep(site: string, err: unknown): undefined {
  return FUNNEL.warnStep(site, err);
}

/** A non-kv failure a person must hear about through ops Slack (one line per site and reason per hour). Returns undefined. */
export function warnOps(input: { site: string; kind: string; reasonCode: string; message?: string; subject?: string }): undefined {
  return FUNNEL.warnOps(input);
}

/** Resolves once every background funnel report has finished (tests, and a handler that wants its alert out first). */
export function opsFunnelSettled(): Promise<void> {
  return FUNNEL.settled();
}
