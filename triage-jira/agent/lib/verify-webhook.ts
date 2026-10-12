import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const REPLAY_WINDOW_MS = 60_000;

export type VerifyWebhookResult =
  | { ok: true }
  | { ok: false; status: 401 };

/**
 * Linear: HMAC `Linear-Signature` over the raw body.
 * Jira: accept either HMAC `X-Hub-Signature` / `X-Hub-Signature-256`
 * (system webhooks and `e2e-drive --replay`) or a timing-safe match of
 * `JIRA_WEBHOOK_SECRET` against `X-Factory-Webhook-Secret` or
 * `Authorization: Bearer <secret>` (project Automation). Unsigned
 * deliveries are refused.
 */
export function verifyTrackerWebhook(input: {
  rawBody: string;
  linearSignature: string | null;
  hubSignature: string | null;
  factoryWebhookSecret?: string | null;
  authorization?: string | null;
  linearSecret: string | undefined;
  jiraSecret: string | undefined;
  nowMs: number;
}): VerifyWebhookResult {
  if (input.linearSignature !== null && input.linearSignature !== "") {
    if (
      input.linearSecret === undefined ||
      input.linearSecret === "" ||
      !hmacHexEqual(input.linearSecret, input.rawBody, input.linearSignature)
    ) {
      return { ok: false, status: 401 };
    }
    return linearReplayFresh(input.rawBody, input.nowMs);
  }

  const jiraSecret = input.jiraSecret;
  if (jiraSecret !== undefined && jiraSecret !== "") {
    if (
      input.hubSignature !== null &&
      input.hubSignature !== "" &&
      hmacHexEqual(jiraSecret, input.rawBody, input.hubSignature)
    ) {
      return { ok: true };
    }
    if (sharedSecretMatches(jiraSecret, input.factoryWebhookSecret, input.authorization)) {
      return { ok: true };
    }
  }

  return { ok: false, status: 401 };
}

function sharedSecretMatches(
  expected: string,
  factoryWebhookSecret: string | null | undefined,
  authorization: string | null | undefined
): boolean {
  const candidates: string[] = [];
  if (typeof factoryWebhookSecret === "string" && factoryWebhookSecret !== "") {
    candidates.push(factoryWebhookSecret);
  }
  const bearer = bearerToken(authorization);
  if (bearer !== null) candidates.push(bearer);
  return candidates.some((candidate) => secretEqual(expected, candidate));
}

function bearerToken(authorization: string | null | undefined): string | null {
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(\S+)/i.exec(authorization.trim());
  const token = match?.[1] ?? "";
  return token === "" ? null : token;
}

function secretEqual(expected: string, received: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const receivedDigest = createHash("sha256").update(received, "utf8").digest();
  return timingSafeEqual(expectedDigest, receivedDigest);
}

function linearReplayFresh(
  rawBody: string,
  nowMs: number
): VerifyWebhookResult {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 401 };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 401 };
  }
  const timestamp = (body as { webhookTimestamp?: unknown }).webhookTimestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return { ok: false, status: 401 };
  }
  if (Math.abs(nowMs - timestamp) > REPLAY_WINDOW_MS) {
    return { ok: false, status: 401 };
  }
  return { ok: true };
}

function hmacHexEqual(secret: string, rawBody: string, header: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = header.replace(/^sha256=/i, "").trim().toLowerCase();
  let expectedBytes: Buffer;
  let receivedBytes: Buffer;
  try {
    expectedBytes = Buffer.from(expected, "hex");
    receivedBytes = Buffer.from(received, "hex");
  } catch {
    return false;
  }
  return (
    expectedBytes.length > 0 &&
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}
