import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CHECKOUT_ENV, MANAGED_HOSTING_ENV } from "../lib/checkout.js";
import planIssue from "./plan_issue.js";

// plan_issue reads process.env at send time (hosted v2 binds FACTORY_* per
// request), so the hosting signal is set on the real environment here.
const PLAN_ENV_NAMES = [MANAGED_HOSTING_ENV, CHECKOUT_ENV, "FACTORY_ENV", "FACTORY_SANDBOX_REPO", "FACTORY_SANDBOX_REF", "FACTORY_REPOS"] as const;
const savedPlanEnv = Object.fromEntries(PLAN_ENV_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of PLAN_ENV_NAMES) {
    if (savedPlanEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedPlanEnv[name];
  }
});

function setPlanEnv(values: Partial<Record<(typeof PLAN_ENV_NAMES)[number], string>>): void {
  for (const name of PLAN_ENV_NAMES) delete process.env[name];
  Object.assign(process.env, { FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank", FACTORY_SANDBOX_REF: "main", ...values });
}

type Sent = { channel: string; message: string; options: Record<string, unknown> };

function planIssueContext(): { context: never; sent: Sent[] } {
  const sent: Sent[] = [];
  const send = async (channel: string, message: string, options: Record<string, unknown>) => {
    sent.push({ channel, message, options });
    return { id: `ses_${sent.length}` };
  };
  return { context: { session: { id: "ses_host", purpose: "live" }, send } as never, sent };
}

const REQUEST = { issueKey: "TLSSN-42", title: "CSV export returns 500" } as never;

test("plan_issue on managed hosting attaches the sandbox clone to the planning send", async () => {
  setPlanEnv({ [MANAGED_HOSTING_ENV]: "1" });
  const { context, sent } = planIssueContext();
  const result = await planIssue.execute!(REQUEST, context);
  assert.equal((result as Record<string, unknown>)["started"], true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.channel, "plan");
  assert.deepEqual(sent[0]?.options["cloud"], { repos: [{ url: "https://github.com/cursor-demo-lab/marsbank", startingRef: "main" }] });
});

test("plan_issue off managed hosting sends with no cloud attach, so the turn stays local and read-only", async () => {
  setPlanEnv({});
  const { context, sent } = planIssueContext();
  const result = await planIssue.execute!(REQUEST, context);
  assert.equal((result as Record<string, unknown>)["started"], true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.options["cloud"], undefined);
  assert.equal("cloud" in (sent[0]?.options ?? {}), false);
});
