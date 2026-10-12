import assert from "node:assert/strict";
import { test } from "node:test";
import getPlan from "./get_plan.js";

// get_plan is the gate at step 2 of the instructions: found: true stops the
// run and returns the brief. A plan record whose Plan: comment never landed
// (TLSSN-60, 2026-10-04: every Jira call answered not_connected before #231,
// record_plan still tagged the artifact) must not be found, or every retry
// stops at the stale record and the ticket never gets a plan
// (docs/deployment-issues.md issue 26). The tool definition is a plain
// object; call execute with a stub artifacts store, as lib/tools.test.ts does.

const AT = "2026-10-04T10:06:00.000Z";

function record(tracker: string): Record<string, unknown> {
  return {
    id: "art_60",
    key: "plan:TLSSN-60",
    kind: "plan",
    updatedAt: AT,
    data: { title: "Show the branch on the Planned line", evidence: "checkout", tracker, brief: "Implement Jira TLSSN-60 …" },
  };
}

function ctx(records: Record<string, unknown>[]) {
  return { artifacts: { list: async () => records } };
}

async function read(records: Record<string, unknown>[]): Promise<Record<string, unknown>> {
  return (await getPlan.execute!({ issueKey: "TLSSN-60" } as never, ctx(records) as never)) as Record<string, unknown>;
}

test("a plan whose ticket comment never landed is not found, and the record is named as unpublished", async () => {
  const result = await read([record("not_connected")]);
  assert.equal(result["found"], false);
  assert.equal(result["issueKey"], "TLSSN-60");
  assert.deepEqual(result["unpublished"], { artifactId: "art_60", recordedAt: AT, tracker: "not_connected" });
  assert.equal(result["brief"], undefined);
});

for (const tracker of ["failed", "projects_unset", "project_not_allowed"]) {
  test(`tracker ${tracker} is unpublished too`, async () => {
    const result = await read([record(tracker)]);
    assert.equal(result["found"], false);
    assert.deepEqual(result["unpublished"], { artifactId: "art_60", recordedAt: AT, tracker });
  });
}

for (const tracker of ["commented", "already_commented"]) {
  test(`a plan whose comment landed (${tracker}) is found with its brief`, async () => {
    const result = await read([record(tracker)]);
    assert.equal(result["found"], true);
    assert.equal(result["artifactId"], "art_60");
    assert.equal(result["recordedAt"], AT);
    assert.equal(result["tracker"], tracker);
    assert.equal(result["brief"], "Implement Jira TLSSN-60 …");
    assert.equal(result["unpublished"], undefined);
  });
}

test("no record is not found, with no unpublished field", async () => {
  assert.deepEqual(await read([]), { found: false, issueKey: "TLSSN-60" });
  assert.deepEqual(await read([{ ...record("commented"), key: "plan:TLSSN-42" }]), { found: false, issueKey: "TLSSN-60" });
});

test("a record with no tracker field is unpublished", async () => {
  const bare = record("commented");
  delete (bare["data"] as Record<string, unknown>)["tracker"];
  const result = await read([bare]);
  assert.equal(result["found"], false);
  assert.deepEqual(result["unpublished"], { artifactId: "art_60", recordedAt: AT, tracker: "" });
});
