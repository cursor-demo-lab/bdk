import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpSessionAdmitError } from "@cursor/july/channels";
import type { AuthContext } from "@cursor/july/channels";
import { mergeCloudOptions } from "../../node_modules/@cursor/july/dist/internal/cloud-merge.js";
import {
  dispatchHttpControlPlaneSession,
  parseControlPlaneSessionPayload,
} from "../../node_modules/@cursor/july/dist/internal/http-control-plane-session.js";
import { statusForThrownRequestError } from "../../node_modules/@cursor/july/dist/internal/request-error-status.js";
import { MANAGED_HOSTING_ENV } from "../lib/checkout.js";
import httpOverride, { gateHttpSession } from "./http.js";

const HOSTED = { [MANAGED_HOSTING_ENV]: "7" };
const PRINCIPAL: AuthContext = { authenticator: "local-dev-strict", principalId: "local", principalType: "user" };

test("off managed hosting the gate passes every HTTP session send through unchanged", () => {
  assert.equal(gateHttpSession("plan TLSSN-42", PRINCIPAL, {}), "plan TLSSN-42");
  assert.equal(gateHttpSession("plan TLSSN-42", null, {}), "plan TLSSN-42");
  assert.equal(gateHttpSession("plan TLSSN-42", PRINCIPAL, { [MANAGED_HOSTING_ENV]: "  " }), "plan TLSSN-42");
});

test("under the hosted posture a mounted-route send (any admitted principal) is refused as a 400, never a turn", () => {
  for (const auth of [PRINCIPAL, { authenticator: "bearer", principalId: "svc", principalType: "service" } satisfies AuthContext]) {
    let thrown: unknown;
    try {
      gateHttpSession("plan TLSSN-42", auth, HOSTED);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof HttpSessionAdmitError, auth.authenticator);
    // July's handleRequest maps HttpSessionAdmitError to a 400 invalid_request
    // (request-error-status.js), so the refusal is a clean reject, not a 500.
    assert.equal(statusForThrownRequestError(thrown), 400);
  }
});

test("under the hosted posture control-plane admissions (auth null) still pass, so hosted ask and playground keep working", () => {
  assert.equal(gateHttpSession("probe step 2", null, HOSTED), "probe step 2");
});

test("the channel override wires the gate into onMessage of the built-in http channel", async () => {
  assert.equal(typeof httpOverride.onMessage, "function");
  assert.equal(await httpOverride.onMessage?.("hello", { auth: null }), "hello");
});

// Pins on the July 0.2.18 behavior the gate and the docs' "no auto PR"
// claim rely on. If an upgrade changes either, these fail and the posture
// must be re-verified (docs/deployment-issues.md issue 24).

test("July pin: a hosted agentsdk.session payload carrying `cloud` is refused before any authored code runs", () => {
  const parsed = parseControlPlaneSessionPayload({ message: "hi", cloud: { autoCreatePR: true } });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.error, "payload carries an unsupported field");
  assert.equal(parseControlPlaneSessionPayload({ message: "hi" }).ok, true);
});

test("July pin: the hosted admission dispatch calls onMessage with auth null, so the gate never fires in production", async () => {
  const sent: string[] = [];
  const response = await dispatchHttpControlPlaneSession({
    eventType: "agentsdk.session",
    payload: { message: "plan TLSSN-42" },
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
  assert.deepEqual(sent, ["plan TLSSN-42"]);
  assert.equal(response.status, 200);
});

test("July pin: a hosted admission with a cloud override never reaches send", async () => {
  const sent: string[] = [];
  const response = await dispatchHttpControlPlaneSession({
    eventType: "agentsdk.session",
    payload: { message: "plan TLSSN-42", cloud: { autoCreatePR: true, repos: [] } },
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

test("July pin: the per-session cloud override wins the merge, which is why the mounted route must be gated", () => {
  const merged = mergeCloudOptions({
    base: { autoCreatePR: false, repos: [{ url: "https://github.com/cursor-demo-lab/marsbank", startingRef: "main" }] },
    override: { autoCreatePR: true, repos: [{ url: "https://github.com/evil/repo" }] },
  });
  assert.equal(merged?.autoCreatePR, true);
  assert.deepEqual(merged?.repos, [{ url: "https://github.com/evil/repo" }]);
});
