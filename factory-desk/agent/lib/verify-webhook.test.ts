import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyTrackerWebhook } from "./verify-webhook.js";

const SECRET = "test-jira-secret";
const BODY = JSON.stringify({ webhookEvent: "jira:issue_updated", issue: { key: "TLSSN-42" } });
const NOW = 1_790_000_000_000;

function hmac(secret: string, raw = BODY): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

function verify(overrides: Partial<Parameters<typeof verifyTrackerWebhook>[0]> = {}) {
  return verifyTrackerWebhook({
    rawBody: BODY,
    linearSignature: null,
    hubSignature: null,
    factoryWebhookSecret: null,
    authorization: null,
    linearSecret: undefined,
    jiraSecret: SECRET,
    nowMs: NOW,
    ...overrides,
  });
}

test("HMAC X-Hub-Signature-256 still verifies", () => {
  assert.deepEqual(verify({ hubSignature: hmac(SECRET) }), { ok: true });
  assert.deepEqual(verify({ hubSignature: hmac(SECRET).replace(/^sha256=/i, "") }), { ok: true });
  assert.deepEqual(verify({ hubSignature: hmac(SECRET).replace("sha256=", "SHA256=") }), { ok: true });
});

test("X-Factory-Webhook-Secret matches the shared secret", () => {
  assert.deepEqual(verify({ factoryWebhookSecret: SECRET }), { ok: true });
});

test("Authorization Bearer matches the shared secret", () => {
  assert.deepEqual(verify({ authorization: `Bearer ${SECRET}` }), { ok: true });
  assert.deepEqual(verify({ authorization: `bearer ${SECRET}` }), { ok: true });
});

test("wrong or missing auth is refused", () => {
  assert.deepEqual(verify({}), { ok: false, status: 401 });
  assert.deepEqual(verify({ hubSignature: hmac("other-secret") }), { ok: false, status: 401 });
  assert.deepEqual(verify({ factoryWebhookSecret: "other-secret" }), { ok: false, status: 401 });
  assert.deepEqual(verify({ authorization: "Bearer other-secret" }), { ok: false, status: 401 });
  assert.deepEqual(verify({ authorization: SECRET }), { ok: false, status: 401 });
  assert.deepEqual(verify({ jiraSecret: undefined, factoryWebhookSecret: SECRET }), { ok: false, status: 401 });
  assert.deepEqual(verify({ jiraSecret: "", factoryWebhookSecret: SECRET }), { ok: false, status: 401 });
  assert.deepEqual(verify({ factoryWebhookSecret: "" }), { ok: false, status: 401 });
});

test("HMAC and header secret together are accepted when either is valid", () => {
  assert.deepEqual(verify({ hubSignature: hmac(SECRET), factoryWebhookSecret: SECRET }), { ok: true });
  assert.deepEqual(verify({ hubSignature: hmac("other-secret"), factoryWebhookSecret: SECRET }), { ok: true });
  assert.deepEqual(verify({ hubSignature: hmac(SECRET), factoryWebhookSecret: "other-secret" }), { ok: true });
  assert.deepEqual(verify({ hubSignature: hmac(SECRET), authorization: "Bearer other-secret" }), { ok: true });
  assert.deepEqual(verify({ hubSignature: hmac("other-secret"), factoryWebhookSecret: "other-secret" }), {
    ok: false,
    status: 401,
  });
});

test("a Linear signature still uses HMAC and the replay window", () => {
  const linearSecret = "test-linear-secret";
  const rawBody = JSON.stringify({ webhookTimestamp: NOW });
  const linearSignature = createHmac("sha256", linearSecret).update(rawBody).digest("hex");
  assert.deepEqual(verify({ rawBody, linearSignature, linearSecret, nowMs: NOW }), { ok: true });
  assert.deepEqual(
    verify({ rawBody, linearSignature: "00", linearSecret, factoryWebhookSecret: SECRET, nowMs: NOW }),
    { ok: false, status: 401 }
  );
});
