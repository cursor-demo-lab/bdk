import assert from "node:assert/strict";
import { test } from "node:test";
import { decideFactoryDrive, FACTORY_DRIVE_SENTINEL, isFactoryDriveComment } from "./factory-drive.js";

const REPOS = ["Cursor-Demo-Lab/factory-sandbox"];

const PR = { kind: "pull_request", number: 12, url: "https://github.com/cursor-demo-lab/factory-sandbox/pull/12" };
const SANDBOX = { owner: "cursor-demo-lab", name: "factory-sandbox" };
const COLLABORATOR = { login: "alice", type: "User", association: "COLLABORATOR" };

test("only a first line of factory: drive is the opt-in", () => {
  assert.equal(isFactoryDriveComment(FACTORY_DRIVE_SENTINEL), true);
  assert.equal(isFactoryDriveComment("factory: drive\nplease"), true);
  assert.equal(isFactoryDriveComment("FACTORY: DRIVE"), true);
  assert.equal(isFactoryDriveComment(" factory: drive "), true);
  assert.equal(isFactoryDriveComment("Please factory: drive"), false);
  assert.equal(isFactoryDriveComment("Drive this PR"), false);
  assert.equal(isFactoryDriveComment(""), false);
});

test("factory: drive on an issue does not drive", () => {
  const issue = { kind: "issue", number: 12, url: "https://github.com/cursor-demo-lab/factory-sandbox/issues/12" };
  assert.deepEqual(decideFactoryDrive({ body: "factory: drive", conversation: issue, repository: SANDBOX, repos: REPOS, author: COLLABORATOR }), {
    drive: false,
    reason: "not_pull_request",
  });
});

test("factory: drive on a repo outside the list, with no list, or on a lookalike that only shares a configured name as a prefix does not drive", () => {
  const repoPr = (owner: string, name: string) => ({ ...PR, url: `https://github.com/${owner}/${name}/pull/12` });
  const cases = [
    { repository: { owner: "cursor-demo-lab", name: "other" }, conversation: PR, repos: REPOS },
    { repository: SANDBOX, conversation: PR, repos: [] },
    { repository: { owner: "cursor-demo-lab", name: "factory-sandbox-evil" }, conversation: repoPr("cursor-demo-lab", "factory-sandbox-evil"), repos: REPOS },
    { repository: { owner: "cursor-demo-lab", name: "factory-sandbox.github.io" }, conversation: repoPr("cursor-demo-lab", "factory-sandbox.github.io"), repos: REPOS },
  ];
  for (const { repository, conversation, repos } of cases) {
    assert.deepEqual(decideFactoryDrive({ body: "factory: drive", conversation, repository, repos, author: COLLABORATOR }), { drive: false, reason: "out_of_scope" }, repository.name);
  }
});

test("a comment that is not the sentinel, or whose first line only starts with factory: drive, is not the opt-in", () => {
  for (const body of ["Please factory: drive", "factory: drive-by review", "factory: driver notes", "factory: drive please"]) {
    assert.equal(isFactoryDriveComment(body), false, body);
    assert.deepEqual(decideFactoryDrive({ body, conversation: PR, repository: SANDBOX, repos: REPOS, author: COLLABORATOR }), { drive: false, reason: "not_sentinel" });
  }
});

test("factory: drive is refused from a stranger, a first-time contributor, an unknown association, or any bot", () => {
  const refused = [
    { login: "random-outsider", type: "User", association: "NONE" },
    { login: "drive-by", type: "User", association: "CONTRIBUTOR" },
    { login: "no-body", type: "User" },
    { login: "dependabot[bot]", type: "Bot", association: "NONE" },
    { login: "renovate[bot]", type: "User", association: "MEMBER" },
    { login: "ci-app", type: "Bot", association: "OWNER" },
  ];
  for (const author of refused) {
    assert.deepEqual(decideFactoryDrive({ body: "factory: drive", conversation: PR, repository: SANDBOX, repos: REPOS, author }), {
      drive: false,
      reason: "untrusted_author",
    }, author.login);
  }
});

test("factory: drive from an owner, a member, or a collaborator on an in-scope pull request drives that pull request", () => {
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.deepEqual(decideFactoryDrive({ body: "factory: drive", conversation: PR, repository: SANDBOX, repos: REPOS, author: { login: "alice", type: "User", association } }), {
      drive: true,
      pr: { owner: "cursor-demo-lab", repo: "factory-sandbox", number: 12, url: "https://github.com/cursor-demo-lab/factory-sandbox/pull/12" },
    }, association);
  }
});
