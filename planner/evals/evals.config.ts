import { defineEvalConfig } from "@cursor/july/evals";
import { applyEvalEnv } from "./support.js";

// The local harness serves the agent in this process, and the tools read
// process.env when they run, so defaults set here reach every case. Against
// `--url`, the server's own environment must carry them.
applyEvalEnv();

export default defineEvalConfig({
  maxConcurrency: 20,
  // A planning turn runs search, read, git_history, three skills, and
  // record_plan. Live runs of records-once and keeps-reporter-constraints took
  // 128-143s, and one keeps-reporter-constraints run hit 180s after reading
  // the code but before record_plan. 300s gives about twice the observed time.
  timeoutMs: 300_000,
});
