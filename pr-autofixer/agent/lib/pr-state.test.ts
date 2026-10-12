import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPrState } from "./pr-state.js";

const pr = { owner: "o", repo: "r", number: 8, url: "https://github.com/o/r/pull/8", label: "o/r#8" };

function github(data: Record<string, unknown>) {
  return {
    getOctokit: async () => ({
      graphql: async () => {
        throw Object.assign(new Error("Missing x-cursor-github-repos header"), { status: 400 });
      },
      request: async () => ({ data }),
    }),
  } as never;
}

test("fetchPrState reads over REST and maps merged, closed, and open", async () => {
  assert.equal(await fetchPrState({ github: github({ state: "closed", merged: true }), pr }), "MERGED");
  assert.equal(await fetchPrState({ github: github({ state: "closed", merged: false }), pr }), "CLOSED");
  assert.equal(await fetchPrState({ github: github({ state: "open", merged: false }), pr }), "OPEN");
});
