import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { HostGitHubClient } from "@cursor/july";
import { forgetPrTickets, PR_READ_BUDGET_MS, prFromChannelState, prTicketKey } from "./pr-ticket.js";

// July's GitHubChannelState as the channel stores it for a PR session.
const STATE = { owner: "acme", repo: "shop", pullRequestNumber: 42, headRef: "TLSSN-7-fix-checkout", eventType: "pull_request" };

type PullRead = { owner: string; repo: string; pull_number: number };

function github(input: { headRef: string; title: string; fail?: boolean; hangMs?: number }) {
  const reads: PullRead[] = [];
  const client = {
    getOctokit: async () => ({
      request: async (route: string, params: PullRead) => {
        assert.equal(route, "GET /repos/{owner}/{repo}/pulls/{pull_number}");
        reads.push(params);
        if (input.hangMs !== undefined) await new Promise((resolve) => setTimeout(resolve, input.hangMs));
        if (input.fail === true) throw new Error("HttpError: Not Found");
        return { data: { head: { ref: input.headRef }, title: input.title } };
      },
    }),
  } as unknown as HostGitHubClient;
  return { client, reads };
}

after(() => forgetPrTickets());

test("prFromChannelState: the PR and head branch of a GitHub channel state; `{}` for anything else", () => {
  assert.deepEqual(prFromChannelState(STATE), { pr: { owner: "acme", repo: "shop", number: 42 }, headRef: "TLSSN-7-fix-checkout" });
  assert.deepEqual(prFromChannelState({ owner: "acme", repo: "shop", pullRequestNumber: 42 }), { pr: { owner: "acme", repo: "shop", number: 42 } });
  assert.deepEqual(prFromChannelState({ headRef: "main" }), { headRef: "main" });
  assert.deepEqual(prFromChannelState({ owner: "acme", repo: "shop", pullRequestNumber: 0 }), {});
  assert.deepEqual(prFromChannelState({ owner: "", repo: "shop", pullRequestNumber: 1 }), {});
  assert.deepEqual(prFromChannelState({ owner: "acme", repo: "shop", pullRequestNumber: "42" }), {});
  assert.deepEqual(prFromChannelState(null), {});
  assert.deepEqual(prFromChannelState("pr:acme/shop#42"), {});
  assert.deepEqual(prFromChannelState([STATE]), {});
});

test("a factory PR: the head branch in the channel state names the key, no read", async () => {
  const { client, reads } = github({ headRef: "other", title: "other" });
  assert.equal(await prTicketKey({ state: STATE, github: client, projects: ["TLSSN"] }), "TLSSN-7");
  assert.deepEqual(reads, []);
});

test("a branch that does not name the key: one read of the PR named by the state, the branch first, then the title", async () => {
  const state = { ...STATE, headRef: "cursor/fix-checkout-2689" };
  const branch = github({ headRef: "TLSSN-8-fix", title: "Fix checkout" });
  assert.equal(await prTicketKey({ state, github: branch.client, projects: ["TLSSN"] }), "TLSSN-8");
  assert.deepEqual(branch.reads, [{ owner: "acme", repo: "shop", pull_number: 42 }]);
  const title = github({ headRef: "cursor/fix-checkout-2689", title: "TLSSN-9: fix checkout" });
  assert.equal(await prTicketKey({ state, github: title.client, projects: ["TLSSN"] }), "TLSSN-9");
  const neither = github({ headRef: "cursor/fix-checkout-2689", title: "Fix checkout (TLSSN-9)" });
  assert.equal(await prTicketKey({ state, github: neither.client, projects: ["TLSSN"] }), undefined, "a key not at the start is not the PR's key");
});

test("`pr` names the PR to read when the state does not (a drive session's title or token)", async () => {
  const { client, reads } = github({ headRef: "TLSSN-10-x", title: "x" });
  assert.equal(await prTicketKey({ state: null, pr: { owner: "acme", repo: "shop", number: 5 }, github: client, projects: ["TLSSN"] }), "TLSSN-10");
  assert.deepEqual(reads, [{ owner: "acme", repo: "shop", pull_number: 5 }]);
});

test("the key must be from a configured project; no projects means no key and no read", async () => {
  const { client, reads } = github({ headRef: "TLSSN-7-fix", title: "TLSSN-7" });
  assert.equal(await prTicketKey({ state: STATE, github: client, projects: ["DEMO"] }), undefined);
  assert.deepEqual(reads, [{ owner: "acme", repo: "shop", pull_number: 42 }], "a DEMO key could still be in the title");
  assert.equal(await prTicketKey({ state: STATE, github: client, projects: [] }), undefined);
  assert.deepEqual(reads.length, 1);
});

test("no PR, no client, or a failed read is undefined, never a throw", async () => {
  const { client } = github({ headRef: "TLSSN-7-fix", title: "x", fail: true });
  assert.equal(await prTicketKey({ state: { headRef: "cursor/x" }, github: client, projects: ["TLSSN"] }), undefined, "no PR to read");
  assert.equal(await prTicketKey({ state: { ...STATE, headRef: "cursor/x" }, github: undefined, projects: ["TLSSN"] }), undefined, "no client");
  assert.equal(await prTicketKey({ state: { ...STATE, headRef: "cursor/x" }, github: client, projects: ["TLSSN"] }), undefined, "a read that fails");
});

test("with a session id the read is made once per session, whatever it answered; another session reads again; no session id, no memory", async () => {
  const state = { ...STATE, headRef: "cursor/fix-2689" };
  const keyed = github({ headRef: "TLSSN-12-x", title: "x" });
  assert.equal(await prTicketKey({ state, github: keyed.client, projects: ["TLSSN"], sessionId: "ses_1" }), "TLSSN-12");
  assert.equal(await prTicketKey({ state, github: keyed.client, projects: ["TLSSN"], sessionId: "ses_1" }), "TLSSN-12");
  assert.equal(await prTicketKey({ state, github: keyed.client, projects: ["TLSSN"], sessionId: "ses_1" }), "TLSSN-12");
  assert.equal(keyed.reads.length, 1, "a drive's many turns read once");
  assert.equal(await prTicketKey({ state, github: keyed.client, projects: ["TLSSN"], sessionId: "ses_2" }), "TLSSN-12");
  assert.equal(keyed.reads.length, 2, "another session is another read");
  const failing = github({ headRef: "x", title: "x", fail: true });
  assert.equal(await prTicketKey({ state, github: failing.client, projects: ["TLSSN"], sessionId: "ses_3" }), undefined);
  assert.equal(await prTicketKey({ state, github: failing.client, projects: ["TLSSN"], sessionId: "ses_3" }), undefined);
  assert.equal(failing.reads.length, 1, "a failed read is the session's answer too: GitHub is not retried on every turn");
  assert.equal(await prTicketKey({ state, github: keyed.client, projects: ["TLSSN"] }), "TLSSN-12");
  assert.equal(await prTicketKey({ state, github: keyed.client, projects: ["TLSSN"] }), "TLSSN-12");
  assert.equal(keyed.reads.length, 4, "no session id: nothing remembered");
  const unread = github({ headRef: "x", title: "x" });
  assert.equal(await prTicketKey({ state: STATE, github: unread.client, projects: ["TLSSN"], sessionId: "ses_1" }), "TLSSN-7", "the branch answers before any memory is consulted");
  assert.deepEqual(unread.reads, []);
});

test("a read slower than the budget is undefined (`none`) for that session, and the turn's events are not held", async () => {
  assert.equal(PR_READ_BUDGET_MS, 2_000);
  const state = { ...STATE, headRef: "cursor/fix-2689" };
  const slow = github({ headRef: "TLSSN-13-x", title: "x", hangMs: 200 });
  const started = Date.now();
  assert.equal(await prTicketKey({ state, github: slow.client, projects: ["TLSSN"], sessionId: "ses_slow", budgetMs: 20 }), undefined);
  assert.ok(Date.now() - started < 150, "answered at the budget, not at the read");
  assert.equal(await prTicketKey({ state, github: slow.client, projects: ["TLSSN"], sessionId: "ses_slow", budgetMs: 20 }), undefined, "the session's answer stays `none`");
  assert.equal(slow.reads.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(await prTicketKey({ state, github: slow.client, projects: ["TLSSN"], sessionId: "ses_slow", budgetMs: 20 }), undefined, "the late answer is dropped, not remembered");
  const quick = github({ headRef: "TLSSN-14-x", title: "x", hangMs: 5 });
  assert.equal(await prTicketKey({ state, github: quick.client, projects: ["TLSSN"], sessionId: "ses_quick", budgetMs: 500 }), "TLSSN-14", "a read within the budget answers");
});
