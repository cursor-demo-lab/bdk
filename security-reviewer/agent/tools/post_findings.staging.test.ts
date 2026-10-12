import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import tool from "./post_findings.js";

// A staging reviewer posts no review on the production repository, whichever
// session reaches post_findings; the check runs before any evidence read.

const saved = { env: process.env.FACTORY_ENV };
afterEach(() => {
  if (saved.env === undefined) delete process.env.FACTORY_ENV;
  else process.env.FACTORY_ENV = saved.env;
});

type ExecuteTool = { execute: (input: unknown, ctx: unknown) => Promise<unknown> };

async function post(continuationKey: string) {
  let reviews = 0;
  const run = (tool as unknown as ExecuteTool).execute({ findings: [] }, {
    session: { purpose: "run", continuationKey },
    workspaceDir: "/nonexistent",
    host: {
      kv: { get: async () => undefined, put: async () => undefined, delete: async () => undefined },
      github: { getOctokit: async () => ({ rest: { pulls: { createReview: async () => ((reviews += 1), { data: {} }) } } }) },
    },
  });
  return { result: await run.catch((error: unknown) => ({ threw: String(error) })), reviews: () => reviews };
}

test("post_findings on staging refuses the production repository before reading evidence or posting", async () => {
  process.env.FACTORY_ENV = "staging";
  const { result, reviews } = await post("cont:github-pr:cursor-demo-lab/marsbank#4");
  assert.deepEqual(result, { posted: false, reason: "staging_refuses_production" });
  assert.equal(reviews(), 0);
});

test("post_findings on production, or on staging for the staging repository, goes on to the evidence read", async () => {
  for (const [env, key] of [[undefined, "cont:github-pr:cursor-demo-lab/marsbank#4"], ["staging", "cont:github-pr:cursor-demo-lab/marsbank-staging#4"]] as const) {
    if (env === undefined) delete process.env.FACTORY_ENV;
    else process.env.FACTORY_ENV = env;
    const { result } = await post(key);
    assert.deepEqual(result, { threw: "Error: missing pr/head.sha" }, `${env ?? "production"} ${key}`);
  }
});
