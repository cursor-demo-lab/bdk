import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseGitHubPrRef } from "@cursor/july/channels/github";
import { defineTool } from "@cursor/july/tools";
import { z } from "zod";
import { type DiffMeta, parseDiffMeta } from "../lib/diff-evidence.js";
import { refusesProductionTarget } from "../lib/factory-stage.js";
import { recordReview } from "../lib/reviewed-head.js";
import { prSessionKey } from "../lib/session-key.js";
import { bindOpsFunnel, warnKv } from "../lib/ops-funnel.js";

const SHA = /^[0-9a-f]{40}$/i;

const finding = z.object({
  severity: z.enum(["high", "medium", "low"]),
  file: z.string().min(1).max(240),
  line: z.number().int().positive(),
  title: z.string().min(1).max(160),
  detail: z.string().min(1).max(280),
});

type Finding = z.infer<typeof finding>;

async function readEvidence(workspaceDir: string, name: string): Promise<string> {
  try {
    return await readFile(join(workspaceDir, name), "utf8");
  } catch {
    throw new Error(`missing ${name}`);
  }
}

export default defineTool({
  description:
    "Post the security review on this session's pull request. Call once. Empty findings = CLEAN.",
  inputSchema: z.object({
    findings: z
      .array(finding)
      .describe("Exploitable issues. Empty for CLEAN."),
  }),
  effect: "write",
  dryRunResult: { posted: false, reason: "dry_run" },
  async execute({ findings }, ctx) {
    bindOpsFunnel(ctx.host);
    if (ctx.session.purpose === "eval") {
      return { posted: false, reason: "eval" };
    }
    const key = prSessionKey(ctx.session.continuationKey);
    if (!key.startsWith("github-pr:")) {
      throw new Error("post_findings requires a GitHub pull request session");
    }
    const ref = parseGitHubPrRef(key.slice("github-pr:".length));
    if (ref === undefined) {
      throw new Error(`unrecognized PR: ${key}`);
    }
    // A staging slug posts no review on the production repository, whichever
    // session reached this tool (factory-stage.ts).
    if (refusesProductionTarget(process.env, { kind: "repos", value: `${ref.owner}/${ref.repo}` })) {
      return { posted: false, reason: "staging_refuses_production" };
    }
    const headSha = (await readEvidence(ctx.workspaceDir, "pr/head.sha")).trim();
    if (!SHA.test(headSha)) {
      throw new Error("missing pr/head.sha");
    }
    const patch = await readEvidence(ctx.workspaceDir, "pr/diff.patch");
    const meta = parseDiffMeta({
      raw: await readEvidence(ctx.workspaceDir, "pr/diff.json"),
      headSha,
      patch,
    });
    const verdict = meta.truncated ? "INCOMPLETE" : findings.length === 0 ? "CLEAN" : "FINDINGS";
    const octokit = await ctx.host.github.getOctokit();
    const response = await octokit.rest.pulls.createReview({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      commit_id: headSha,
      body: reviewBody(verdict, findings, meta, headSha),
      event: "COMMENT",
    });
    // The review is already posted, so a failed record only costs a repeat
    // review. `recorded` is whether this client saw the put succeed; a put
    // that applied and then threw still suppresses that base and head.
    let recorded = false;
    try {
      await recordReview({
        kv: ctx.host.kv,
        identity: { fullName: `${ref.owner}/${ref.repo}`, number: ref.number, base: meta.base, headSha },
        at: new Date().toISOString(),
        incomplete: meta.truncated ? { totalChars: meta.totalChars } : undefined,
      });
      recorded = true;
    } catch (error) {
      warnKv("post_findings.recordReview", error);
    }
    console.log(
      JSON.stringify({
        factoryDebug: "review-posted",
        repo: `${ref.owner}/${ref.repo}`,
        number: ref.number,
        base: meta.base,
        headSha: headSha.toLowerCase(),
        verdict,
        recorded,
      })
    );
    return { posted: true, pr: ref.label, url: response.data.html_url, verdict, recorded };
  },
});

function flatten(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// The first three lines are the shape scripts/e2e-lib.mjs `REVIEWER_BODY`
// matches, so the scope line goes after the verdict, never on its line.
function reviewBody(verdict: string, findings: Finding[], meta: DiffMeta, headSha: string): string {
  const lines = [
    "## Security review",
    "",
    `**Verdict:** ${verdict}`,
    `Security only, on head \`${headSha.slice(0, 7).toLowerCase()}\`; Bugbot covers correctness. A new push gets a new review.`,
  ];
  if (meta.truncated) {
    lines.push(
      "",
      `Partial review: diff truncated at ${meta.shownChars} of ${meta.totalChars} chars.`,
      `Not fully reviewed: ${meta.cutFiles.map((file) => `\`${flatten(file)}\``).join(", ")}`
    );
    if (findings.length > 0) lines.push("");
  }
  for (const item of findings) {
    lines.push(
      `- **${item.severity}** \`${flatten(item.file)}:${item.line}\` — ${flatten(item.title)}`
    );
    lines.push(`  ${flatten(item.detail)}`);
  }
  return lines.join("\n");
}
