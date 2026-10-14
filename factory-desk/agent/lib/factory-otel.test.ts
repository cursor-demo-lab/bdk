import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { context, trace, TraceFlags, type Span } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  describeDispatch,
  describeResponse,
  exportConfigured,
  factoryOtelConfig,
  GRAFANA_OTLP_ENDPOINT,
  noteFactory,
  otlpEndpoint,
  traced,
  tracedGithubHook,
  traceFactory,
} from "./factory-otel.js";
import { factorySlug } from "./kv-keys.js";

/** A token-shaped fixture, built from parts so no secret scanner mistakes the source for a real credential. */
function fake(...parts: string[]): string {
  return parts.join("");
}

// The shared factory OTel helpers (every agent carries a byte-identical copy,
// scripts/copies-parity.test.mjs). Spans are checked through a real SDK
// provider with an in-memory exporter, registered as the global tracer
// provider the way July registers its own; July's provider is stood in for by
// one with July's sampler (ParentBased) and no exporter.

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
/** July's sampler: a child of an unsampled parent is never recorded. */
const julyProvider = new BasicTracerProvider({ sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(1) }) });

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

beforeEach(() => {
  trace.disable();
  trace.setGlobalTracerProvider(provider);
});

test("with no tracer provider registered every helper is a silent pass-through", async () => {
  trace.disable();
  assert.equal(await traceFactory({ span: "factory.delivery", kind: "jira.webhook" }, () => 7), 7);
  noteFactory({ ticketKey: "TLSSN-1", outcome: "ok" });
  await assert.rejects(traceFactory({ span: "factory.reminder", kind: "reminder.x" }, () => Promise.reject(new Error("boom"))), /boom/);
});

function spans(): ReadableSpan[] {
  const finished = exporter.getFinishedSpans();
  exporter.reset();
  return finished;
}

function only(): ReadableSpan {
  const finished = spans();
  assert.equal(finished.length, 1);
  return finished[0]!;
}

test("traceFactory records kind, ticket, and the note taken inside, over describe", async () => {
  const result = await traceFactory(
    { span: "factory.reminder", kind: "reminder.implement_pr", ticketKey: "TLSSN-7", describe: () => ({ outcome: "skip", reason: "described" }) },
    async () => {
      noteFactory({ outcome: "opened", agentId: "bc-123" });
      return { action: "stop" };
    }
  );
  assert.deepEqual(result, { action: "stop" });
  const span = only();
  assert.equal(span.name, "factory.reminder");
  assert.equal(span.attributes["factory.delivery.kind"], "reminder.implement_pr");
  assert.equal(span.attributes["factory.ticket.key"], "TLSSN-7");
  assert.equal(span.attributes["factory.outcome"], "opened");
  assert.equal(span.attributes["factory.reason"], "described");
  assert.equal(span.attributes["factory.cloud_agent.id"], "bc-123");
  assert.equal(span.status.code, 1);
});

test("a throw records error.type, reason, and the error message, and rethrows", async () => {
  const message = "token ghp_abcdef123 rejected by https://api.example.com";
  class LaunchNotStartedError extends Error {
    readonly reason = "rate_limited";
    constructor() {
      super(message);
      this.name = "LaunchNotStartedError";
    }
  }
  await assert.rejects(traceFactory({ span: "factory.cloud_agent.launch", kind: "cloud_agent.launch", ticketKey: "TLSSN-9" }, () => Promise.reject(new LaunchNotStartedError())), LaunchNotStartedError);
  const span = only();
  assert.equal(span.status.code, 2);
  assert.equal(span.status.message, message);
  assert.equal(span.attributes["error.type"], "LaunchNotStartedError");
  assert.equal(span.attributes["error.message"], message);
  assert.equal(span.attributes["factory.outcome"], "error");
  assert.equal(span.attributes["factory.reason"], "rate_limited");
  assert.ok(JSON.stringify(span.attributes).includes("ghp_"));
});

test("span notes pass through as emitted, including free text and malformed ticket keys", async () => {
  await traceFactory({ span: "factory.delivery", kind: "slack message with spaces", ticketKey: "not a key" }, () => {
    noteFactory({ outcome: "has spaces in it", reason: "Bearer xoxb-123 secret", ticketKey: "tlssn-1", pr: "cursor-demo-lab/marsbank#12" });
  });
  const span = only();
  assert.equal(span.attributes["factory.delivery.kind"], "slack message with spaces");
  assert.equal(span.attributes["factory.ticket.key"], "tlssn-1");
  assert.equal(span.attributes["factory.reason"], "Bearer xoxb-123 secret");
  assert.equal(span.attributes["factory.outcome"], "has spaces in it");
  assert.equal(span.attributes["factory.pr"], "cursor-demo-lab/marsbank#12");
});

test("token-shaped values, Slack ids, emails, URLs, and long runs pass through on span notes", async () => {
  const passed = [
    "xoxb-1234-5678-abcdef",
    "xoxp-1-2-3",
    "xapp-1-A0-123",
    fake("gh", "p_", "abcdefghijklmnop"),
    "gho_abc123",
    fake("github", "_pat_", "11ABCDEF"),
    "glc_eyJvIjoiMTIzIn0",
    fake("gl", "sa_", "AbCdEfGh1234567890IjKlMnOpQrSt", "_9f8e7d6c"),
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
    "sk-abcdef123456",
    fake("sk", "_live_", "51HxYzAbCdEf1234567890"),
    fake("rk", "_test_", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2"),
    fake("np", "m_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
    fake("AK", "IAABCDEFGHIJKL"),
    fake("0123456789abcdef", "0123456789abcdef", "01234567"),
    "token:ghp_abcdef",
    "U0123ABCDE9",
    "W0123ABCDE9",
    "C0EXAMPLE1",
    "<OPERATOR_EMAIL>",
    "https://grafana.example/x",
    "otlp://collector:4318",
    "a".repeat(65),
    "a".repeat(24),
  ];
  for (const value of passed) {
    await traceFactory({ span: "factory.delivery", kind: "jira.webhook" }, () => noteFactory({ outcome: value, reason: value, pr: value, agentId: value }));
    const span = only();
    for (const key of ["factory.outcome", "factory.reason", "factory.pr", "factory.cloud_agent.id"]) {
      assert.equal(span.attributes[key], value, `${key} dropped ${value}`);
    }
  }
  for (const value of ["task-assessment", "launch_timeout", "plan:posted", "cursor-demo-lab/marsbank#152", "bc-e2e-0001", "jira:issue_updated"]) {
    await traceFactory({ span: "factory.delivery", kind: "jira.webhook" }, () => noteFactory({ reason: value }));
    assert.equal(only().attributes["factory.reason"], value);
  }
});

test("the header is the only switch, and the endpoint defaults to the Grafana gateway", () => {
  assert.equal(exportConfigured({}), false);
  assert.equal(exportConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://x/otlp" }), false, "an endpoint alone sends nothing");
  assert.equal(exportConfigured({ OTEL_EXPORTER_OTLP_HEADERS: "  " }), false);
  assert.equal(exportConfigured({ OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic MTpn" }), true);
  assert.equal(otlpEndpoint({}), GRAFANA_OTLP_ENDPOINT);
  assert.equal(GRAFANA_OTLP_ENDPOINT, "https://otlp.example.com/otlp");
  assert.equal(otlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/otlp/v1/traces" }), "http://127.0.0.1:4318/otlp");
  assert.equal(otlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/otlp/" }), "http://127.0.0.1:4318/otlp");
});

test("traced passes arguments and the Response through, and describeResponse reads only whitelisted fields", async () => {
  const handler = traced({ span: "factory.delivery", kind: "jira.webhook", describe: describeResponse }, async (input: { status: number }) =>
    Response.json({ ok: true, launching: true, issueKey: "TLSSN-51", message: "secret text" }, { status: input.status })
  );
  const response = await handler({ status: 202 });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, launching: true, issueKey: "TLSSN-51", message: "secret text" });
  const span = only();
  assert.equal(span.attributes["factory.outcome"], "launching");
  assert.equal(span.attributes["factory.ticket.key"], "TLSSN-51");
  assert.equal(JSON.stringify(span.attributes).includes("secret"), false);
});

test("describeResponse outcomes", async () => {
  assert.deepEqual(await describeResponse(Response.json({ ok: false }, { status: 401 })), { outcome: "http_401" });
  assert.deepEqual(await describeResponse(Response.json({ ok: true, ignored: true, reason: "not_approved" })), { outcome: "ignored", reason: "not_approved" });
  assert.deepEqual(await describeResponse(Response.json({ ok: true, kind: "approved", issueKey: "TLSSN-2" })), { outcome: "approved", ticketKey: "TLSSN-2" });
  assert.deepEqual(await describeResponse(Response.json({ ok: true, identifier: "TLSSN-3" })), { outcome: "accepted", ticketKey: "TLSSN-3" });
  assert.deepEqual(await describeResponse(Response.json({ ok: true, started: false, reason: "question" })), { outcome: "not_started", reason: "question" });
  assert.deepEqual(await describeResponse(Response.json({ ok: true, duplicate: true, issueKey: "TLSSN-4" })), { outcome: "duplicate", ticketKey: "TLSSN-4" });
  assert.deepEqual(await describeResponse(Response.json({ pr: "x", bcId: "bc-9", status: "running" })), { outcome: "accepted", agentId: "bc-9" });
  assert.deepEqual(await describeResponse(new Response("plain")), { outcome: "accepted" });
});

test("describeDispatch", () => {
  assert.deepEqual(describeDispatch(null), { outcome: "skipped" });
  assert.deepEqual(describeDispatch({ task: () => undefined }), { outcome: "task" });
  assert.deepEqual(describeDispatch({ auth: null }), { outcome: "turn" });
});

test("tracedGithubHook tags the PR and runs a returned task in its own span", async () => {
  let ran = 0;
  const hook = tracedGithubHook("github.pull_request", (_ctx: { repository: { fullName: string } }, _pr: { number: number }) => ({
    task: async () => {
      ran += 1;
      noteFactory({ ticketKey: "TLSSN-12", outcome: "announced" });
    },
  }));
  const dispatch = await hook({ repository: { fullName: "cursor-demo-lab/marsbank" } }, { number: 42 });
  const delivery = only();
  assert.equal(delivery.name, "factory.delivery");
  assert.equal(delivery.attributes["factory.outcome"], "task");
  assert.equal(delivery.attributes["factory.pr"], "cursor-demo-lab/marsbank#42");
  await dispatch.task();
  assert.equal(ran, 1);
  const task = only();
  assert.equal(task.name, "factory.github.task");
  assert.equal(task.attributes["factory.pr"], "cursor-demo-lab/marsbank#42");
  assert.equal(task.attributes["factory.ticket.key"], "TLSSN-12");
  assert.equal(task.attributes["factory.outcome"], "announced");

  const skipped = tracedGithubHook("github.check_suite", () => null);
  assert.equal(await skipped(), null);
  assert.equal(only().attributes["factory.outcome"], "skipped");
});

const INBOUND = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" };

/**
 * `work` inside a July-shaped `agent_sdk.http` span whose parent is an
 * inbound request the caller did not sample (Cursor's backend, most of the
 * time) or did. July's own span is then not recording, as in production.
 */
async function insideHttpSpan<R>(input: { sampled: boolean; work: (http: Span) => Promise<R> }): Promise<R> {
  const remote = trace.setSpanContext(context.active(), { ...INBOUND, traceFlags: input.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE, isRemote: true });
  return context.with(remote, () =>
    julyProvider.getTracer("agent_sdk").startActiveSpan("agent_sdk.http", async (http) => {
      try {
        return await input.work(http);
      } finally {
        http.end();
      }
    })
  );
}

test("under an unsampled inbound parent July's own span is not recording, and a factory span is: a new root linked to it", async () => {
  await insideHttpSpan({
    sampled: false,
    work: async (http) => {
      assert.equal(http.isRecording(), false, "the premise: a child of an unsampled parent is dropped");
      await traceFactory({ span: "factory.delivery", kind: "jira.webhook", ticketKey: "TLSSN-3" }, () => {
        assert.equal(trace.getActiveSpan()?.isRecording(), true);
      });
      const span = only();
      assert.equal(span.name, "factory.delivery");
      assert.equal(span.parentSpanContext, undefined, "a root, not a child of agent_sdk.http");
      assert.notEqual(span.spanContext().traceId, INBOUND.traceId, "its own trace");
      assert.equal(span.spanContext().traceFlags & TraceFlags.SAMPLED, TraceFlags.SAMPLED);
      assert.equal(span.links.length, 1);
      assert.deepEqual(
        { traceId: span.links[0]?.context.traceId, spanId: span.links[0]?.context.spanId },
        { traceId: http.spanContext().traceId, spanId: http.spanContext().spanId },
        "the link is the inbound span July opened"
      );
      assert.equal(span.attributes["factory.ticket.key"], "TLSSN-3");
    },
  });
});

test("every kind of factory span is a linked root under a sampled inbound parent too", async () => {
  await insideHttpSpan({
    sampled: true,
    work: async (http) => {
      for (const name of ["factory.delivery", "factory.background", "factory.github.task", "factory.schedule", "factory.reminder", "factory.cloud_agent.launch"] as const) {
        await traceFactory({ span: name, kind: "test.kind" }, () => undefined);
        const span = only();
        assert.equal(span.name, name);
        assert.equal(span.parentSpanContext, undefined, `${name} is a root`);
        assert.equal(span.links[0]?.context.spanId, http.spanContext().spanId, `${name} links to the inbound span`);
      }
    },
  });
});

test("children of a factory span share its trace and nest under it; only the root carries the link", async () => {
  await insideHttpSpan({
    sampled: false,
    work: async () => {
      await traceFactory({ span: "factory.delivery", kind: "jira.webhook" }, async () => {
        await traceFactory({ span: "factory.cloud_agent.launch", kind: "cloud_agent.launch" }, async () => {
          await traceFactory({ span: "factory.background", kind: "deep" }, () => undefined);
        });
        await traceFactory({ span: "factory.github.task", kind: "second.child" }, () => undefined);
      });
    },
  });
  const finished = spans();
  assert.deepEqual(finished.map((span) => span.name), ["factory.background", "factory.cloud_agent.launch", "factory.github.task", "factory.delivery"]);
  const [deep, launch, task, root] = finished as [ReadableSpan, ReadableSpan, ReadableSpan, ReadableSpan];
  const traceId = root.spanContext().traceId;
  for (const span of finished) assert.equal(span.spanContext().traceId, traceId, `${span.name} shares the root's trace id`);
  assert.equal(root.parentSpanContext, undefined);
  assert.equal(root.links.length, 1);
  assert.equal(launch.parentSpanContext?.spanId, root.spanContext().spanId);
  assert.equal(task.parentSpanContext?.spanId, root.spanContext().spanId);
  assert.equal(deep.parentSpanContext?.spanId, launch.spanContext().spanId);
  for (const child of [deep, launch, task]) assert.equal(child.links.length, 0, `${child.name} is a plain child`);
});

test("with no inbound span a factory span is a root with no link", async () => {
  await traceFactory({ span: "factory.schedule", kind: "schedule.hop-watch" }, () => undefined);
  const span = only();
  assert.equal(span.parentSpanContext, undefined);
  assert.deepEqual(span.links, []);
});

test("an invalid inbound span context is not linked", async () => {
  const invalid = trace.setSpanContext(context.active(), { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: TraceFlags.NONE });
  await context.with(invalid, () => traceFactory({ span: "factory.reminder", kind: "reminder.x" }, () => undefined));
  assert.deepEqual(only().links, []);
});

test("work a handler hands to waitUntil, started inside the delivery and ending after it, joins the delivery's trace", async () => {
  let background: Promise<void> | undefined;
  await traceFactory({ span: "factory.delivery", kind: "jira.webhook" }, () => {
    background = traceFactory({ span: "factory.background", kind: "jira.triage_wake" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  });
  const delivery = only();
  await background;
  const wake = only();
  assert.equal(wake.name, "factory.background");
  assert.equal(wake.spanContext().traceId, delivery.spanContext().traceId);
  assert.equal(wake.parentSpanContext?.spanId, delivery.spanContext().spanId);
});

test("tracedGithubHook: the delivery is a linked root and the task, run later in the delivery's context, is its child", async () => {
  const hook = tracedGithubHook("github.check_suite", (_ctx: { repository: { fullName: string } }, _suite: { number: number }) => ({ task: async () => undefined }));
  const dispatch = await insideHttpSpan({ sampled: false, work: async () => hook({ repository: { fullName: "cursor-demo-lab/marsbank" } }, { number: 7 }) });
  await dispatch.task();
  const [delivery, task] = spans() as [ReadableSpan, ReadableSpan];
  assert.equal(delivery.name, "factory.delivery");
  assert.equal(delivery.links.length, 1);
  assert.equal(task.name, "factory.github.task");
  assert.equal(task.spanContext().traceId, delivery.spanContext().traceId);
  assert.equal(task.parentSpanContext?.spanId, delivery.spanContext().spanId);
});

test("factoryOtelConfig: no exporter while the header is unset, one for traces and logs only while it is set", () => {
  assert.deepEqual(factoryOtelConfig({}).exporters, []);
  assert.deepEqual(factoryOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://x/otlp" }).exporters, [], "an endpoint alone gives the config no exporter");
  const set = factoryOtelConfig({ OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic x" });
  assert.deepEqual(set.exporters, [{ url: GRAFANA_OTLP_ENDPOINT, signals: ["traces", "logs"] }], "no metrics: July's DELTA exporter is rejected by Grafana, so metrics go through factory-metrics.ts");
  assert.equal(JSON.stringify(set).includes("Basic"), false, "July reads the header from the env; the config never holds it");
  assert.deepEqual(set.logs, { userPrompts: true, toolContent: true }, "logs are on, with prompts and tool content");
});

test("factoryOtelConfig: the service is the slug on managed hosting and one shared name off it; OTEL_SERVICE_NAME wins; the resource is set here", () => {
  const hosted = factoryOtelConfig({ AGENT_SERVE_GENERATION: "7" });
  assert.equal(hosted.serviceName, factorySlug);
  assert.deepEqual(hosted.resourceAttributes, {
    "service.namespace": "software-factory",
    "deployment.environment": "production",
    "deployment.environment.name": "production",
    "factory.slug": factorySlug,
  });
  const local = factoryOtelConfig({});
  assert.equal(local.serviceName, "software-factory", "one config for every agent a local `serve --dir .` mounts");
  assert.deepEqual(local.resourceAttributes, {
    "service.namespace": "software-factory",
    "deployment.environment": "production",
    "deployment.environment.name": "production",
  });
  assert.equal(factoryOtelConfig({ AGENT_SERVE_GENERATION: "7", OTEL_SERVICE_NAME: "custom" }).serviceName, "custom");
});

test("factoryOtelConfig names a staging slug and its stage", () => {
  const staging = factoryOtelConfig({ AGENT_SERVE_GENERATION: "7", FACTORY_ENV: "staging" });
  assert.equal(staging.serviceName, `${factorySlug}-staging`);
  assert.equal(staging.resourceAttributes?.["deployment.environment"], "staging");
  assert.equal(staging.resourceAttributes?.["factory.slug"], `${factorySlug}-staging`);
});

test("factoryOtelConfig is the same on every call for one env: July's reload on each hosted delivery sees no change", () => {
  const env = { AGENT_SERVE_GENERATION: "7", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic x" };
  assert.equal(JSON.stringify(factoryOtelConfig(env)), JSON.stringify(factoryOtelConfig(env)));
});
