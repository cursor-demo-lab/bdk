import assert from "node:assert/strict";
import test from "node:test";
import { actuate } from "./actuate.js";
import { calibrateSeverity, issueText } from "./jev-triage.js";

const str = { type: "string" };
const LOG_OUT = 'The "Log out" button logs you out straight away even when the transfer form has something typed in. Could it ask to confirm first when the form has input?';

function tracker() {
  const calls: { tool: string; args: Record<string, unknown> | undefined }[] = [];
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [
      { name: "createComment", inputSchema: { type: "object", properties: { issueId: str, body: str } } },
      { name: "updateIssue", inputSchema: { type: "object", properties: { id: str, priority: { type: "number" } } } },
    ],
    callTool: async (_connection: string, tool: string, args?: Record<string, unknown>) => {
      calls.push({ tool, args });
      return { content: [{ type: "text", text: tool === "listComments" ? "[]" : "ok" }] };
    },
  };
  return { calls, mcp };
}

test("the tracker priority follows the capped severity, not the model's urgent", async () => {
  const h = tracker();
  const severity = calibrateSeverity({ text: issueText({ title: "Log out asks no confirmation", description: LOG_OUT }), type: "bug", severity: "urgent" });
  assert.equal(severity, "medium");
  await actuate({
    verdict: { identifier: "ENG-7", kind: "bug", severity, title: "Log out asks no confirmation", summary: LOG_OUT, nextStep: "Add a confirm." },
    mcp: h.mcp as never,
    tracker: { kind: "linear", connectionName: "tracker" },
    issueKey: "ENG-7",
    issueTitle: "Log out asks no confirmation",
  });
  assert.deepEqual(h.calls.find((call) => call.tool === "updateIssue")?.args, { id: "ENG-7", priority: 3 });
});
