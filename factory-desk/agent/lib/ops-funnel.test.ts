import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@cursor/july";
import { updateVerified } from "./kv-verified.js";
import { factorySlug, opsAlertKey, ticketKey, type KeyedKv, type KvKey } from "./kv-keys.js";
import { bindOpsFunnel, createOpsFunnel, describeKvError, OPS_METRIC, OPS_METRIC_BASELINE, opsFunnelSettled, warnKv, type OpsFunnelDeps, type OpsHost } from "./ops-funnel.js";

// The shared ops funnel (every agent carries a byte-identical copy,
// scripts/copies-parity.test.mjs). Each createOpsFunnel is one execution:
// its own "dedupe unavailable" and "not configured" once-flags.

const CONFIGURED = { FACTORY_OPS_SLACK_BOT_TOKEN: "xoxb-ops-test", FACTORY_OPS_SLACK_CHANNEL: "C0OPS" };
const HOUR = new Date("2026-09-29T05:10:00Z");

function storageError(input: { reasonCode?: string; status?: number; message?: string }): Error {
  return Object.assign(new Error(input.message ?? "cursorHostedStorage /kv/get: boom"), input);
}

type FakeKv = KeyedKv & { rows: Map<string, JsonValue>; calls: string[] };

function fakeKv(options: { down?: boolean } = {}): FakeKv {
  const rows = new Map<string, JsonValue>();
  const calls: string[] = [];
  const fail = (op: string) => {
    calls.push(op);
    if (options.down === true) throw storageError({ reasonCode: "agentsdk_storage_http_error", status: 503 });
  };
  return {
    rows,
    calls,
    async get(key: KvKey) {
      fail("get");
      return rows.get(key);
    },
    async put(key: KvKey, value: JsonValue) {
      fail("put");
      rows.set(key, value);
    },
    async delete(key: KvKey) {
      fail("delete");
      rows.delete(key);
    },
  };
}

type FakeFiles = NonNullable<OpsHost["files"]> & { paths: Map<string, string>; removed: string[] };

function fakeFiles(options: { down?: boolean } = {}): FakeFiles {
  const paths = new Map<string, string>();
  const removed: string[] = [];
  return {
    paths,
    removed,
    async write(path: string, data: string | Uint8Array, call?: { ifMatch?: string | null }) {
      if (options.down === true) throw new Error("host.files unavailable");
      if (call?.ifMatch === null && paths.has(path)) throw Object.assign(new Error(`host.files write for "${path}" lost a race`), { name: "FileConflictError" });
      paths.set(path, String(data));
    },
    async remove(path: string) {
      if (options.down === true) throw new Error("host.files unavailable");
      removed.push(path);
      paths.delete(path);
    },
  };
}

type Posted = { url: string; authorization: string | undefined; body: { channel?: string; text?: string } };

function slackStub(options: { ok?: boolean } = {}): { fetch: typeof fetch; posts: Posted[] } {
  const posts: Posted[] = [];
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    posts.push({ url: String(input), authorization: headers.get("authorization") ?? undefined, body: JSON.parse(String(init?.body)) });
    return Response.json(options.ok === false ? { ok: false, error: "channel_not_found" } : { ok: true });
  };
  return { fetch: stub as typeof fetch, posts };
}

function execution(input: { env?: NodeJS.ProcessEnv; host?: OpsHost; fetch?: typeof fetch; now?: () => Date; postTimeoutMs?: number }) {
  const lines: string[] = [];
  const deps: OpsFunnelDeps = { env: () => input.env ?? CONFIGURED, now: input.now ?? (() => HOUR), log: (line) => lines.push(line) };
  if (input.fetch !== undefined) deps.fetch = input.fetch;
  if (input.postTimeoutMs !== undefined) deps.postTimeoutMs = input.postTimeoutMs;
  const funnel = createOpsFunnel(deps);
  funnel.bind(input.host);
  return { funnel, lines, parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

const FAILURE = { site: "plan-move.moveToPlanner", reasonCode: "agentsdk_kv_key_invalid", status: 400 };

test("dedupe: one post per (slug, site, reason) per hour, across executions sharing kv", async () => {
  const kv = fakeKv();
  const slack = slackStub();
  const first = execution({ host: { kv }, fetch: slack.fetch });
  assert.equal(await first.funnel.report(FAILURE), "posted");
  assert.equal(await first.funnel.report(FAILURE), "seen", "a second report in the same execution asks kv nothing");
  assert.equal(await execution({ host: { kv }, fetch: slack.fetch }).funnel.report(FAILURE), "deduped");
  assert.equal(slack.posts.length, 1);
  assert.equal(await execution({ host: { kv }, fetch: slack.fetch }).funnel.report({ ...FAILURE, site: "hop-watch.readTriagedSince" }), "posted", "another site is another signature");
  assert.equal(await execution({ host: { kv }, fetch: slack.fetch }).funnel.report({ ...FAILURE, reasonCode: "agentsdk_storage_http_error" }), "posted", "another reason too");
  const nextHour = execution({ host: { kv }, fetch: slack.fetch, now: () => new Date("2026-09-29T06:00:00Z") });
  assert.equal(await nextHour.funnel.report(FAILURE), "posted", "the next hour posts again");
  assert.equal(slack.posts.length, 4);
  const keys = [...kv.rows.keys()];
  assert.ok(keys.every((key) => /^v1\/ops-alert\/[0-9a-f]{16}\/2026-09-29T0[56]$/.test(key)), keys.join(", "));
  assert.ok(keys.includes(opsAlertKey({ hash: keys[0]!.split("/")[2]!, hour: "2026-09-29T05" })));
});

test("the post goes to FACTORY_OPS_SLACK_CHANNEL with FACTORY_OPS_SLACK_BOT_TOKEN and names slug, site, reason and status only", async () => {
  const slack = slackStub();
  const run = execution({ env: { ...CONFIGURED, FACTORY_DESK_SLACK_BOT_TOKEN: "xoxb-desk" }, host: { kv: fakeKv() }, fetch: slack.fetch });
  await run.funnel.report(FAILURE);
  const [post] = slack.posts;
  assert.equal(post?.url, "https://slack.com/api/chat.postMessage");
  assert.equal(post?.authorization, "Bearer xoxb-ops-test");
  assert.equal(post?.body.channel, "C0OPS");
  assert.match(post?.body.text ?? "", new RegExp(`^:rotating_light: ${factorySlug}: kv failure at \`plan-move\\.moveToPlanner\` \\(reason \`agentsdk_kv_key_invalid\`, HTTP 400\\)\\.`));
  assert.doesNotMatch(post?.body.text ?? "", /Dedupe unavailable/);
  assert.equal(run.parsed().at(-1)?.["outcome"], "posted");
  assert.ok(!run.lines.join("\n").includes("xoxb-"), "no token in any log line");
});

test("a staging slug names itself with -staging", async () => {
  const slack = slackStub();
  await execution({ env: { ...CONFIGURED, FACTORY_ENV: "staging" }, host: { kv: fakeKv() }, fetch: slack.fetch }).funnel.report(FAILURE);
  assert.match(slack.posts[0]?.body.text ?? "", new RegExp(`^:rotating_light: ${factorySlug}-staging:`));
});

test("kv down: the files create-only marker dedupes instead", async () => {
  const files = fakeFiles();
  const slack = slackStub();
  const first = execution({ host: { kv: fakeKv({ down: true }), files }, fetch: slack.fetch });
  assert.equal(await first.funnel.report(FAILURE), "posted");
  assert.deepEqual([...files.paths.keys()].map((path) => path.replace(/[0-9a-f]{16}/, "<hash>")), ["v1/ops-alert/<hash>/2026-09-29T05"]);
  assert.equal(await execution({ host: { kv: fakeKv({ down: true }), files }, fetch: slack.fetch }).funnel.report(FAILURE), "deduped");
  assert.equal(slack.posts.length, 1);
  assert.doesNotMatch(slack.posts[0]?.body.text ?? "", /Dedupe unavailable/);
  assert.equal(first.parsed()[0]?.["ops"], "dedupe_kv_failed");
});

test("kv and files both down: at most one line per execution, marked dedupe unavailable", async () => {
  const slack = slackStub();
  const host = { kv: fakeKv({ down: true }), files: fakeFiles({ down: true }) };
  const first = execution({ host, fetch: slack.fetch });
  assert.equal(await first.funnel.report(FAILURE), "posted_undeduped");
  assert.equal(await first.funnel.report({ ...FAILURE, site: "hop-watch.readTriagedSince" }), "skipped_undeduped");
  assert.equal(await first.funnel.report({ ...FAILURE, reasonCode: "agentsdk_storage_http_error" }), "skipped_undeduped");
  assert.equal(slack.posts.length, 1);
  assert.match(slack.posts[0]?.body.text ?? "", /Dedupe unavailable \(kv and files both failed\)/);
  assert.equal(await execution({ host, fetch: slack.fetch }).funnel.report(FAILURE), "posted_undeduped", "the next execution posts its one line");
  assert.equal(slack.posts.length, 2);
});

test("no host bound counts as both stores down", async () => {
  const slack = slackStub();
  const run = execution({ fetch: slack.fetch });
  assert.equal(await run.funnel.report(FAILURE), "posted_undeduped");
  assert.equal(await run.funnel.report(FAILURE), "seen");
  assert.equal(slack.posts.length, 1);
});

test("unconfigured token or channel: nothing posted, nothing stored, one log line per execution, never the desk token", async () => {
  const cases: NodeJS.ProcessEnv[] = [
    {},
    { FACTORY_OPS_SLACK_BOT_TOKEN: "xoxb-ops-test" },
    { FACTORY_OPS_SLACK_CHANNEL: "C0OPS", FACTORY_DESK_SLACK_BOT_TOKEN: "xoxb-desk", FACTORY_DESK_SLACK_APP_TOKEN: "xapp-desk" },
    { FACTORY_OPS_SLACK_BOT_TOKEN: "   ", FACTORY_OPS_SLACK_CHANNEL: "C0OPS" },
  ];
  for (const env of cases) {
    const kv = fakeKv();
    const files = fakeFiles();
    const slack = slackStub();
    const run = execution({ env, host: { kv, files }, fetch: slack.fetch });
    assert.equal(await run.funnel.report(FAILURE), "unconfigured");
    assert.equal(await run.funnel.report({ ...FAILURE, site: "other" }), "unconfigured");
    assert.equal(run.funnel.warnKv("plan-move.moveToPlanner", storageError({ reasonCode: "agentsdk_kv_key_invalid" })), undefined);
    await run.funnel.settled();
    assert.equal(slack.posts.length, 0, JSON.stringify(env));
    assert.deepEqual(kv.calls, []);
    assert.equal(files.paths.size, 0);
    const unconfigured = run.parsed().filter((line) => line["ops"] === "funnel_unconfigured");
    assert.equal(unconfigured.length, 1);
    const missing = unconfigured[0]?.["missing"] as string[];
    assert.ok(missing.length > 0 && missing.every((name) => name.startsWith("FACTORY_OPS_SLACK_")), JSON.stringify(missing));
  }
});

test("the funnel never throws: a throwing env, log, fetch, kv and files", async () => {
  const throwing = createOpsFunnel({
    env: () => {
      throw new Error("env");
    },
    log: () => {
      throw new Error("log");
    },
  });
  assert.equal(throwing.warnKv("site", storageError({ reasonCode: "agentsdk_kv_key_invalid" })), undefined);
  assert.equal(await throwing.report(FAILURE), "unconfigured");
  const down = createOpsFunnel({
    env: () => CONFIGURED,
    fetch: (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch,
    log: () => undefined,
  });
  down.bind({ kv: fakeKv({ down: true }), files: fakeFiles({ down: true }) });
  assert.equal(await down.report(FAILURE), "post_failed");
  assert.equal(down.warnKv("site", Symbol("odd")), undefined);
  assert.equal(down.warnKvUnavailable({ site: "kv-verified.update/ticket", error: undefined }), undefined);
  await down.settled();
});

test("a failed post releases the hour's marker, so the next execution posts", async () => {
  const kv = fakeKv();
  const refused = execution({ host: { kv }, fetch: slackStub({ ok: false }).fetch });
  assert.equal(await refused.funnel.report(FAILURE), "post_failed");
  assert.deepEqual(refused.parsed().at(-1), { ops: "alert", outcome: "post_failed", slug: factorySlug, site: FAILURE.site, reason: FAILURE.reasonCode, error: "channel_not_found" });
  assert.equal(kv.rows.size, 0, "the kv marker is deleted");
  assert.equal(await refused.funnel.report(FAILURE), "seen", "the same execution stays quiet");
  const slack = slackStub();
  assert.equal(await execution({ host: { kv }, fetch: slack.fetch }).funnel.report(FAILURE), "posted");
  assert.equal(slack.posts.length, 1);

  const files = fakeFiles();
  const viaFiles = execution({ host: { kv: fakeKv({ down: true }), files }, fetch: slackStub({ ok: false }).fetch });
  assert.equal(await viaFiles.funnel.report(FAILURE), "post_failed");
  assert.equal(files.paths.size, 0, "the files marker is removed");
  assert.equal(await execution({ host: { kv: fakeKv({ down: true }), files }, fetch: slackStub().fetch }).funnel.report(FAILURE), "posted");
});

test("a post that throws is post_failed with its error on the alert line", async () => {
  const run = execution({
    host: { kv: fakeKv() },
    fetch: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  assert.equal(await run.funnel.report(FAILURE), "post_failed");
  const alert = run.parsed().at(-1);
  assert.equal(alert?.["ops"], "alert");
  assert.equal(alert?.["outcome"], "post_failed");
  assert.equal(alert?.["error"], "fetch failed");
  assert.ok(!run.parsed().some((line) => line["ops"] === "funnel_failed"));
});

test("a hanging post is cut off at the post timeout", { timeout: 5_000 }, async () => {
  const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
  const run = execution({ host: { kv: fakeKv() }, fetch: hanging, postTimeoutMs: 20 });
  const started = Date.now();
  // AbortSignal.timeout's timer is unref'd; a served process keeps the loop alive, a test must.
  const keepAlive = setInterval(() => undefined, 10);
  try {
    assert.equal(await run.funnel.report(FAILURE), "post_failed");
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(Date.now() - started < 2_000, "cut off well before the 5 s default");
  assert.match(String(run.parsed().at(-1)?.["error"]), /timeout|abort/i);
});

test("an ops token equal to the desk's bot token is refused: no post, one funnel_misconfigured line per execution", async () => {
  const kv = fakeKv();
  const slack = slackStub();
  const run = execution({ env: { ...CONFIGURED, FACTORY_DESK_SLACK_BOT_TOKEN: " xoxb-ops-test " }, host: { kv }, fetch: slack.fetch });
  assert.equal(await run.funnel.report(FAILURE), "misconfigured");
  assert.equal(await run.funnel.report({ ...FAILURE, site: "other" }), "misconfigured");
  assert.equal(slack.posts.length, 0);
  assert.deepEqual(kv.calls, []);
  const lines = run.parsed().filter((line) => line["ops"] === "funnel_misconfigured");
  assert.equal(lines.length, 1);
  assert.ok(!JSON.stringify(lines).includes("xoxb-"));
});

test("a files marker whose previous-hour cleanup throws still posts, with one marker_cleanup_failed line", async () => {
  const files = fakeFiles();
  const brittle: FakeFiles = {
    ...files,
    remove: async () => {
      throw new Error("host.files remove refused");
    },
  };
  const slack = slackStub();
  const run = execution({ host: { kv: fakeKv({ down: true }), files: brittle }, fetch: slack.fetch });
  assert.equal(await run.funnel.report(FAILURE), "posted");
  assert.equal(slack.posts.length, 1);
  const cleanup = run.parsed().filter((line) => line["ops"] === "marker_cleanup_failed");
  assert.equal(cleanup.length, 1);
  assert.equal(cleanup[0]?.["message"], "host.files remove refused");
});

test("markers: the kv value expires two hours on; a files marker removes that signature's marker for the hour before", async () => {
  const kv = fakeKv();
  await execution({ host: { kv }, fetch: slackStub().fetch }).funnel.report(FAILURE);
  const [value] = [...kv.rows.values()] as Array<{ exp?: unknown; at?: unknown }>;
  assert.equal(value?.exp, HOUR.getTime() + 2 * 3_600_000);
  assert.equal(value?.at, HOUR.toISOString());
  const files = fakeFiles();
  await execution({ host: { kv: fakeKv({ down: true }), files }, fetch: slackStub().fetch }).funnel.report(FAILURE);
  const [path] = [...files.paths.keys()];
  assert.equal(JSON.parse(files.paths.get(path!)!).exp, HOUR.getTime() + 2 * 3_600_000);
  assert.deepEqual(files.removed, [path!.replace("2026-09-29T05", "2026-09-29T04")]);
});

test("kill switch: FACTORY_OPS_FUNNEL=off posts and stores nothing; the warn line stays", async () => {
  for (const value of ["off", " OFF "]) {
    const kv = fakeKv();
    const slack = slackStub();
    const run = execution({ env: { ...CONFIGURED, FACTORY_OPS_FUNNEL: value }, host: { kv }, fetch: slack.fetch });
    assert.equal(await run.funnel.report(FAILURE), "off");
    run.funnel.warnKv("plan-move.moveToPlanner", storageError({ reasonCode: "agentsdk_kv_key_invalid" }));
    await run.funnel.settled();
    assert.equal(slack.posts.length, 0);
    assert.deepEqual(kv.calls, []);
    assert.deepEqual(run.parsed().map((line) => line["kv"] ?? line["ops"]), ["warn"]);
  }
  const counted: string[] = [];
  const otel = { enabled: true, increment: (name: string) => void counted.push(name) } as unknown as NonNullable<OpsHost["otel"]>;
  await execution({ env: { ...CONFIGURED, FACTORY_OPS_FUNNEL: "off", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic dGVzdA==" }, host: { otel } }).funnel.report(FAILURE);
  assert.deepEqual(counted, [], "off counts no metric either");
  const on = slackStub();
  assert.equal(await execution({ env: { ...CONFIGURED, FACTORY_OPS_FUNNEL: "on" }, host: { kv: fakeKv() }, fetch: on.fetch }).funnel.report(FAILURE), "posted");
});

test("warnKv: one structured line (slug, site, status, reasonCode, masked message) and the funnel only for a reason code", async () => {
  const slack = slackStub();
  const run = execution({ host: { kv: fakeKv() }, fetch: slack.fetch });
  const long = `cursorHostedStorage /kv/put: Bearer abc.def refused xoxb-123-456 ${"x".repeat(400)}`;
  assert.equal(run.funnel.warnKv("intake-triage.stashIntakeTriage", storageError({ reasonCode: "agentsdk_kv_value_invalid", status: 400, message: long })), undefined);
  assert.equal(run.funnel.warnKv("thread-detail.readAwaiting", new TypeError("fetch failed")), undefined);
  await run.funnel.settled();
  const [first, second] = run.parsed();
  assert.deepEqual(Object.keys(first ?? {}).sort(), ["kv", "message", "reasonCode", "site", "slug", "status"]);
  assert.equal(first?.["kv"], "warn");
  assert.equal(first?.["slug"], factorySlug);
  assert.equal(first?.["site"], "intake-triage.stashIntakeTriage");
  assert.equal(first?.["status"], 400);
  assert.equal(first?.["reasonCode"], "agentsdk_kv_value_invalid");
  assert.ok(String(first?.["message"]).length <= 200);
  assert.doesNotMatch(String(first?.["message"]), /abc\.def|xoxb-123/);
  // Assembled at run time so no token-shaped literal sits in the source for secret scanners.
  const shaped = (parts: readonly string[]) => parts.join("");
  const secrets = [
    shaped(["xa", "pp-1-A0-123-abc"]),
    shaped(["gh", "p_abcdefghij0123"]),
    shaped(["gh", "o_zz9"]),
    shaped(["github", "_pat_11AB_cd"]),
    shaped(["ey", "JhbGciOi.", "ey", "JzdWIiOi.c2lnbmF0dXJl"]),
    "Bearer t0k",
  ].join(" ");
  const masked = describeKvError(new Error(secrets)).message ?? "";
  for (const leak of ["xapp-1", "ghp_", "gho_", "github_pat_11", "eyJhbGciOi", "c2lnbmF0dXJl", "t0k"]) assert.ok(!masked.includes(leak), `${leak} leaked: ${masked}`);
  assert.deepEqual(second, { kv: "warn", slug: factorySlug, site: "thread-detail.readAwaiting", message: "fetch failed" });
  assert.equal(slack.posts.length, 1, "only the failure with a reason code reached the funnel");
  assert.match(slack.posts[0]?.body.text ?? "", /intake-triage\.stashIntakeTriage/);
});

test("describeKvError reads status and reason code, and nothing else", () => {
  assert.deepEqual(describeKvError(storageError({ reasonCode: "agentsdk_kv_key_invalid", status: 400, message: "m" })), { status: 400, reasonCode: "agentsdk_kv_key_invalid", message: "m" });
  assert.deepEqual(describeKvError("plain"), { message: "plain" });
  assert.deepEqual(describeKvError(undefined), {});
  assert.deepEqual(describeKvError({ status: "400", reasonCode: 7, value: "slack text" }), { status: undefined, reasonCode: undefined, message: undefined });
});

function recordIncrement(counted: Array<{ name: string; value?: number; attributes?: Record<string, unknown> }>): NonNullable<OpsHost["otel"]> {
  return {
    enabled: true,
    increment: (name: string, valueOrAttrs?: number | Record<string, unknown>, attrs?: Record<string, unknown>) => {
      if (typeof valueOrAttrs === "number") counted.push({ name, value: valueOrAttrs, ...(attrs === undefined ? {} : { attributes: attrs }) });
      else counted.push({ name, attributes: valueOrAttrs });
    },
  } as unknown as NonNullable<OpsHost["otel"]>;
}

test("metrics: counted only with OTEL_EXPORTER_OTLP_HEADERS set and a meter running", async () => {
  const counted: Array<{ name: string; value?: number; attributes?: Record<string, unknown> }> = [];
  const otel = recordIncrement(counted);
  await execution({ env: {}, host: { otel } }).funnel.report(FAILURE);
  assert.equal(counted.length, 0);
  await execution({ env: { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic dGVzdA==" }, host: { otel } }).funnel.report(FAILURE);
  assert.deepEqual(counted, [
    { name: OPS_METRIC, value: 0, attributes: { ...OPS_METRIC_BASELINE, slug: factorySlug } },
    { name: OPS_METRIC, attributes: { slug: factorySlug, site: FAILURE.site, reason: FAILURE.reasonCode } },
  ]);
  const idle = { ...otel, enabled: false } as NonNullable<OpsHost["otel"]>;
  await execution({ env: { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic dGVzdA==" }, host: { otel: idle } }).funnel.report(FAILURE);
  assert.equal(counted.length, 2);
});

test("bind emits a zero baseline for apj_factory.kv.failure once, before any failure", async () => {
  const counted: Array<{ name: string; value?: number; attributes?: Record<string, unknown> }> = [];
  const otel = recordIncrement(counted);
  const env = { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic dGVzdA==" };
  const run = execution({ env, host: { otel } });
  run.funnel.bind({ otel });
  assert.deepEqual(counted, [{ name: OPS_METRIC, value: 0, attributes: { ...OPS_METRIC_BASELINE, slug: factorySlug } }]);
});

for (const [label, envExtra, slug] of [
  ["production", {}, factorySlug],
  ["staging", { FACTORY_ENV: "staging" }, `${factorySlug}-staging`],
] as const) {
  test(`bind baseline slug matches a ${label} failure`, async () => {
    const counted: Array<{ name: string; value?: number; attributes?: Record<string, unknown> }> = [];
    const otel = recordIncrement(counted);
    const env = { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic dGVzdA==", ...envExtra };
    const run = execution({ env, host: { otel } });
    run.funnel.bind({ otel });
    await run.funnel.report(FAILURE);
    assert.deepEqual(counted, [
      { name: OPS_METRIC, value: 0, attributes: { ...OPS_METRIC_BASELINE, slug } },
      { name: OPS_METRIC, attributes: { slug, site: FAILURE.site, reason: FAILURE.reasonCode } },
    ]);
    assert.equal(counted[0]?.attributes?.slug, counted[1]?.attributes?.slug);
  });
}

test("kv-verified reports its unavailable to the funnel: a kv:unavailable line naming the helper and key prefix", async () => {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (line: unknown) => void lines.push(String(line));
  try {
    const kv = fakeKv({ down: true });
    const result = await updateVerified(kv, ticketKey("TLSSN-1"), () => ({ v: 1 }), { pausesMs: [], warn: () => undefined });
    assert.deepEqual(result, { status: "unavailable" });
  } finally {
    console.warn = original;
  }
  const unavailable = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line["kv"] === "unavailable");
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0]?.["site"], "kv-verified.update/ticket");
  assert.equal(unavailable[0]?.["reasonCode"], "agentsdk_storage_http_error");
  assert.equal(unavailable[0]?.["status"], 503);
  assert.ok(!lines.join("\n").includes("TLSSN-1"), "the key's identity is not logged, only its prefix");
});

test("the module-level warnKv never throws and returns undefined", () => {
  const original = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(warnKv("site", new Error("x")), undefined);
    assert.equal(warnKv("site", null), undefined);
  } finally {
    console.warn = original;
  }
});

test("warnStep: a best-effort non-kv step logs a step line and never reaches the funnel", async () => {
  const slack = slackStub();
  const run = execution({ host: { kv: fakeKv() }, fetch: slack.fetch });
  assert.equal(run.funnel.warnStep("planner-wait.showPlannerWait.crumb", storageError({ reasonCode: "slack_ratelimited", status: 429, message: "ratelimited" })), undefined);
  await run.funnel.settled();
  assert.deepEqual(run.parsed(), [{ step: "warn", slug: factorySlug, site: "planner-wait.showPlannerWait.crumb", status: 429, message: "ratelimited" }]);
  assert.equal(slack.posts.length, 0);
});

test("warnOps: a non-kv failure logs an ops:warn line and reaches the funnel, whose alert names its kind", async () => {
  const slack = slackStub();
  const run = execution({ host: { kv: fakeKv() }, fetch: slack.fetch });
  assert.equal(run.funnel.warnOps({ site: "jira.connector", kind: "Jira connector", reasonCode: "empty", message: "Factory Atlassian=needsAuth Bearer abc" }), undefined);
  await run.funnel.settled();
  assert.deepEqual(run.parsed()[0], { ops: "warn", slug: factorySlug, site: "jira.connector", kind: "Jira connector", reasonCode: "empty", message: "Factory Atlassian=needsAuth Bearer …" });
  assert.equal(slack.posts.length, 1);
  assert.match(slack.posts[0]?.body.text ?? "", new RegExp(`^:rotating_light: ${factorySlug}: Jira connector failure at \`jira\\.connector\` \\(reason \`empty\`\\)\\.`));
  run.funnel.warnOps({ site: "jira.connector", kind: "Jira connector", reasonCode: "empty" });
  await run.funnel.settled();
  assert.equal(slack.posts.length, 1, "deduped like any other signature");
});

test("warnStep masks a token-shaped message", () => {
  const run = execution({});
  const token = ["xo", "xb-1234-5678-abcdef"].join("");
  run.funnel.warnStep("plan-decline.recordDecline.reaction", new Error(`slack refused ${token} with Bearer s3cret`));
  const [line] = run.parsed();
  assert.equal(line?.["step"], "warn");
  assert.doesNotMatch(String(line?.["message"]), /xoxb-1234|s3cret/);
  assert.match(String(line?.["message"]), /^slack refused xox… with Bearer …$/);
});

test("a refused kv failure logs once: retry_stopped through the helper's warn, no second kv:unavailable line", async () => {
  const lines: string[] = [];
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (line: unknown) => void lines.push(String(line));
  try {
    const kv: KeyedKv = {
      get: async () => {
        throw storageError({ reasonCode: "agentsdk_kv_key_invalid", status: 400 });
      },
      put: async () => undefined,
      delete: async () => undefined,
    };
    const result = await updateVerified(kv, ticketKey("TLSSN-2"), () => ({ v: 1 }), { pausesMs: [], warn: (line) => void warned.push(line) });
    assert.deepEqual(result, { status: "unavailable" });
    await opsFunnelSettled();
  } finally {
    console.warn = original;
  }
  assert.equal(warned.filter((line) => line.includes('"retry_stopped"')).length, 1);
  assert.equal(lines.filter((line) => line.includes('"kv":"unavailable"')).length, 0);
});

test("end to end: updateVerified on a down kv reaches Slack exactly once through the module funnel", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const slack = slackStub();
  Object.assign(process.env, CONFIGURED, { FACTORY_OPS_FUNNEL: "" });
  globalThis.fetch = slack.fetch;
  console.warn = () => undefined;
  try {
    bindOpsFunnel({ kv: fakeKv() });
    for (let round = 0; round < 3; round += 1) {
      assert.deepEqual(await updateVerified(fakeKv({ down: true }), ticketKey("TLSSN-3"), () => ({ v: 1 }), { pausesMs: [] }), { status: "unavailable" });
    }
    await opsFunnelSettled();
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
  assert.equal(slack.posts.length, 1);
  assert.match(slack.posts[0]?.body.text ?? "", /kv failure at `kv-verified\.update\/ticket` \(reason `agentsdk_storage_http_error`, HTTP 503\)/);
});

test("warnOps subject: joins the dedupe key and the alert text, never the metric's labels", async () => {
  const slack = slackStub();
  const counted: Array<{ name: string; value?: number; attributes?: Record<string, unknown> }> = [];
  const otel = recordIncrement(counted);
  const run = execution({ env: { ...CONFIGURED, OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic dGVzdA==" }, host: { kv: fakeKv(), otel }, fetch: slack.fetch });
  for (const subject of ["TLSSN-42 bc-1", "TLSSN-43 bc-7", "TLSSN-42 bc-1"]) {
    run.funnel.warnOps({ site: "handle.orphan", kind: "unrecorded agent", reasonCode: "kept", subject });
    await run.funnel.settled();
  }
  assert.equal(slack.posts.length, 2, "one alert per subject; a repeat is deduped");
  assert.match(slack.posts[0]?.body.text ?? "", /\(reason `kept`\) for `TLSSN-42 bc-1`\.\nOne line per site and reason and subject per hour/);
  assert.match(slack.posts[1]?.body.text ?? "", /for `TLSSN-43 bc-7`/);
  assert.deepEqual(counted[0], { name: OPS_METRIC, value: 0, attributes: { ...OPS_METRIC_BASELINE, slug: factorySlug } }, "zero baseline on bind");
  assert.deepEqual(new Set(counted.slice(1).map((each) => JSON.stringify(each.attributes))), new Set([JSON.stringify({ slug: factorySlug, site: "handle.orphan", reason: "kept" })]), "a fixed label set");
  assert.equal(run.parsed()[0]?.["subject"], "TLSSN-42 bc-1");
});
