import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HostKvApi } from "@cursor/july";
import { STALE_PENDING_MS, recordImplementation } from "./claim.js";
import { prStatusClaimKey, type PrDecision } from "./pr-decide.js";
import { advanceTicket, PrStatusRetryableError, prStatusDispatch, type PrHookInput } from "./pr-status.js";
import { racingStores } from "./kv-race.fixtures.js";
import { fakeTracker, memoryKv, tick, type FakeTracker, type MemoryKv } from "./testing/fakes.js";

const NOW = new Date("2026-09-25T00:00:00.000Z");
const ENV: NodeJS.ProcessEnv = { FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank", FACTORY_CLAIM_SETTLE_MS: "1" };
const PR = "cursor-demo-lab/marsbank#13";

const URL = "https://github.com/cursor-demo-lab/marsbank/pull/13";
const LINK = `Pull request: ${URL}`;
const IN_REVIEW: Extract<PrDecision, { move: true }> = { move: true, stage: "in_review", issueKey: "TLSSN-9", pr: PR, url: URL };
const DONE: Extract<PrDecision, { move: true }> = { move: true, stage: "done", issueKey: "TLSSN-9", pr: PR, url: URL };

async function launchedKv(options: { cas?: boolean } = {}): Promise<MemoryKv> {
  const kv = memoryKv(options);
  await recordImplementation(kv, "TLSSN-9", {
    state: "launched",
    at: NOW.toISOString(),
    agentId: "bc-example-1",
    url: "https://cursor.com/agents/bc-example-1",
    commented: true,
    moved: true,
  });
  return kv;
}

function world(options: { status: string; kv: MemoryKv; tracker?: FakeTracker; env?: NodeJS.ProcessEnv; now?: () => Date }) {
  const tracker = options.tracker ?? fakeTracker({ status: options.status });
  const lines: string[] = [];
  const deps = { kv: options.kv, mcp: tracker.mcp, env: options.env ?? ENV, now: options.now ?? (() => NOW), log: (line: string) => lines.push(line) };
  const moves = () => tracker.calls.filter((call) => call.tool === "transitionJiraIssue").map((call) => (call.args["transition"] as { id: string }).id);
  const logged = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => "worker" in line);
  return { tracker, deps, moves, logged };
}

test("an implement PR opening moves In Progress to In Review, and a merge moves In Review to Done, once each with the PR link left first; a redelivery writes nothing", async () => {
  const stages = [
    [IN_REVIEW, "In Progress", "In Review", "71"],
    [DONE, "In Review", "Done", "81"],
  ] as const;
  for (const [decision, from, to, transition] of stages) {
    const kv = await launchedKv();
    const w = world({ status: from, kv });

    assert.deepEqual(await advanceTicket(w.deps, decision), { outcome: "moved", move: "transitioned", catchUp: false }, to);
    assert.equal(w.tracker.status(), to);
    assert.deepEqual(w.moves(), [transition]);
    assert.deepEqual(kv.entries.get(prStatusClaimKey(decision)), { state: "moved", at: NOW.toISOString(), outcome: "transitioned" }, to);
    const order = w.tracker.calls.map((call) => call.tool);
    assert.ok(order.indexOf("addCommentToJiraIssue") < order.indexOf("transitionJiraIssue"), order.join(" "));
    assert.deepEqual(w.tracker.comments, [LINK], to);
    assert.equal(w.logged()[0]?.["linked"], "written", to);
    assert.equal("merged" in (w.logged()[0] ?? {}), false, to);

    const callsBefore = w.tracker.calls.length;
    assert.deepEqual(await advanceTicket(w.deps, decision), { outcome: "duplicate" }, to);
    assert.equal(w.tracker.calls.length, callsBefore, "a redelivery reads and writes nothing in Jira");
    assert.deepEqual(w.logged().map((line) => line["outcome"]), ["moved", "duplicate"], to);
  }
});

test("a person's merge leaves Merged by: <login> on the ticket before Done, once", async () => {
  const kv = await launchedKv();
  const opened = world({ status: "In Progress", kv });
  await advanceTicket(opened.deps, IN_REVIEW);

  const merge = {
    action: "closed" as const,
    merged: true,
    sender: { login: "relay", type: "User" as const },
    payload: { pull_request: { merged_by: { login: "example-user", type: "User" }, auto_merge: null } },
  };
  const first = world({ status: "In Review", kv, tracker: opened.tracker });
  const dispatch = prStatusDispatch({ ...hook(merge), deps: first.deps });
  assert.ok(dispatch !== null);
  await dispatch.task();
  const commentOrder = first.tracker.calls.filter((call) => call.tool === "addCommentToJiraIssue" || call.tool === "transitionJiraIssue").map((call) => call.tool);
  assert.ok(commentOrder.lastIndexOf("addCommentToJiraIssue") < commentOrder.lastIndexOf("transitionJiraIssue"), commentOrder.join(" "));
  assert.deepEqual(opened.tracker.comments, [LINK, "Merged by: example-user"]);
  assert.equal(first.logged()[0]?.["merged"], "written");
  assert.equal(first.logged()[0]?.["linked"], "present");
  assert.equal(opened.tracker.status(), "Done");

  const again = world({ status: "Done", kv, tracker: opened.tracker });
  const redelivery = prStatusDispatch({ ...hook(merge), deps: again.deps });
  assert.ok(redelivery !== null);
  await redelivery.task();
  assert.deepEqual(opened.tracker.comments, [LINK, "Merged by: example-user"]);
  assert.equal(again.logged()[0]?.["outcome"], "duplicate");
});

test("a Merged by: line already on the ticket is present, so the merge does not write it again", async () => {
  const kv = await launchedKv();
  const w = world({
    status: "In Review",
    kv,
    tracker: fakeTracker({ status: "In Review", comments: [LINK, "Merged by: example-user"] }),
  });
  assert.deepEqual(await advanceTicket(w.deps, { ...DONE, mergedBy: "example-user" }), { outcome: "moved", move: "transitioned", catchUp: false });
  assert.deepEqual(w.tracker.comments, [LINK, "Merged by: example-user"]);
  assert.equal(w.logged()[0]?.["merged"], "present");
  assert.equal(w.logged()[0]?.["linked"], "present");
});

test("a link or Merged by: comment that cannot be written never holds the move back", async () => {
  const opened = world({ status: "In Progress", kv: await launchedKv(), tracker: fakeTracker({ status: "In Progress", commentFailures: 1 }) });
  assert.deepEqual(await advanceTicket(opened.deps, IN_REVIEW), { outcome: "moved", move: "transitioned", catchUp: false });
  assert.deepEqual(opened.tracker.comments, []);
  assert.equal(opened.logged()[0]?.["linked"], "failed");

  const kv = await launchedKv();
  const w = world({
    status: "In Review",
    kv,
    tracker: fakeTracker({ status: "In Review", comments: [LINK], commentFailures: 1 }),
  });
  const dispatch = prStatusDispatch({
    ...hook({
      action: "closed",
      merged: true,
      sender: { login: "example-user", type: "User" },
      payload: { pull_request: { merged_by: { login: "example-user", type: "User" } } },
    }),
    deps: w.deps,
  });
  assert.ok(dispatch !== null);
  await dispatch.task();
  assert.deepEqual(w.tracker.comments, [LINK]);
  assert.equal(w.logged()[0]?.["merged"], "failed");
  assert.equal(w.tracker.status(), "Done");
});

test("a link Jira hands back as a smart link card is present, so the merge does not write it again", async () => {
  const kv = await launchedKv();
  const inner = fakeTracker({ status: "In Review" });
  const card = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Pull request: " }, { type: "inlineCard", attrs: { url: URL } }] }] };
  const adf = {
    ...inner.mcp,
    callTool: async (connection: string, tool: string, args?: Record<string, unknown>) => {
      if (tool !== "getJiraIssue") return inner.mcp.callTool(connection, tool, args);
      inner.calls.push({ tool, args: args ?? {} });
      return { content: [{ type: "text" as const, text: JSON.stringify({ key: "TLSSN-9", fields: { status: { name: inner.status() }, comment: { comments: [{ id: "1", body: card }] } } }) }] };
    },
  };
  const w = world({ status: "In Review", kv, tracker: { ...inner, mcp: adf } });
  assert.deepEqual(await advanceTicket(w.deps, DONE), { outcome: "moved", move: "transitioned", catchUp: false });
  assert.deepEqual(inner.comments, []);
  assert.equal(w.logged()[0]?.["linked"], "present");
});

// The read is only the dedupe. Without it the desk would post "In Review: the
// pull request is open" and "Done." with no link and no merger, so the lines
// are written anyway; a repeated line is harmless.
test("when the ticket's comments cannot be read, the link and the merger are still left before the move", async () => {
  // The comment read is the first getJiraIssue call of a delivery; the status guard's read comes after the writes.
  function unreadableComments(inner: FakeTracker, fail: "error" | "throw") {
    let reads = 0;
    return {
      ...inner.mcp,
      callTool: async (connection: string, tool: string, args?: Record<string, unknown>) => {
        if (tool === "getJiraIssue" && reads++ === 0) {
          inner.calls.push({ tool, args: args ?? {} });
          if (fail === "throw") throw new Error("connector timeout");
          return { content: [{ type: "text" as const, text: "rate limited" }], isError: true };
        }
        return inner.mcp.callTool(connection, tool, args);
      },
    };
  }

  const merged = fakeTracker({ status: "In Review" });
  const w = world({ status: "In Review", kv: await launchedKv(), tracker: { ...merged, mcp: unreadableComments(merged, "error") } });
  assert.deepEqual(await advanceTicket(w.deps, { ...DONE, mergedBy: "alice" }), { outcome: "moved", move: "transitioned", catchUp: false });
  assert.deepEqual(merged.comments, [LINK, "Merged by: alice"]);
  assert.equal(merged.status(), "Done");
  assert.equal(w.logged()[0]?.["linked"], "written");
  assert.equal(w.logged()[0]?.["merged"], "written");

  const opened = fakeTracker({ status: "In Progress" });
  const w2 = world({ status: "In Progress", kv: await launchedKv(), tracker: { ...opened, mcp: unreadableComments(opened, "throw") } });
  assert.deepEqual(await advanceTicket(w2.deps, IN_REVIEW), { outcome: "moved", move: "transitioned", catchUp: false });
  assert.deepEqual(opened.comments, [LINK]);
  assert.equal(opened.status(), "In Review");
  assert.equal(w2.logged()[0]?.["linked"], "written");
});

test("a ticket already in the target status is recorded as already and not moved again", async () => {
  const kv = await launchedKv();
  const review = world({ status: "In Review", kv });
  assert.deepEqual(await advanceTicket(review.deps, IN_REVIEW), { outcome: "moved", move: "already", catchUp: false });
  assert.deepEqual(review.moves(), []);

  const done = world({ status: "Done", kv });
  assert.deepEqual(await advanceTicket(done.deps, DONE), { outcome: "moved", move: "already", catchUp: false });
  assert.deepEqual(done.moves(), []);
});

test("In Review is entered only from In Progress: a ticket elsewhere stays put and the claim is released", async () => {
  for (const status of ["Approved", "Planned", "Done", "To Do"]) {
    const kv = await launchedKv();
    const w = world({ status, kv });
    assert.deepEqual(await advanceTicket(w.deps, IN_REVIEW), { outcome: "not_moved", move: "skipped_status", current: status }, status);
    assert.equal(w.tracker.status(), status);
    assert.deepEqual(w.moves(), []);
    assert.equal(kv.entries.has(prStatusClaimKey(IN_REVIEW)), false, "a later push retries");
  }
});

test("a PR that opens while its launched ticket was rolled back to Planned leaves one note on the ticket, not one per delivery", async () => {
  const kv = await launchedKv();
  const w = world({ status: "Planned", kv });
  assert.deepEqual(await advanceTicket(w.deps, IN_REVIEW), { outcome: "not_moved", move: "skipped_status", current: "Planned" });
  assert.deepEqual(await advanceTicket(w.deps, IN_REVIEW), { outcome: "not_moved", move: "skipped_status", current: "Planned" });
  assert.deepEqual(w.moves(), []);
  assert.deepEqual(w.tracker.comments, [
    LINK,
    "In Review not set from cursor-demo-lab/marsbank#13: TLSSN-9 is Planned, not In Progress, so the worker left it there. Move the card by hand if this pull request is the implementation.",
  ]);
  assert.deepEqual(w.logged().map((line) => line["noted"]), ["written", "duplicate"]);

  const merged = world({ status: "Planned", kv, tracker: w.tracker });
  assert.deepEqual(await advanceTicket(merged.deps, DONE), { outcome: "moved", move: "transitioned", catchUp: true, resyncedFrom: "Planned" });
  assert.equal(w.tracker.status(), "Done");
  assert.equal(w.tracker.comments.length, 2, "the merge that moves the ticket leaves no skip note");
});

test("TLSSN-21: a person merges the implement PR while the launched ticket sits in Planned, and it walks Planned → In Review → Done", async () => {
  const kv = await launchedKv();
  const w = world({ status: "Planned", kv });
  const dispatch = prStatusDispatch({
    ...hook({
      action: "closed",
      merged: true,
      sender: { login: "example-user", type: "User" },
      payload: { pull_request: { merged_by: { login: "example-user", type: "User" }, auto_merge: null } },
    }),
    deps: w.deps,
  });
  assert.ok(dispatch !== null);
  await dispatch.task();

  assert.equal(w.tracker.status(), "Done");
  assert.deepEqual(w.moves(), ["71", "81"], "both moves, so the desk announces In Review and Done");
  assert.deepEqual(w.tracker.comments, [LINK, "Merged by: example-user"]);
  const writes = w.tracker.calls
    .filter((call) => call.tool === "addCommentToJiraIssue" || call.tool === "transitionJiraIssue")
    .map((call) => (call.tool === "transitionJiraIssue" ? `move ${(call.args["transition"] as { id: string }).id}` : String(call.args["commentBody"] ?? call.args["comment"] ?? "").split(":")[0]));
  assert.deepEqual(writes, ["Pull request", "move 71", "Merged by", "move 81"], "the merger is named once the catch-up reached In Review, before Done");
  assert.equal(w.tracker.comments.some((comment) => comment.includes("not set from")), false);
  const line = w.logged()[0] ?? {};
  assert.equal(line["outcome"], "moved");
  assert.equal(line["catchUp"], true);
  assert.equal(line["resyncedFrom"], "Planned");
  assert.deepEqual(kv.entries.get(prStatusClaimKey(DONE)), { state: "moved", at: NOW.toISOString(), outcome: "transitioned" });
});

test("a merge walks a launched ticket to Done through In Review from In Progress, or re-syncs it from any factory status before that", async () => {
  // In Progress: the opened delivery was missed, or the PR opened before this path shipped.
  for (const status of ["In Progress", "Approved", "Planned", "Triaged", "To Do"]) {
    const kv = await launchedKv();
    const w = world({ status, kv });
    const walked = { outcome: "moved", move: "transitioned", catchUp: true } as const;
    assert.deepEqual(await advanceTicket(w.deps, DONE), status === "In Progress" ? walked : { ...walked, resyncedFrom: status }, status);
    assert.deepEqual(w.moves(), ["71", "81"], "both moves, so the desk announces In Review and Done");
    assert.equal(w.tracker.status(), "Done", status);
  }
});

test("the moves and the re-sync follow the renamed FACTORY_STATUS_* names", async () => {
  const building = { ...ENV, FACTORY_STATUS_IN_PROGRESS: "Building", FACTORY_STATUS_IN_REVIEW: "In Review" };
  const opened = world({ status: "Building", kv: await launchedKv(), tracker: fakeTracker({ status: "Building" }), env: building });
  assert.deepEqual(await advanceTicket(opened.deps, IN_REVIEW), { outcome: "moved", move: "transitioned", catchUp: false });
  const shipped = world({ status: "In Review", kv: await launchedKv(), env: { ...ENV, FACTORY_STATUS_DONE: "Shipped" } });
  assert.deepEqual(await advanceTicket(shipped.deps, DONE), { outcome: "not_moved", move: "no_transition" });

  const kv = await launchedKv();
  const env = { ...ENV, FACTORY_STATUS_PLANNED: "Designed" };
  const w = world({ status: "Designed", kv, env });
  assert.deepEqual(await advanceTicket(w.deps, DONE), { outcome: "moved", move: "transitioned", catchUp: true, resyncedFrom: "Designed" });
  const stock = world({ status: "Planned", kv: await launchedKv(), env });
  assert.deepEqual(await advanceTicket(stock.deps, DONE), { outcome: "not_moved", move: "skipped_status", current: "Planned" }, "Planned is not a factory status under that name");
});

test("a merge leaves a ticket in a status outside the factory flow where it is, with one note", async () => {
  for (const status of ["Won't Do", "Blocked"]) {
    const kv = await launchedKv();
    const w = world({ status, kv });
    assert.deepEqual(await advanceTicket(w.deps, DONE), { outcome: "not_moved", move: "skipped_status", current: status }, status);
    assert.deepEqual(w.moves(), []);
    assert.equal(w.tracker.status(), status);
    assert.equal(
      w.tracker.comments.at(-1),
      `Done not set from cursor-demo-lab/marsbank#13: TLSSN-9 is ${status}, not a factory status before Done, so the worker left it there. Move the card by hand if this pull request is the implementation.`
    );
    assert.equal(kv.entries.has(prStatusClaimKey(DONE)), false);
  }
});

// Round-2 finding 8: Merged by: was written before the Done move was known,
// so a merge that left the ticket short of Done still named a merger on it.
test("a merge that leaves the ticket short of Done names no merger: another status, an unread status, or a failed catch-up", async () => {
  for (const status of ["Won't Do", "Blocked"]) {
    const w = world({ status, kv: await launchedKv() });
    assert.deepEqual(await advanceTicket(w.deps, { ...DONE, mergedBy: "example-user" }), { outcome: "not_moved", move: "skipped_status", current: status }, status);
    assert.equal(w.tracker.comments.some((comment) => comment.startsWith("Merged by:")), false, status);
    assert.equal(w.tracker.comments[0], LINK, status);
    assert.equal(w.logged()[0]?.["merged"], "skipped", status);
  }

  const inner = fakeTracker({ status: "In Review" });
  let readable = false;
  const flaky = {
    ...inner.mcp,
    callTool: async (connection: string, tool: string, args?: Record<string, unknown>) => {
      if (tool !== "getJiraIssue" || readable) return inner.mcp.callTool(connection, tool, args);
      inner.calls.push({ tool, args: args ?? {} });
      const comments = inner.comments.map((body, i) => ({ id: String(i + 1), body }));
      return { content: [{ type: "text" as const, text: JSON.stringify({ key: "TLSSN-9", fields: { comment: { comments } } }) }] };
    },
  };
  const unread = world({ status: "In Review", kv: await launchedKv(), tracker: { ...inner, mcp: flaky } });
  await assert.rejects(advanceTicket(unread.deps, { ...DONE, mergedBy: "example-user" }), PrStatusRetryableError);
  assert.equal(inner.comments.some((comment) => comment.startsWith("Merged by:")), false);
  readable = true;
  assert.deepEqual(await advanceTicket(unread.deps, { ...DONE, mergedBy: "example-user" }), { outcome: "moved", move: "transitioned", catchUp: false });
  assert.equal(inner.comments.filter((comment) => comment === "Merged by: example-user").length, 1);

  const stuck = world({ status: "Planned", kv: await launchedKv(), tracker: fakeTracker({ status: "Planned", transitionFailures: 1 }) });
  await assert.rejects(advanceTicket(stuck.deps, { ...DONE, mergedBy: "example-user" }), PrStatusRetryableError);
  assert.equal(stuck.tracker.status(), "Planned");
  assert.equal(stuck.tracker.comments.some((comment) => comment.startsWith("Merged by:")), false, "the catch-up into In Review failed, so no merger yet");
  assert.deepEqual(await advanceTicket(stuck.deps, { ...DONE, mergedBy: "example-user" }), { outcome: "moved", move: "transitioned", catchUp: true, resyncedFrom: "Planned" });
  assert.equal(stuck.tracker.comments.filter((comment) => comment === "Merged by: example-user").length, 1);
});

test("a ticket already Done still gets the merger; a Done move that fails after In Review leaves it for a person's drag", async () => {
  const done = world({ status: "Done", kv: await launchedKv() });
  assert.deepEqual(await advanceTicket(done.deps, { ...DONE, mergedBy: "example-user" }), { outcome: "moved", move: "already", catchUp: false });
  assert.deepEqual(done.tracker.comments, [LINK, "Merged by: example-user"]);
  assert.deepEqual(done.moves(), []);

  // The one window left: the ticket is at In Review and the last move fails.
  // The merger is already named, so the desk's Done line names them when a
  // person drags the card.
  const review = world({ status: "In Review", kv: await launchedKv(), tracker: fakeTracker({ status: "In Review", transitionFailures: 1 }) });
  await assert.rejects(advanceTicket(review.deps, { ...DONE, mergedBy: "example-user" }), PrStatusRetryableError);
  assert.equal(review.tracker.status(), "In Review");
  assert.deepEqual(review.tracker.comments.slice(0, 2), [LINK, "Merged by: example-user"]);
});

test("a merge whose ticket status cannot be read notes it once and throws so the delivery is retried", async () => {
  const kv = await launchedKv();
  const inner = fakeTracker({ status: "Planned" });
  let readable = false;
  const flaky = {
    ...inner.mcp,
    callTool: async (connection: string, tool: string, args?: Record<string, unknown>) => {
      if (tool !== "getJiraIssue" || readable) return inner.mcp.callTool(connection, tool, args);
      inner.calls.push({ tool, args: args ?? {} });
      const comments = inner.comments.map((body, i) => ({ id: String(i + 1), body }));
      return { content: [{ type: "text" as const, text: JSON.stringify({ key: "TLSSN-9", fields: { comment: { comments } } }) }] };
    },
  };
  const w = world({ status: "Planned", kv, tracker: { ...inner, mcp: flaky } });
  await assert.rejects(advanceTicket(w.deps, DONE), PrStatusRetryableError);
  await assert.rejects(advanceTicket(w.deps, DONE), PrStatusRetryableError);
  assert.equal(kv.entries.has(prStatusClaimKey(DONE)), false);
  assert.deepEqual(w.moves(), []);
  assert.deepEqual(inner.comments.filter((comment) => comment.includes("could not be read")).length, 1);
  readable = true;
  assert.deepEqual(await advanceTicket(w.deps, DONE), { outcome: "moved", move: "transitioned", catchUp: true, resyncedFrom: "Planned" });
  assert.equal(inner.status(), "Done");
});

test("a failed move releases its claim, is noted once without the connector's error text, and throws for a retry", async () => {
  const kv = await launchedKv();
  const w = world({ status: "In Review", kv, tracker: fakeTracker({ status: "In Review", transitionFailures: 2 }) });
  await assert.rejects(advanceTicket(w.deps, DONE), PrStatusRetryableError);
  assert.equal(kv.entries.has(prStatusClaimKey(DONE)), false);
  await assert.rejects(advanceTicket(w.deps, DONE), PrStatusRetryableError);
  assert.deepEqual(w.tracker.comments, [LINK, "Done not set from cursor-demo-lab/marsbank#13: the move failed; the next delivery for this pull request retries it."]);
  assert.deepEqual(await advanceTicket(w.deps, DONE), { outcome: "moved", move: "transitioned", catchUp: false });
});

test("the guarded move reads the status from Rovo's issues.nodes envelope and ignores the envelope's own status", async () => {
  const kv = await launchedKv();
  const inner = fakeTracker({ status: "In Progress" });
  const rovo = {
    ...inner.mcp,
    listTools: async () =>
      (await inner.mcp.listTools("tracker")).map((tool) =>
        tool.name === "getJiraIssue" ? { ...tool, inputSchema: { type: "object", properties: { ...(tool.inputSchema?.["properties"] as object), fields: { type: "array" } } } } : tool
      ),
    callTool: async (connection: string, tool: string, args?: Record<string, unknown>) => {
      if (tool !== "getJiraIssue") return inner.mcp.callTool(connection, tool, args);
      inner.calls.push({ tool, args: args ?? {} });
      return { content: [{ type: "text" as const, text: "TLSSN-9 is In Progress." }], structuredContent: { status: "ok", issues: { nodes: [{ key: "TLSSN-9", fields: { status: { name: inner.status() } } }] } } };
    },
  };
  const w = world({ status: "In Progress", kv, tracker: { ...inner, mcp: rovo } });
  assert.deepEqual(await advanceTicket(w.deps, IN_REVIEW), { outcome: "moved", move: "transitioned", catchUp: false });
  // The first read is the comment list (for the Pull request: link); the guard's status read comes last.
  assert.deepEqual(inner.calls.filter((call) => call.tool === "getJiraIssue").at(-1)?.args["fields"], ["status"]);
});

test("a ticket the worker never launched is never moved", async () => {
  const w = world({ status: "In Progress", kv: memoryKv() });
  assert.deepEqual(await advanceTicket(w.deps, IN_REVIEW), { outcome: "not_launched" });
  assert.deepEqual(await advanceTicket(w.deps, DONE), { outcome: "not_launched" });
  assert.equal(w.tracker.calls.length, 0);
});

test("a delivery that finds a fresh pending claim is in flight; a stale one is taken over", async () => {
  const kv = await launchedKv();
  await kv.put(prStatusClaimKey(IN_REVIEW), { state: "pending", at: NOW.toISOString() });
  const fresh = world({ status: "In Progress", kv });
  assert.deepEqual(await advanceTicket(fresh.deps, IN_REVIEW), { outcome: "in_flight" });
  assert.deepEqual(fresh.moves(), []);

  const later = new Date(NOW.getTime() + STALE_PENDING_MS + 1);
  const stale = world({ status: "In Progress", kv, now: () => later });
  assert.deepEqual(await advanceTicket(stale.deps, IN_REVIEW), { outcome: "moved", move: "transitioned", catchUp: false });
  assert.deepEqual(stale.moves(), ["71"]);
});

test("no tracker connection moves nothing and does not throw", async () => {
  const kv = await launchedKv();
  const w = world({ status: "In Progress", kv, tracker: fakeTracker({ status: "In Progress", connected: false }) });
  assert.deepEqual(await advanceTicket(w.deps, IN_REVIEW), { outcome: "not_moved", move: "not_connected" });
  assert.equal(kv.entries.has(prStatusClaimKey(IN_REVIEW)), false);
});

test("an unreadable kv throws before any Jira call", async () => {
  const broken: HostKvApi = {
    get: async () => {
      throw new Error("kv down");
    },
    put: async () => undefined,
    delete: async () => undefined,
  };
  const w = world({ status: "In Progress", kv: broken as MemoryKv });
  await assert.rejects(advanceTicket(w.deps, IN_REVIEW), PrStatusRetryableError);
  assert.equal(w.tracker.calls.length, 0);
});

function hook(overrides: { action?: string; merged?: boolean; sender?: { login: string; type?: string }; payload?: unknown } = {}): PrHookInput {
  return {
    ctx: {
      repository: { fullName: "cursor-demo-lab/marsbank" },
      sender: overrides.sender ?? { login: "cursor[bot]", type: "Bot" },
      payload: overrides.payload ?? {},
    },
    pr: {
      action: overrides.action ?? "opened",
      number: 13,
      url: "https://github.com/cursor-demo-lab/marsbank/pull/13",
      headRef: "TLSSN-9-csv-export-zero-rows",
      baseRef: "main",
      title: "TLSSN-9: CSV export",
      authorLogin: "cursor[bot]",
      merged: overrides.merged ?? false,
    },
  };
}

test("prStatusDispatch returns a task only for a move and logs why it skipped everything else", async () => {
  const kv = await launchedKv();
  const w = world({ status: "In Progress", kv });
  const dispatch = prStatusDispatch({ ...hook(), deps: w.deps });
  assert.ok(dispatch !== null);
  assert.deepEqual(w.moves(), [], "nothing runs before the task");
  await dispatch.task();
  assert.equal(w.tracker.status(), "In Review");

  const merged = { action: "closed", merged: true, sender: { login: "example-user", type: "User" } };
  assert.equal(prStatusDispatch({ ...hook({ ...merged, payload: { pull_request: { auto_merge: { merge_method: "squash" } } } }), deps: w.deps }), null);
  assert.equal(prStatusDispatch({ ...hook({ ...merged, payload: { pull_request: { merged_by: { login: "cursor[bot]", type: "Bot" } } } }), deps: w.deps }), null);
  assert.equal(prStatusDispatch({ ...hook(), deps: { ...w.deps, env: { FACTORY_JIRA_PROJECTS: "TLSSN" } } }), null);
  const unrelated = hook(merged);
  assert.equal(prStatusDispatch({ ...unrelated, pr: { ...unrelated.pr, headRef: "fix-typo", title: "TLSSN-9: fix typo", authorLogin: "example-user" }, deps: w.deps }), null);
  const skipped = w.logged().filter((line) => line["outcome"] !== "moved");
  assert.deepEqual(skipped.map((line) => line["reason"] ?? line["outcome"]), ["auto_merge", "not_human_merge", "config_error", "not_factory_pr"]);
});

type FakeRequest = <T>(input: { method: "GET" | "POST" | "PATCH"; path: string; body?: Record<string, unknown> }) => Promise<{ ok: boolean; status: number; body: T }>;

/** `getOctokit()` over the same fake, expanding the pulls route the way Octokit does. */
function octokitOver(request: FakeRequest) {
  return {
    request: async (route: string, params: Record<string, unknown> = {}) => {
      const [method = "GET", template = ""] = route.split(" ");
      const path = template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]));
      const { owner: _owner, repo: _repo, pull_number: _number, headers: _headers, ...body } = params;
      const response = await request({ method: method as "GET" | "POST", path, body });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      return { status: response.status, data: response.body };
    },
  };
}

/** A draft implement PR behind a GitHub whose GraphQL write fails with `writeStatus` until `heal()`. */
function draftPullRequest(w: ReturnType<typeof world>, writeStatus: number) {
  const state = { draft: true, broken: true, order: [] as string[] };
  const request: FakeRequest = async <T>(input: { method: string; path: string; body?: Record<string, unknown> }) => {
    state.order.push(`${input.method} ${input.path}`);
    if (input.method === "POST") {
      if (state.broken) return { ok: false, status: writeStatus, body: { message: "Missing x-cursor-github-repos header" } as T };
      state.draft = false;
      return { ok: true, status: 200, body: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } as T };
    }
    return { ok: true, status: 200, body: { body: "Jira: x", draft: state.draft, node_id: "PR_kwDO13" } as T };
  };
  const deps = { ...w.deps, github: { request, getOctokit: async () => octokitOver(request) }, readyRetryMs: [0, 0] };
  return { state, deps, heal: () => void (state.broken = false) };
}

test("marsbank#28: an opened PR the worker cannot undraft still moves to In Review, leaves one note, and throws so the delivery is retried", async () => {
  const w = world({ status: "In Progress", kv: await launchedKv() });
  const pr = draftPullRequest(w, 400);

  const opened = prStatusDispatch({ ...hook({ payload: { pull_request: { draft: true } } }), deps: pr.deps });
  assert.ok(opened !== null);
  await assert.rejects(opened.task(), PrStatusRetryableError);
  assert.equal(pr.state.draft, true);
  assert.equal(pr.state.order.filter((line) => line === "POST /graphql").length, 3, "tried three times in the task");
  assert.equal(w.tracker.status(), "In Review", "the status move never waits on the undraft");
  const ready = w.logged().filter((line) => line["worker"] === "pr_ready");
  assert.deepEqual(ready.map((line) => [line["outcome"], line["status"], line["attempts"], line["noted"]]), [["write_failed", 400, 3, "written"]]);
  const notes = () => w.tracker.comments.filter((comment) => comment.startsWith("Ready for review not marked on cursor-demo-lab/marsbank#13:"));
  assert.equal(notes().length, 1);
  assert.match(notes()[0]!, /write_failed, HTTP 400/);

  // Hosted admission redelivers the rejected task: still failing, no second note; the move is a recorded duplicate.
  const again = prStatusDispatch({ ...hook({ payload: { pull_request: { draft: true } } }), deps: pr.deps });
  await assert.rejects(again!.task(), PrStatusRetryableError);
  assert.equal(notes().length, 1, "one note per pull request");
  assert.deepEqual(w.moves(), ["71"]);

  // The agent's next push lands it once GitHub accepts the write.
  pr.heal();
  const pushed = prStatusDispatch({ ...hook({ action: "synchronize" }), deps: pr.deps });
  await pushed!.task();
  assert.equal(pr.state.draft, false, "Bugbot gets a ready PR without a person");
  assert.deepEqual(w.moves(), ["71"]);

  // Recorded ready: a person who drafts it again and pushes keeps it a draft.
  pr.state.draft = true;
  const before = pr.state.order.length;
  const drafted = prStatusDispatch({ ...hook({ action: "synchronize" }), deps: pr.deps });
  await drafted?.task();
  assert.equal(pr.state.order.length, before, "no GitHub call");
  assert.equal(pr.state.draft, true);
});

test("a PR the worker undrafts on open writes no note and does not throw", async () => {
  const w = world({ status: "In Progress", kv: await launchedKv() });
  const pr = draftPullRequest(w, 400);
  pr.heal();
  await prStatusDispatch({ ...hook(), deps: pr.deps })!.task();
  assert.equal(pr.state.draft, false);
  assert.equal(w.tracker.comments.some((comment) => comment.startsWith("Ready for review not marked")), false);
  assert.deepEqual(w.logged().filter((line) => line["worker"] === "pr_ready").map((line) => [line["mode"], line["outcome"]]), [["open", "marked_ready"]]);
});

test("with ctx.github, an opened implement PR gets its Slack line before the move, and an edit that drops it gets it back without a move", async () => {
  const slack = "https://example-workspace.slack.com/archives/C0EXAMPLE1/p1790370261284789";
  const jira = "https://example.atlassian.net/browse/TLSSN-9";
  const plan = ["Plan: TLSSN-9 CSV export", "Brief:", "Implement Jira TLSSN-9 on cursor-demo-lab/marsbank from main: CSV export", `Ticket: ${jira}`, `Slack thread: ${slack}`, "", "Problem: x"].join("\n");
  const tracker = fakeTracker({ status: "In Progress", comments: [plan] });
  const w = world({ status: "In Progress", kv: await launchedKv(), tracker });
  let body: string | null = `Jira: ${jira}\n\n## What changed\n- x`;
  let draft = true;
  let movesWhenReady: string[] | undefined;
  const order: string[] = [];
  const request = async <T>(input: { method: string; path: string; body?: Record<string, unknown> }) => {
    order.push(`${input.method} ${input.path}`);
    if (input.method === "PATCH") body = String(input.body?.["body"]);
    if (input.method === "POST") {
      draft = false;
      movesWhenReady = w.moves();
      return { ok: true, status: 200, body: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } as T };
    }
    return { ok: true, status: 200, body: { body, draft, node_id: "PR_kwDO13" } as T };
  };
  const github = { request, getOctokit: async () => octokitOver(request) };
  const deps = { ...w.deps, github };

  const opened = prStatusDispatch({ ...hook({ payload: { pull_request: { draft: true } } }), deps });
  assert.ok(opened !== null);
  await opened.task();
  assert.equal(draft, false, "Bugbot skips drafts, so the factory PR is ready for review");
  assert.deepEqual(movesWhenReady, [], "ready before In Review is announced");
  assert.equal(body, `Jira: ${jira}\nSlack: ${slack}\n\n## What changed\n- x`);
  assert.deepEqual(order, ["GET /repos/cursor-demo-lab/marsbank/pulls/13", "POST /graphql", "GET /repos/cursor-demo-lab/marsbank/pulls/13", "PATCH /repos/cursor-demo-lab/marsbank/pulls/13"]);
  assert.equal(w.tracker.status(), "In Review");
  assert.deepEqual(w.logged().filter((line) => line["worker"] === "pr_ready").map((line) => line["outcome"]), ["marked_ready"]);

  body = "## What changed\n- rewritten by the agent";
  const edited = prStatusDispatch({ ...hook({ action: "edited" }), deps });
  assert.ok(edited !== null, "an edit is not a move, but the description is still checked");
  await edited.task();
  assert.equal(body, `Jira: ${jira}\nSlack: ${slack}\n\n## What changed\n- rewritten by the agent`);
  assert.equal(order.filter((line) => line === "POST /graphql").length, 1, "an edit never marks ready");
  const bodyLines = w.logged().filter((line) => line["worker"] === "pr_body");
  assert.deepEqual(bodyLines.map((line) => [line["action"], line["outcome"]]), [["opened", "written"], ["edited", "written"]]);
  assert.deepEqual(w.moves(), ["71"], "the edit moved nothing");

  assert.equal(prStatusDispatch({ ...hook({ action: "edited" }), deps: w.deps }), null, "without ctx.github an edit is ignored as before");
});

// Hosted host.kv (July 0.2.13) has no compare-and-set: on the plain get/put kv the two concurrent deliveries both move, so this race only holds on the CAS branch.
describe("CAS path (ask 11)", () => {
  test("two concurrent deliveries of one opened event move the ticket once", async () => {
    const kv = await launchedKv({ cas: true });
    const tracker = fakeTracker({ status: "In Progress" });
    const a = world({ status: "In Progress", kv, tracker });
    const b = world({ status: "In Progress", kv, tracker });
    const outcomes = await Promise.all([advanceTicket(a.deps, IN_REVIEW), advanceTicket(b.deps, IN_REVIEW)]);
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome).sort(), ["in_flight", "moved"]);
    assert.deepEqual(a.moves(), ["71"]);
  });

  test("a skipped move's note is claimed with putIfAbsent: one note per stage, PR, and outcome", async () => {
    const kv = await launchedKv({ cas: true });
    const w = world({ status: "Planned", kv });
    assert.deepEqual(await advanceTicket(w.deps, IN_REVIEW), { outcome: "not_moved", move: "skipped_status", current: "Planned" });
    assert.deepEqual(await advanceTicket(w.deps, IN_REVIEW), { outcome: "not_moved", move: "skipped_status", current: "Planned" });
    assert.deepEqual(w.logged().map((line) => line["noted"]), ["written", "duplicate"]);
    assert.equal(w.tracker.comments.filter((comment) => comment.startsWith("In Review not set from")).length, 1);
  });
});

test("two concurrent opened deliveries for one PR, no compare-and-set: one claims the move and the other is in flight", async () => {
  const kv = await launchedKv();
  const tracker = fakeTracker({ status: "In Progress" });
  const [first, second] = racingStores(kv, { prefix: "pr-status/", after: "readBack", passReads: 1 });
  const lines: string[] = [];
  const deps = (store: HostKvApi) => ({ kv: store, mcp: tracker.mcp, env: ENV, now: () => NOW, log: (line: string) => lines.push(line), sleep: tick });
  const outcomes = await Promise.all([advanceTicket(deps(first), IN_REVIEW), advanceTicket(deps(second), IN_REVIEW)]);
  assert.deepEqual(outcomes.map((outcome) => outcome.outcome).sort(), ["in_flight", "moved"]);
  assert.equal(tracker.calls.filter((call) => call.tool === "transitionJiraIssue").length, 1);
  assert.deepEqual(kv.entries.get(prStatusClaimKey(IN_REVIEW)), { state: "moved", at: NOW.toISOString(), outcome: "transitioned" });
  const claims = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => "claim" in line);
  assert.deepEqual(claims.map((line) => line["claim"]).sort(), ["claimed", "in_flight"]);
});

test("a move claim that cannot be confirmed releases this delivery's put and throws for a retry", async () => {
  const kv = await launchedKv();
  const key = prStatusClaimKey(IN_REVIEW);
  let reads = 0;
  const flaky: MemoryKv = {
    ...kv,
    get: async (k) => {
      if (k === key) {
        reads += 1;
        if (reads >= 3 && reads <= 5) throw new Error("kv read failed");
      }
      return kv.get(k);
    },
  };
  const w = world({ status: "In Progress", kv: flaky });
  await assert.rejects(advanceTicket(w.deps, IN_REVIEW), PrStatusRetryableError);
  assert.equal(kv.entries.has(key), false);
  assert.deepEqual(w.logged().at(-1)?.["released"], "released");
  assert.deepEqual(w.moves(), []);
});

test("a release after a move that did not land, or that threw, keeps a rival's claim that appeared meanwhile", async () => {
  const rival = { state: "pending", at: NOW.toISOString(), owner: "rival" };
  for (const failure of ["not_moved", "threw"] as const) {
    const kv = await launchedKv();
    const key = prStatusClaimKey(IN_REVIEW);
    // Planned is not In Progress, so the In Review move is skipped; `threw` makes the move itself throw instead.
    const tracker = fakeTracker({ status: "Planned" });
    const { callTool, names } = tracker.mcp;
    let linked = false;
    let rivalWritten = false;
    // The rival lands once, on the first Jira call after the claim, so a later
    // call (noteSkip's comment runs after the release) cannot put it back.
    tracker.mcp.callTool = async (connection, tool, args) => {
      if (!rivalWritten) {
        rivalWritten = true;
        await kv.put(key, rival);
      }
      if (tool === "addCommentToJiraIssue") linked = true;
      return callTool(connection, tool, args);
    };
    // The PR link comment lands before the move; after it, the registry throws inside the guarded move.
    tracker.mcp.names = () => {
      if (failure === "threw" && linked) throw new Error("connector down");
      return names();
    };
    const w = world({ status: "Planned", kv, tracker });
    if (failure === "threw") await assert.rejects(advanceTicket(w.deps, IN_REVIEW), PrStatusRetryableError);
    else assert.equal((await advanceTicket(w.deps, IN_REVIEW)).outcome, "not_moved");
    assert.deepEqual(kv.entries.get(key), rival, failure);
    assert.equal(w.logged().at(-1)?.["outcome"], failure === "threw" ? "move_threw" : "not_moved");
  }
});
