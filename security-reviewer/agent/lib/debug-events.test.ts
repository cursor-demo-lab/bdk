import assert from "node:assert/strict";
import { test } from "node:test";
import { debugEvent, logDebugEvent } from "./debug-events.js";

const delivery = {
  deliveryId: "d-1",
  eventName: "pull_request",
  repository: { fullName: "cursor-demo-lab/marsbank" },
  conversation: { number: 8 },
  sender: { login: "example-user", type: "User" },
  installationId: 155310938,
};

test("a record carries the delivery fields and the pull request facts", () => {
  const event = debugEvent({
    ctx: delivery,
    action: "opened",
    decision: "review",
    at: "2026-09-23T06:00:00.000Z",
    facts: { watches: true, draft: false, dispatched: true },
  });
  assert.deepEqual(event, {
    at: "2026-09-23T06:00:00.000Z",
    event: "pull_request",
    action: "opened",
    repo: "cursor-demo-lab/marsbank",
    number: 8,
    sender: "example-user",
    isBot: false,
    decision: "review",
    deliveryId: "d-1",
    installationId: 155310938,
    watches: true,
    draft: false,
    dispatched: true,
  });
});

test("bots are flagged by type or by a [bot] login, and a missing number or sender is null", () => {
  const byType = debugEvent({ ctx: { ...delivery, sender: { login: "cursor", type: "Bot" } }, action: "created", decision: "ignored_comment" });
  assert.equal(byType.isBot, true);
  const byLogin = debugEvent({ ctx: { ...delivery, sender: undefined, senderLogin: "cursor[bot]" }, action: undefined, decision: "ignored_comment" });
  assert.equal(byLogin.isBot, true);
  assert.equal(byLogin.sender, "cursor[bot]");
  assert.equal(byLogin.action, null);
  const bare = debugEvent({
    ctx: { eventName: "issue_comment", repository: { fullName: "a/b" }, conversation: { number: 0 } },
    action: "created",
    decision: "ignored_comment",
  });
  assert.equal(bare.number, null);
  assert.equal(bare.sender, null);
  assert.equal(bare.isBot, false);
  assert.equal(bare.deliveryId, null);
  assert.equal(bare.installationId, null);
});

test("each record is one JSON log line tagged github-event", () => {
  const lines: string[] = [];
  const event = debugEvent({ ctx: delivery, action: "opened", decision: "review", at: "2026-09-23T06:00:00.000Z" });
  logDebugEvent(event, (line) => lines.push(line));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), { factoryDebug: "github-event", ...event });
});
