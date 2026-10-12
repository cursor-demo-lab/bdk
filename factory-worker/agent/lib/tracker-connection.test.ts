import assert from "node:assert/strict";
import { test } from "node:test";
import tracker from "../host-connections/tracker.js";

test("the tracker connection targets the factory's own team Atlassian MCP server", () => {
  const connection = tracker as unknown as { cursorAccount?: unknown; servers?: unknown };
  assert.equal(connection.cursorAccount, true);
  assert.deepEqual(connection.servers, ["Factory Atlassian"]);
});
