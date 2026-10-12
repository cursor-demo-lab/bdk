// The evidence a review turn reads. The channel writes pr/diff.patch,
// pr/head.sha, and pr/diff.json from one compare response pinned to the
// event's base and head; post_findings refuses to post unless the three
// agree, and after a successful post records that base and head as
// reviewed, with complete: false and the diff's size when the patch was cut.

export const MAX_DIFF_CHARS = 150_000;

// Lockfiles are kept, since a dependency swap is a security change, but they
// move after source files so a cap cuts them before code.
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "go.sum",
]);

export type DiffMeta = {
  /** The compare's base as fetched: the event's base sha, or its base branch when the event had none. */
  base: string;
  headSha: string;
  totalChars: number;
  shownChars: number;
  patchChars: number;
  truncated: boolean;
  cutFiles: string[];
};

export class NotADiffError extends Error {
  constructor() {
    super("compare did not return a unified diff");
    this.name = "NotADiff";
  }
}

/** A compare of zero files is an empty body; anything else must open with a file header. */
export function isUnifiedDiff(body: unknown): body is string {
  return typeof body === "string" && (body === "" || body.startsWith("diff --git "));
}

type Section = { path: string; text: string };

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Git's C-style quoted name starting at `start` (a `"`): its decoded text and the index after the closing quote. */
function unquote(text: string, start: number): { value: string; end: number } | undefined {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let i = start + 1;
  while (i < text.length) {
    const char = text[i]!;
    if (char === '"') return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 };
    if (char !== "\\") {
      const point = text.codePointAt(i)!;
      const unit = String.fromCodePoint(point);
      bytes.push(...encoder.encode(unit));
      i += unit.length;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) return undefined;
    const octal = /^[0-7]{3}/.exec(text.slice(i + 1, i + 4));
    if (octal !== null) {
      bytes.push(parseInt(octal[0], 8));
      i += 4;
    } else if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]!);
      i += 2;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/** A `+++ b/x` name without its prefix (`/dev/null` has none); git appends a tab when the name holds a space. */
function labelPath(label: string): string | undefined {
  const name = label.endsWith("\t") ? label.slice(0, -1) : label;
  const value = name.startsWith('"') ? unquote(name, 0)?.value : name;
  return value?.startsWith("b/") === true ? value.slice(2) : undefined;
}

/** `rename to x` / `copy to x`, quoted or bare. */
function extendedPath(name: string): string | undefined {
  return name.startsWith('"') ? unquote(name, 0)?.value : name;
}

/**
 * The b-side of `diff --git <a> <b>`. Git quotes a side that holds special
 * characters; two bare sides are ambiguous when a path holds ` b/`, so they
 * are read only as the identical pair git writes for an unrenamed file.
 */
function gitLinePath(rest: string): string | undefined {
  let b: string | undefined;
  if (rest.startsWith('"')) {
    const a = unquote(rest, 0);
    if (a === undefined || rest[a.end] !== " ") return undefined;
    const tail = rest.slice(a.end + 1);
    b = tail.startsWith('"') ? unquote(tail, 0)?.value : tail;
  } else if (rest.endsWith('"') && rest.lastIndexOf(' "') !== -1) {
    b = unquote(rest, rest.lastIndexOf(' "') + 1)?.value;
  } else {
    const path = rest.slice(2, 2 + (rest.length - 5) / 2);
    if (rest === `a/${path} b/${path}`) return path;
    return rest.includes(" b/") ? rest.slice(rest.indexOf(" b/") + 3) : undefined;
  }
  return b?.startsWith("b/") === true ? b.slice(2) : undefined;
}

/**
 * The path a section changes. The `+++` line names it unambiguously; a
 * deletion (`+++ /dev/null`) or a section with no hunk (binary, mode or
 * rename only) falls back to `rename to`/`copy to`, then the header line,
 * which git writes as an identical or quoted pair for an unrenamed file.
 */
export function sectionPath(text: string): string {
  const lines = text.split("\n");
  // Stops at the first hunk so a large section is not scanned to its end.
  const header: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("@@")) break;
    header.push(line);
  }
  const plus = header.find((line) => line.startsWith("+++ "));
  const added = plus === undefined ? undefined : labelPath(plus.slice(4));
  if (added !== undefined) return added;
  const moved = header.find((line) => line.startsWith("rename to ") || line.startsWith("copy to "));
  if (moved !== undefined) {
    const path = extendedPath(moved.slice(moved.indexOf(" to ") + 4));
    if (path !== undefined) return path;
  }
  return gitLinePath(lines[0]!.slice("diff --git ".length)) ?? "";
}

function sections(diff: string): Section[] {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((text) => text !== "")
    .map((text) => ({ path: sectionPath(text), text }));
}

function isLockfile(path: string): boolean {
  return LOCKFILES.has(path.slice(path.lastIndexOf("/") + 1));
}

export function prepareDiff({
  diff,
  base,
  headSha,
  max = MAX_DIFF_CHARS,
}: {
  diff: string;
  base: string;
  headSha: string;
  max?: number;
}): { patch: string; meta: DiffMeta } {
  const all = sections(diff);
  const ordered = [...all.filter((s) => !isLockfile(s.path)), ...all.filter((s) => isLockfile(s.path))];
  const full = ordered.map((s) => s.text).join("");
  if (full.length <= max) {
    return { patch: full, meta: { base, headSha, totalChars: full.length, shownChars: full.length, patchChars: full.length, truncated: false, cutFiles: [] } };
  }
  const cutFiles: string[] = [];
  let offset = 0;
  for (const section of ordered) {
    if (offset + section.text.length > max) cutFiles.push(section.path);
    offset += section.text.length;
  }
  const patch = `${full.slice(0, max)}\n…[truncated at ${max} of ${full.length} chars]\n`;
  return { patch, meta: { base, headSha, totalChars: full.length, shownChars: max, patchChars: patch.length, truncated: true, cutFiles } };
}

/** The meta must describe exactly this patch at exactly this head, or nothing is posted. */
export function parseDiffMeta({ raw, headSha, patch }: { raw: string; headSha: string; patch: string }): DiffMeta {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("pr/diff.json is not JSON");
  }
  const meta = value as Partial<DiffMeta> | null;
  if (
    meta === null ||
    typeof meta !== "object" ||
    typeof meta.base !== "string" ||
    meta.base === "" ||
    typeof meta.headSha !== "string" ||
    typeof meta.totalChars !== "number" ||
    typeof meta.shownChars !== "number" ||
    typeof meta.patchChars !== "number" ||
    typeof meta.truncated !== "boolean" ||
    !Array.isArray(meta.cutFiles) ||
    !meta.cutFiles.every((file) => typeof file === "string")
  ) {
    throw new Error("pr/diff.json is malformed");
  }
  if (meta.headSha.toLowerCase() !== headSha.toLowerCase()) {
    throw new Error("pr/diff.json names a different head than pr/head.sha");
  }
  if (meta.patchChars !== patch.length) {
    throw new Error("pr/diff.patch is not the patch pr/diff.json describes");
  }
  if (!meta.truncated && (meta.totalChars !== patch.length || meta.shownChars !== patch.length)) {
    throw new Error("pr/diff.json claims a whole diff that pr/diff.patch does not hold");
  }
  if (meta.truncated && !(meta.shownChars < meta.totalChars && meta.shownChars < patch.length)) {
    throw new Error("pr/diff.json claims a truncation that pr/diff.patch does not show");
  }
  return meta as DiffMeta;
}
