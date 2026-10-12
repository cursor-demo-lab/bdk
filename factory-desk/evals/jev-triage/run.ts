// Live Jev triage eval. Replays every case in cases.ts through the desk's
// real triageIntake with the TypeSafe key, `--runs` times each (default 3),
// and writes a JSON record and a Markdown report.
//
//   TYPESAFE_API_KEY=… npm run eval:jev-triage -- --label main
//
// Options: --runs N, --concurrency N (default 6), --label NAME, --out DIR
// (default evals/jev-triage/results, git-ignored), --only id,id,
// --category bug,story, --split tune|holdout, --types Bug,Task (the issue
// types the project lists; default TLSSN's Task, Story, Bug), --timeout-ms N (default: the desk's JEV_TIMEOUT_MS),
// --min-type-accuracy 0.9 and --max-clear-bug-stories 0 to exit 1 below a bar.
// --judge adds the LLM judge (judge.ts: Claude Opus 5.5, low effort, through
// @cursor/sdk with CURSOR_API_KEY): a blind label check of every selected case
// and a critique of each tune miss or unsure answer. --judge labels or
// --judge critique runs one pass. Live only; never in CI.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EVAL_ISSUE_TYPES, JEV_TRIAGE_CASES, type JevTriageCase, type JiraType } from "./cases.js";
import { cursorJudge, JUDGE_MODEL, judgeJev, judgeLabels, renderJudge, type JudgeResult } from "./judge.js";
import { pool, renderReport, replayCase, scoreRuns, type Observation } from "./replay.js";

const here = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    concurrency: { type: "string", default: "6" },
    label: { type: "string", default: "local" },
    out: { type: "string", default: join(here, "results") },
    only: { type: "string" },
    category: { type: "string" },
    split: { type: "string" },
    types: { type: "string" },
    "timeout-ms": { type: "string" },
    "min-type-accuracy": { type: "string" },
    "max-clear-bug-stories": { type: "string" },
    judge: { type: "string" },
  },
  // `--judge` alone means both passes.
  args: process.argv.slice(2).flatMap((arg, index, all) => (arg === "--judge" && (all[index + 1] === undefined || all[index + 1]!.startsWith("--")) ? ["--judge", "all"] : [arg])),
});

const judgeMode = values.judge;
if (judgeMode !== undefined && !["all", "labels", "critique"].includes(judgeMode)) {
  console.error("--judge is all (the default), labels, or critique.");
  process.exit(2);
}
const cursorKey = process.env.CURSOR_API_KEY?.trim();
if (judgeMode !== undefined && (cursorKey === undefined || cursorKey === "")) {
  console.error("CURSOR_API_KEY is not set: --judge calls Claude Opus 5.5 through the Cursor SDK.");
  process.exit(2);
}

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (apiKey === undefined || apiKey === "") {
  console.error("TYPESAFE_API_KEY is not set: the live eval calls Jev. Put it in factory-desk/.env.local or the environment.");
  process.exit(2);
}

const only = values.only?.split(",").map((id) => id.trim());
const categories = values.category?.split(",").map((category) => category.trim());
const split = values.split;
if (split !== undefined && split !== "tune" && split !== "holdout") {
  console.error("--split is tune or holdout.");
  process.exit(2);
}
const cases = JEV_TRIAGE_CASES.filter(
  (item) =>
    (only === undefined || only.includes(item.id)) &&
    (categories === undefined || categories.includes(item.category)) &&
    (split === undefined || (split === "holdout") === (item.holdout === true))
);
if (cases.length === 0) {
  console.error("No case matches --only / --category.");
  process.exit(2);
}
const runs = Math.max(1, Number(values.runs));
const timeoutMs = values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]);
const types = values.types === undefined ? EVAL_ISSUE_TYPES : values.types.split(",").map((name) => ({ name: name.trim() }));
const jobs = cases.flatMap((item) => Array.from({ length: runs }, (_, index) => ({ item, run: index + 1 })));

let done = 0;
const observations: Observation[] = await pool(jobs, Math.max(1, Number(values.concurrency)), async ({ item, run }) => {
  const observation = await replayCase(item, { apiKey, run, types, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  done++;
  if (done % 20 === 0 || done === jobs.length) process.stderr.write(`${done}/${jobs.length}\n`);
  return observation;
});

// With no Story type (the desk's Bug-and-Task default), a Story is filed as a Task.
const scored = types.some((type) => type.name === "Story") ? cases : cases.map((item) => withoutStory(item));
const report = scoreRuns(scored, observations);
const when = new Date().toISOString();
const ref = gitRef();
mkdirSync(resolve(values.out), { recursive: true });
const stem = join(resolve(values.out), `${values.label}-${when.replace(/[:.]/g, "-")}`);
const holdoutCases = scored.filter((item) => item.holdout === true);
const holdout = holdoutCases.length === 0 || holdoutCases.length === cases.length ? undefined : scoreRuns(holdoutCases, observations.filter((observation) => holdoutCases.some((item) => item.id === observation.caseId)));
const typesNote = `types ${types.map((type) => type.name).join(", ")}`;
let judged: JudgeResult | undefined;
if (judgeMode !== undefined) {
  const call = cursorJudge(cursorKey!);
  process.stderr.write(`Judging with ${JUDGE_MODEL.id} (${judgeMode})…\n`);
  judged = {
    model: JUDGE_MODEL,
    ...(judgeMode === "critique" ? {} : { labels: await judgeLabels(cases, call) }),
    ...(judgeMode === "labels" ? {} : { critiques: await judgeJev(scored, observations, call) }),
  };
}
const markdown = [renderReport(report, { label: values.label, when, ref: [ref, typesNote].filter(Boolean).join(" · "), ...(holdout === undefined ? {} : { holdout }) }), ...(judged === undefined ? [] : [renderJudge(judged)])].join("\n");
writeFileSync(`${stem}.json`, `${JSON.stringify({ label: values.label, ref, when, runs, types, report, holdout, judge: judged, observations }, null, 2)}\n`);
writeFileSync(`${stem}.md`, markdown);
console.log(markdown);
console.error(`Wrote ${stem}.json and ${stem}.md`);

const minType = values["min-type-accuracy"] === undefined ? undefined : Number(values["min-type-accuracy"]);
const maxStories = values["max-clear-bug-stories"] === undefined ? undefined : Number(values["max-clear-bug-stories"]);
const failures = [
  ...(minType !== undefined && report.type.accuracy < minType ? [`type accuracy ${report.type.accuracy.toFixed(3)} < ${minType}`] : []),
  ...(maxStories !== undefined && report.clearBug.asStory > maxStories ? [`${report.clearBug.asStory} clear-bug runs typed Story > ${maxStories}`] : []),
];
if (failures.length > 0) {
  console.error(`Below the bar: ${failures.join("; ")}`);
  process.exit(1);
}

function withoutStory(item: JevTriageCase): JevTriageCase {
  const task = (type: JiraType): JiraType => (type === "Story" ? "Task" : type);
  return { ...item, type: task(item.type), ...(item.accept === undefined ? {} : { accept: { ...item.accept, ...(item.accept.type === undefined ? {} : { type: item.accept.type.map(task) }) } }) };
}

function gitRef(): string | undefined {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
    return `${branch}@${sha}`;
  } catch {
    return undefined;
  }
}
