import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DIFF_CHARS, isUnifiedDiff, prepareDiff, sectionPath } from "./diff-evidence.js";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);

test("a unified diff opens with a file header or is empty", () => {
  assert.equal(isUnifiedDiff(""), true);
  assert.equal(isUnifiedDiff("diff --git a/x b/x\n"), true);
  assert.equal(isUnifiedDiff("\ndiff --git a/x b/x\n"), false);
  assert.equal(isUnifiedDiff("diff pulls@x"), false);
  assert.equal(isUnifiedDiff({ files: [] }), false);
  assert.equal(isUnifiedDiff(undefined), false);
});

test("lockfiles in any directory move after source; a diff with none keeps its order", () => {
  const lock = "diff --git a/web/yarn.lock b/web/yarn.lock\n+a\n";
  const go = "diff --git a/go.sum b/go.sum\n+b\n";
  const src = "diff --git a/src/x.ts b/src/x.ts\n+c\n";
  assert.equal(prepareDiff({ diff: lock + go + src, base: BASE, headSha: SHA }).patch, src + lock + go);
  assert.equal(prepareDiff({ diff: src + src, base: BASE, headSha: SHA }).patch, src + src);
  assert.equal(MAX_DIFF_CHARS, 150_000);
});

test("a lockfile two directories deep still moves after source", () => {
  const lock = "diff --git a/apps/web/pnpm-lock.yaml b/apps/web/pnpm-lock.yaml\n+a\n";
  const src = "diff --git a/apps/web/src/x.ts b/apps/web/src/x.ts\n+c\n";
  assert.equal(prepareDiff({ diff: lock + src, base: BASE, headSha: SHA }).patch, src + lock);
});

test("a diff of exactly the cap is whole, and a file ending exactly at the cap is not listed as cut", () => {
  const a = "diff --git a/src/a.ts b/src/a.ts\n+a\n";
  const b = "diff --git a/src/b.ts b/src/b.ts\n+b\n";
  const exact = prepareDiff({ diff: a + b, base: BASE, headSha: SHA, max: (a + b).length });
  assert.equal(exact.patch, a + b);
  assert.equal(exact.meta.truncated, false);
  const cut = prepareDiff({ diff: a + b, base: BASE, headSha: SHA, max: a.length });
  assert.equal(cut.meta.truncated, true);
  assert.deepEqual(cut.meta.cutFiles, ["src/b.ts"]);
  assert.equal(cut.patch.startsWith(a), true);
});

test("the meta names the base and head the compare was pinned to", () => {
  assert.equal(prepareDiff({ diff: "", base: BASE, headSha: SHA }).meta.base, BASE);
  assert.equal(prepareDiff({ diff: "", base: "main", headSha: SHA }).meta.base, "main");
});

// What `git diff` writes for a non-ASCII lockfile path (core.quotePath on,
// GitHub's default): both sides C-quoted, bytes as octal escapes.
const QUOTED_LOCK = [
  'diff --git "a/f\\303\\266o/package-lock.json" "b/f\\303\\266o/package-lock.json"',
  "index 1111111..2222222 100644",
  '--- "a/f\\303\\266o/package-lock.json"',
  '+++ "b/f\\303\\266o/package-lock.json"',
  "@@ -1 +1 @@",
  "+x",
  "",
].join("\n");
const SRC = "diff --git a/src/z.ts b/src/z.ts\n--- a/src/z.ts\n+++ b/src/z.ts\n@@ -1 +1 @@\n+y\n";

test("a git-quoted lockfile still moves after source, and a cut names it decoded", () => {
  const whole = prepareDiff({ diff: QUOTED_LOCK + SRC, base: BASE, headSha: SHA });
  assert.equal(whole.patch, SRC + QUOTED_LOCK);
  const cut = prepareDiff({ diff: QUOTED_LOCK + SRC, base: BASE, headSha: SHA, max: 10 });
  assert.deepEqual(cut.meta.cutFiles, ["src/z.ts", "föo/package-lock.json"]);
});

test("a path holding a space and ' b/' is read from the +++ line, not split at the first ' b/'", () => {
  // git appends a tab to a ---/+++ name that holds a space.
  const spaced = "diff --git a/docs/a b/notes.md b/docs/a b/notes.md\n--- a/docs/a b/notes.md\t\n+++ b/docs/a b/notes.md\t\n@@ -1 +1 @@\n+z\n";
  const cut = prepareDiff({ diff: SRC + spaced, base: BASE, headSha: SHA, max: 10 });
  assert.deepEqual(cut.meta.cutFiles, ["src/z.ts", "docs/a b/notes.md"]);
});

// Verbatim `git diff -M` (git 2.x) of: delete `docs/a b/notes.md`, add
// `docs/a b/nötes.md`, edit `föo/package-lock.json` and `say "hi"`.
const REAL_GIT =
  "diff --git a/docs/a b/notes.md b/docs/a b/notes.md\ndeleted file mode 100644\nindex d00491f..0000000\n--- a/docs/a b/notes.md\t\n+++ /dev/null\n@@ -1 +0,0 @@\n-1\ndiff --git \"a/docs/a b/n\\303\\266tes.md\" \"b/docs/a b/n\\303\\266tes.md\"\nnew file mode 100644\nindex 0000000..0cfbf08\n--- /dev/null\n+++ \"b/docs/a b/n\\303\\266tes.md\"\t\n@@ -0,0 +1 @@\n+2\ndiff --git \"a/f\\303\\266o/package-lock.json\" \"b/f\\303\\266o/package-lock.json\"\nindex d00491f..0cfbf08 100644\n--- \"a/f\\303\\266o/package-lock.json\"\n+++ \"b/f\\303\\266o/package-lock.json\"\n@@ -1 +1 @@\n-1\n+2\ndiff --git \"a/say \\\"hi\\\"\" \"b/say \\\"hi\\\"\"\nindex d00491f..0cfbf08 100644\n--- \"a/say \\\"hi\\\"\"\t\n+++ \"b/say \\\"hi\\\"\"\t\n@@ -1 +1 @@\n-1\n+2\n";

test("real git output with quoted, spaced, and non-ASCII paths keeps the lockfile last and names every cut file", () => {
  const cut = prepareDiff({ diff: REAL_GIT, base: BASE, headSha: SHA, max: 10 });
  assert.deepEqual(cut.meta.cutFiles, ["docs/a b/notes.md", "docs/a b/nötes.md", 'say "hi"', "föo/package-lock.json"]);
});

test("the section path comes from +++, then rename to or copy to, then the header line", () => {
  const cases: [string, string][] = [
    ['diff --git "a/tab\\there" "b/tab\\there"\n--- "a/tab\\there"\n+++ "b/tab\\there"\n@@ -1 +1 @@\n+q\n', "tab\there"],
    ['diff --git a/q b/q\n--- a/q\n+++ "b/say \\"hi\\"\\\\x"\n@@ -1 +1 @@\n', 'say "hi"\\x'],
    ["diff --git a/gone.lock b/gone.lock\ndeleted file mode 100644\n--- a/gone.lock\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n", "gone.lock"],
    ["diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n", "new.ts"],
    ['diff --git a/old name "b/new\\303\\251"\nsimilarity index 100%\nrename from old name\nrename to "new\\303\\251"\n', "newé"],
    ['diff --git a/old name "b/new\\303\\251"\nold mode 100644\nnew mode 100755\n', "newé"],
    ["diff --git a/x b/y\nsimilarity index 90%\ncopy from x\ncopy to y\n", "y"],
    ["diff --git a/p b/q b/r b/s\nsimilarity index 100%\nrename from p b/q\nrename to r b/s\n", "r b/s"],
    ['diff --git a/q b/q\n--- a/q\n+++ "b/\\"q\\"\u{1F600}.ts"\n@@ -1 +1 @@\n', '"q"\u{1F600}.ts'],
    ['diff --git "a/\\303\\266.png" "b/\\303\\266.png"\nindex 1..2 100644\nBinary files "a/\\303\\266.png" and "b/\\303\\266.png" differ\n', "ö.png"],
    ["diff --git a/a b/c.sh b/a b/c.sh\nold mode 100644\nnew mode 100755\n", "a b/c.sh"],
    ["diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1,2 @@\n+++ b/package-lock.json\n", "src/x.ts"],
    ["diff --git a/x b/y\n", "y"],
    ["diff --git nonsense\n", ""],
  ];
  assert.deepEqual(cases.map(([text]) => sectionPath(text)), cases.map(([, path]) => path));
});
