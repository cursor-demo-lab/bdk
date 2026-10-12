import { defineEvalConfig } from "@cursor/july/evals";

export default defineEvalConfig({
  maxConcurrency: 20,
  timeoutMs: 180_000,
});
