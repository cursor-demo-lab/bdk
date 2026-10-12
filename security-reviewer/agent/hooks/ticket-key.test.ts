import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostGitHubClient } from "@cursor/july";
import { TICKET_KEY_ATTRIBUTE } from "../lib/factory-otel.js";
import { forgetPrTickets } from "../lib/pr-ticket.js";
import hook from "./ticket-key.js";

// The hook as the host dispatches it: one event, a stub context with the
// GitHub channel's state, host.github, and host.otel.

const ENV = { FACTORY_JIRA_PROJECTS: "TLSSN" } as const;
const saved: Record<string, string | undefined> = {};

before(() => {
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});

after(() => {
  forgetPrTickets();
  for (const name of Object.keys(ENV)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

type Handler = (event: { turnId?: string; data: Record<string, unknown> }, ctx: unknown) => Promise<void> | void;
const events = hook.events as unknown as Record<string, Handler>;

type PullRead = { owner: string; repo: string; pull_number: number };

// Each case is its own session: pr-ticket.ts reads a PR once per session.
let sessions = 0;

function context(input: { channelState?: unknown; pull?: { headRef: string; title: string }; throwing?: boolean }) {
  const tags: Array<Record<string, unknown>> = [];
  const reads: PullRead[] = [];
  const otel = {
    setAttributes: (attributes: Record<string, unknown>) => {
      if (input.throwing === true) throw new Error("no collector");
      tags.push(attributes);
    },
  };
  const github = {
    getOctokit: async () => ({
      request: async (_route: string, params: PullRead) => {
        reads.push(params);
        if (input.pull === undefined) throw new Error("HttpError: Not Found");
        return { data: { head: { ref: input.pull.headRef }, title: input.pull.title } };
      },
    }),
  } as unknown as HostGitHubClient;
  const ctx = {
    session: { id: `ses_review_${++sessions}`, channelId: "github", title: null },
    channel: { id: "github", continuationToken: "evt:0123abcd" },
    channelState: input.channelState ?? null,
    host: { github, otel },
  };
  return { ctx, tags, reads };
}

test("a review of a factory PR: the channel state's head branch names the key, no read", async () => {
  const { ctx, tags, reads } = context({ channelState: { owner: "acme", repo: "shop", pullRequestNumber: 42, headRef: "TLSSN-7-fix-checkout" } });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-7" }]);
  assert.deepEqual(reads, []);
});

test("a review of a PR whose branch has no key: one read, the title names the key", async () => {
  const { ctx, tags, reads } = context({ channelState: { owner: "acme", repo: "shop", pullRequestNumber: 43, headRef: "cursor/fix-2689" }, pull: { headRef: "cursor/fix-2689", title: "TLSSN-8: fix" } });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-8" }]);
  assert.deepEqual(reads, [{ owner: "acme", repo: "shop", pull_number: 43 }]);
});

test("a PR with no key anywhere, or no PR at all (playground), is `none`, a fixed value", async () => {
  const unkeyed = context({ channelState: { owner: "acme", repo: "shop", pullRequestNumber: 44, headRef: "feature/x" }, pull: { headRef: "feature/x", title: "Tidy up" } });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, unkeyed.ctx);
  assert.deepEqual(unkeyed.tags, [{ [TICKET_KEY_ATTRIBUTE]: "none" }]);
  const chat = context({});
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, chat.ctx);
  assert.deepEqual(chat.tags, [{ [TICKET_KEY_ATTRIBUTE]: "none" }]);
  assert.deepEqual(chat.reads, []);
});

test("a failed PR read is `none`, not a failed turn", async () => {
  const { ctx, tags } = context({ channelState: { owner: "acme", repo: "shop", pullRequestNumber: 45, headRef: "cursor/x" } });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "none" }]);
});

test("a host.otel that throws never fails the turn", async () => {
  const { ctx } = context({ channelState: { headRef: "TLSSN-7-x" }, throwing: true });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
});

test("a review of many turns reads its PR once: every later turn.started on the session tags from memory", async () => {
  const { ctx, tags, reads } = context({ channelState: { owner: "acme", repo: "shop", pullRequestNumber: 46, headRef: "cursor/review-2689" }, pull: { headRef: "cursor/review-2689", title: "TLSSN-11: review" } });
  for (const turn of ["trn_1", "trn_2"]) await events["turn.started"]!({ turnId: turn, data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-11" }, { [TICKET_KEY_ATTRIBUTE]: "TLSSN-11" }]);
  assert.deepEqual(reads, [{ owner: "acme", repo: "shop", pull_number: 46 }]);
});

test("the hook listens to turn.started only", () => {
  assert.deepEqual(Object.keys(events), ["turn.started"]);
});
