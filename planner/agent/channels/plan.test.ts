import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CHECKOUT_ENV, MANAGED_HOSTING_ENV } from "../lib/checkout.js";
import { FactoryConfigError } from "../lib/config.js";
import channel from "./plan.js";

// The plan route is one of the three planning send sites (with
// lib/start-plan.ts and tools/plan_issue.ts). It reads process.env at send
// time, so the hosting signal is set on the real environment here, as in
// start-plan.test.ts for the webhook path.

const NAMES = [MANAGED_HOSTING_ENV, CHECKOUT_ENV, "FACTORY_ENV", "FACTORY_SANDBOX_REPO", "FACTORY_SANDBOX_REF", "FACTORY_REPOS"] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function setEnv(values: Partial<Record<(typeof NAMES)[number], string>>): void {
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, { FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank", FACTORY_SANDBOX_REF: "main", ...values });
}

type Route = { handler: (request: Request, args: Record<string, unknown>) => Promise<Response> };
const route = (channel as unknown as { routes: Route[] }).routes[0]!;

type Sent = { message: string; options: Record<string, unknown> };

function sender(): { send: (message: string, options: Record<string, unknown>) => Promise<{ id: string }>; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (message, options) => {
      sent.push({ message, options });
      return { id: `ses_${sent.length}` };
    },
  };
}

const BODY = { issueKey: "TLSSN-42", title: "CSV export returns 500" };

async function post(send: ReturnType<typeof sender>["send"]): Promise<Record<string, unknown>> {
  const response = await route.handler(
    new Request("http://127.0.0.1:3000/planner/v1/channels/plan/issue", { method: "POST", body: JSON.stringify(BODY) }),
    { body: BODY, send }
  );
  return (await response.json()) as Record<string, unknown>;
}

test("the plan route on managed hosting attaches the sandbox clone to the planning send", async () => {
  setEnv({ [MANAGED_HOSTING_ENV]: "1" });
  const { send, sent } = sender();
  const json = await post(send);
  assert.equal(json["started"], true);
  assert.match(String(json["continuationToken"]), /^issue:TLSSN-42#/);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.options["cloud"], { repos: [{ url: "https://github.com/cursor-demo-lab/marsbank", startingRef: "main" }] });
});

test("the plan route off managed hosting sends with no cloud attach, so the turn stays local and read-only", async () => {
  setEnv({});
  const { send, sent } = sender();
  const json = await post(send);
  assert.equal(json["started"], true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.options["cloud"], undefined);
  assert.equal("cloud" in (sent[0]?.options ?? {}), false);
});

test("the plan route on managed hosting with a checkout set fails by name before anything is sent", async () => {
  setEnv({ [MANAGED_HOSTING_ENV]: "1", [CHECKOUT_ENV]: "/srv/marsbank" });
  const { send, sent } = sender();
  await assert.rejects(post(send), (error: unknown) => error instanceof FactoryConfigError && error.message.includes(CHECKOUT_ENV));
  assert.equal(sent.length, 0);
});
