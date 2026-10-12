import type { ReminderCreateInput, ReminderHostApi, ReminderInfo } from "@cursor/july";
import type { ReadyApi } from "../pr-ready.js";

export type Pull = { number: number; head: string; state: "open" | "closed"; draft: boolean };
export type Call = { route: string; params: Record<string, unknown> };
export type FakeGitHub = ReturnType<typeof fakeGitHub>;

/** Octokit as July's `host.github.getOctokit()` returns it: a non-2xx is a thrown error carrying `status`. */
export function fakeGitHub(options: { pulls?: Pull[]; branches?: string[]; defaultBranch?: string; createStatus?: number; raceOnCreate?: Pull } = {}) {
  const pulls = [...(options.pulls ?? [])];
  const calls: Call[] = [];
  const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
  const github: ReadyApi = {
    getOctokit: async () => ({
      request: async (route: string, params: Record<string, unknown> = {}) => {
        calls.push({ route, params });
        if (route === "GET /repos/{owner}/{repo}/pulls") {
          const head = String(params["head"]).split(":")[1];
          return { status: 200, data: pulls.filter((pull) => pull.head === head).map((pull) => ({ number: pull.number, state: pull.state })) };
        }
        if (route.startsWith("GET /repos/{owner}/{repo}/git/matching-refs/heads/")) {
          const prefix = route.slice("GET /repos/{owner}/{repo}/git/matching-refs/heads/".length);
          return { status: 200, data: (options.branches ?? []).filter((branch) => branch.startsWith(prefix)).map((branch) => ({ ref: `refs/heads/${branch}` })) };
        }
        if (route === "GET /repos/{owner}/{repo}") return { status: 200, data: { default_branch: options.defaultBranch ?? "main" } };
        if (route === "POST /repos/{owner}/{repo}/pulls") {
          if (options.raceOnCreate !== undefined) {
            pulls.push(options.raceOnCreate);
            throw fail(422, "Validation Failed: A pull request already exists");
          }
          if ((options.createStatus ?? 201) >= 300) throw fail(options.createStatus!, "Forbidden");
          const pull: Pull = { number: 40 + pulls.length, head: String(params["head"]), state: "open", draft: params["draft"] !== false };
          pulls.push(pull);
          return { status: 201, data: { number: pull.number, draft: pull.draft } };
        }
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          const pull = pulls.find((each) => each.number === params["pull_number"]);
          if (pull === undefined) throw fail(404, "Not Found");
          return { status: 200, data: { number: pull.number, draft: pull.draft, node_id: `PR_${pull.number}` } };
        }
        if (route === "POST /graphql") {
          const id = String((params["variables"] as { id: string }).id);
          const pull = pulls.find((each) => `PR_${each.number}` === id);
          if (pull !== undefined) pull.draft = false;
          return { status: 200, data: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } };
        }
        throw fail(404, `unexpected ${route}`);
      },
    }),
  };
  const creates = () => calls.filter((call) => call.route === "POST /repos/{owner}/{repo}/pulls");
  return { github, calls, pulls, creates };
}

/** `host.reminders` that records what it was asked to create and cancel. */
export function fakeReminders(options: { failCreate?: boolean } = {}) {
  const created: ReminderCreateInput[] = [];
  const cancelled: string[] = [];
  const api: ReminderHostApi = {
    create: async (input) => {
      if (options.failCreate === true) throw new Error("platform timers require CURSOR_API_KEY");
      created.push(input);
      return { id: `rem-${created.length}` } as ReminderInfo;
    },
    list: async () => [],
    cancel: async (id) => {
      cancelled.push(id);
    },
    cancelForContinuation: async () => 0,
    rekeyContinuation: async () => 0,
    dispatch: async (id) => ({ reminderId: id, outcome: "noop" }),
  };
  return { api, created, cancelled };
}
