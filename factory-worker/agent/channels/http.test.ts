import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpSessionAdmitError } from "@cursor/july/channels";
import type { AuthContext } from "@cursor/july/channels";
import { dispatchHttpControlPlaneSession, parseControlPlaneSessionPayload } from "../../node_modules/@cursor/july/dist/internal/http-control-plane-session.js";
import { statusForThrownRequestError } from "../../node_modules/@cursor/july/dist/internal/request-error-status.js";
import { MANAGED_HOSTING_ENV } from "../lib/implement-turn.js";
import httpOverride, { gateHttpSession } from "./http.js";

const HOSTED = { [MANAGED_HOSTING_ENV]: "7" };
const PRINCIPAL: AuthContext = { authenticator: "local-dev-strict", principalId: "local", principalType: "user" };

test("off managed hosting the gate passes every HTTP session send through unchanged", () => {
  assert.equal(gateHttpSession("hello", PRINCIPAL, {}), "hello");
  assert.equal(gateHttpSession("hello", null, {}), "hello");
  assert.equal(gateHttpSession("hello", PRINCIPAL, { [MANAGED_HOSTING_ENV]: "  " }), "hello");
});

test("under the hosted posture a mounted-route send (any admitted principal) is refused as a 400, never a turn", () => {
  for (const auth of [PRINCIPAL, { authenticator: "bearer", principalId: "svc", principalType: "service" } satisfies AuthContext]) {
    let thrown: unknown;
    try {
      gateHttpSession("hello", auth, HOSTED);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof HttpSessionAdmitError, auth.authenticator);
    assert.equal(statusForThrownRequestError(thrown), 400);
  }
});

test("under the hosted posture control-plane admissions (auth null) still pass, so a hosted direct chat keeps working", () => {
  assert.equal(gateHttpSession("hello", null, HOSTED), "hello");
});

test("the channel override wires the gate into onMessage of the built-in http channel", async () => {
  assert.equal(typeof httpOverride.onMessage, "function");
  assert.equal(await httpOverride.onMessage?.("hello", { auth: null }), "hello");
});

// Pins on the July behavior the gate relies on, since agent.ts declares no
// `tools` (the implement turn is a cloud turn, which July refuses on an agent
// with a tool allowlist). If an upgrade changes either, these fail and the
// posture must be re-verified.

test("July pin: a hosted agentsdk.session payload carrying `cloud` is refused before any authored code runs", () => {
  const parsed = parseControlPlaneSessionPayload({ message: "hi", cloud: { autoCreatePR: true } });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.error, "payload carries an unsupported field");
  assert.equal(parseControlPlaneSessionPayload({ message: "hi" }).ok, true);
});

test("July pin: the hosted admission dispatch calls onMessage with auth null, so the gate never fires on a hosted chat", async () => {
  const sent: string[] = [];
  const response = await dispatchHttpControlPlaneSession({
    eventType: "agentsdk.session",
    payload: { message: "hello" },
    args: {
      send: async (message: string) => {
        sent.push(message);
        return { id: "ses_1", isNew: true, continuationToken: "tok" };
      },
      host: {},
    },
    mailboxContinuationKey: "mail_1",
    onMessage: (message: string, info: { auth: AuthContext | null }) => gateHttpSession(message, info.auth, HOSTED),
  } as never);
  assert.deepEqual(sent, ["hello"]);
  assert.equal(response.status, 200);
});

test("July pin: a hosted admission with a cloud override never reaches send", async () => {
  const sent: string[] = [];
  const response = await dispatchHttpControlPlaneSession({
    eventType: "agentsdk.session",
    payload: { message: "hello", cloud: { autoCreatePR: true, repos: [] } },
    args: {
      send: async (message: string) => {
        sent.push(message);
        return { id: "ses_1", isNew: true, continuationToken: "tok" };
      },
      host: {},
    },
    mailboxContinuationKey: "mail_1",
    onMessage: (message: string, info: { auth: AuthContext | null }) => gateHttpSession(message, info.auth, HOSTED),
  } as never);
  assert.deepEqual(sent, []);
  assert.equal(response.status, 400);
});
