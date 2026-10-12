import { z } from "zod";

// The one shape a plan has. It is pstack's planning output, condensed: the
// `how` explanation, the `why` constraint set, and the `architect` rationale
// (usage first, shape, synthesis decision, tradeoffs, alternatives, open
// questions, next step), plus the steps and tests an implementer runs, and
// the short approval digest (summary, approach, areas, risk, size) the desk
// shows in Slack.
// `record_plan` validates the model's input against it, `agent/artifacts.ts`
// validates what is stored, `implementationBrief` turns it into the cloud
// launch prompt, and `jiraComment` into the comment on the ticket.
export const issueKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]+-\d+$/)
  .describe("Existing Jira issue key, such as ABC-42.");

const line = z.string().trim().min(1).max(300);
export const TITLE_MAX = 80;
const paragraph = z.string().trim().min(1).max(1200);
const lines = (max: number, min = 0) => z.array(line).min(min).max(max);

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export const SIZES = ["small", "medium", "large"] as const;

export const TIERS = ["Direct", "Supported", "Inferred", "Speculative", "Unknown"] as const;
const TIER_PREFIX = new RegExp(`^\\[(${TIERS.join("|")})\\]\\s`);

const finding = line
  .regex(TIER_PREFIX, 'Start with a confidence tier in brackets: "[Direct] ", "[Supported] ", "[Inferred] ", "[Speculative] ", or "[Unknown] ".')
  .describe("One cited claim, prefixed with its tier. Direct and Supported claims name their source; the rest are hedged.");

export const candidateSchema = z.object({
  name: line.describe("Short name for this design candidate."),
  shape: line.describe("One line: the data structure and boundary this candidate is built on."),
  verdict: z.enum(["base", "grafted", "rejected"]).describe("base: the chosen shape. grafted: something from it was folded into the base. rejected: dropped."),
  reason: line.describe("Why it got that verdict, judged on interface depth and the red flags."),
});

export const planSchema = z.object({
  issueKey: issueKeySchema,
  title: line.describe(
    `A short title for the change in your own words, under ${TITLE_MAX} characters: what is broken or wanted and where (for example "CSV download on the Activity page"). One phrase: never the reporter's question or sentence copied, never their reasons. Use the ticket title only when it already reads that way.`
  ),
  evidence: z
    .enum(["checkout", "prompt"])
    .describe(
      '"checkout" after search_sandbox confirmed the claimed failure is on the sandbox and you opened the cited paths. "prompt" is refused; call record_needs_info instead.'
    ),

  problem: paragraph.describe(
    "One paragraph stating the problem, not the solution: what is broken, missing, or needed today and for whom, and what about the existing system or its constraints makes the shape non-obvious. Say nothing here about what the change will do; that belongs in approach and design."
  ),

  summary: line.describe(
    "One sentence for the person approving in Slack: what is wrong or wanted, in plain words, adding something the title does not say (where it shows, who it affects, or why it matters). Never the title again."
  ),
  approach: paragraph.describe(
    "Two or three sentences for the approver: what the change does against the base design, in plain words. No new facts beyond the design."
  ),
  areas: lines(10, 1).describe(
    "Files or areas the change touches. Paths you opened when evidence is checkout; subsystem names when evidence is prompt."
  ),
  risk: z
    .object({
      level: z.enum(RISK_LEVELS).describe("low: contained, easy to revert. medium: shared code or behavior callers rely on. high: data, auth, money, or a wide blast radius."),
      reason: line.describe("Why that level, in one line. Name the thing that could break."),
    })
    .describe("The approver's risk read, drawn from why.risks and the design."),
  size: z
    .object({
      estimate: z.enum(SIZES).describe("small: one area, a few files. medium: several files or one new seam. large: several areas or a migration."),
      reason: line.describe("Why that size, in one line."),
    })
    .describe("How big the change is, so the approver knows what they are signing up to review."),

  howItWorks: z
    .object({
      overview: paragraph.describe("What the touched subsystem is, what it does, why it exists. One or two paragraphs."),
      keyConcepts: lines(8).default([]).describe("The types, services, or abstractions needed to follow the flow. Brief."),
      flow: lines(10, 1).describe("How it works today, step by step: what triggers it, what happens, where data goes, the decision points. Name files and functions."),
      whereThingsLive: lines(12).default([]).describe("Paths someone needs to start working here. Only paths you opened; record_plan refuses an empty list."),
      gotchas: lines(6).default([]).describe("Non-obvious behavior, surprising coupling, pitfalls."),
    })
    .describe("The `how` grounding: a senior engineer's mental model of what the ticket touches."),

  why: z
    .object({
      findings: z.array(finding).min(1).max(8).describe("What the record says about why the current shape exists, one tiered claim per line."),
      preserve: lines(10)
        .default([])
        .describe(
          "What the change must keep: every explicit constraint the reporter stated (a limit, exact copy, a placeholder, \"don't change X\"), in their words, then what the record says is load-bearing. At most 10 lines: when there are more, merge related constraints into one line rather than drop any."
        ),
      change: lines(6).default([]).describe("What the change is free to alter."),
      avoid: lines(6).default([]).describe("Shapes the record shows were tried or rejected, or that would undo a deliberate decision."),
      risks: lines(6).default([]).describe("Where the rationale is thin and the change could break an unrecorded assumption."),
      sourcesConsulted: lines(6, 1).describe("One line per source: git history, the ticket and its comments, code comments and tests, docs in the checkout. Name what was searched and what returned nothing."),
    })
    .describe("The `why` constraint set, with confidence kept separate from certainty."),

  design: z
    .object({
      usage: paragraph.describe("The caller's view, written before the shape: what they import or call, and what comes back. Two or three call sites in prose."),
      shape: paragraph.describe("Data structures first, then how data flows through the signatures. Name the load-bearing decision and what the public surface hides."),
      candidates: z
        .array(candidateSchema)
        .min(2)
        .max(4)
        .describe("At least two structurally distinct candidates, screened against the red flags. Exactly one is the base."),
      synthesisDecision: paragraph.describe("Which candidate became the base and why, what was grafted from the others, what was rejected and why."),
      tradeoffs: lines(6, 1).describe('One per line, in the form "we accept X in exchange for Y".'),
      alternatives: lines(4, 1).describe("Concrete alternative shapes and one line each on why they lost, judged on interface depth."),
    })
    .describe("The `architect` rationale for the chosen shape."),

  steps: lines(8, 2).describe("Ordered implementation steps against the chosen shape, each one verifiable."),
  tests: lines(6, 1).describe("How the change is checked, by command or by observation."),
  openQuestions: lines(4).default([]).describe("Decisions the record and the ticket leave open, phrased as questions. The implementer must not settle them silently."),
  nextStep: line.describe("The first thing to build against the shape. One sentence."),
});

/** What the plan artifact stores. Plans recorded before the approval digest existed have none of its fields. */
export const storedPlanSchema = planSchema.extend({
  summary: planSchema.shape.summary.optional(),
  approach: planSchema.shape.approach.optional(),
  areas: planSchema.shape.areas.optional(),
  risk: planSchema.shape.risk.optional(),
  size: planSchema.shape.size.optional(),
  brief: z.string().min(1),
  comment: z.string().min(1),
  repo: z.string().min(1),
  tracker: z.string().min(1),
});

export type Plan = z.infer<typeof planSchema>;
export type PlanInput = z.input<typeof planSchema>;

/**
 * Why a plan's title or summary is not the approver's digest yet, or
 * undefined. TLSSN-46's plan was titled with the reporter's raw question.
 * Checked by record_plan, not the schema, so stored plans with older titles
 * still parse.
 */
export function digestProblem(plan: { title: string; summary: string }): { field: "title" | "summary"; why: string } | undefined {
  const title = plan.title.trim();
  if (title.length > TITLE_MAX) return { field: "title", why: `title is ${title.length} characters; write a short title in your own words, under ${TITLE_MAX}.` };
  if (/\?\s*$/.test(title)) return { field: "title", why: "title is a question; state what is broken or wanted and where, in your own words." };
  if (SENTENCE_BREAK.test(withoutAbbreviations(title))) return { field: "title", why: "title runs to more than one sentence; keep one short phrase." };
  if (normalized(plan.summary) === normalized(title)) return { field: "summary", why: "summary repeats the title; say something the title does not (where it shows, who it affects, or why it matters)." };
  return undefined;
}

const SENTENCE_BREAK = /[.!?]\s+\S/;
// `e.g.`, `vs.`, `Mr.`, a capital initial (`J. Smith`), and version numbers
// (`v2.3.1`, `1.5x`) end no sentence.
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|no|approx|cf|inc|ltd|jr|sr)\.|\b\p{Lu}\.|\d\.(?=\d)/giu;

function withoutAbbreviations(text: string): string {
  // Same length (a one-dot leader for each dot), so an index into it is an index into `text`.
  return text.replace(ABBREVIATION, (match) => match.replace(/\./g, "\u2024"));
}

/**
 * The host's own title when the model's failed the digest check twice: the
 * first sentence of what it wrote (abbreviations kept), without a closing
 * `?`, cut between words to TITLE_MAX with `…`. A plan is never lost to its
 * title.
 */
export function fallbackTitle(input: { title: string; issueKey: string; summary?: string }): string {
  const first = firstSentence(input.title);
  if (/[\p{L}\p{N}]/u.test(first)) return fitted(first);
  // Nothing to keep (a title of "?" or punctuation): the summary's first words, else the key.
  const words = firstSentence(input.summary ?? "").split(" ").slice(0, 8).join(" ");
  return /[\p{L}\p{N}]/u.test(words) ? fitted(words) : `${input.issueKey} plan`;
}

function firstSentence(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const plain = withoutAbbreviations(oneLine);
  const end = plain.search(SENTENCE_BREAK);
  return (end === -1 ? oneLine : oneLine.slice(0, end + 1)).replace(/[?\s]+$/, "").replace(/[.!]+$/, "");
}

function fitted(first: string): string {
  if (first.length <= TITLE_MAX) return first;
  const cut = first.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[,;:\s-]+$/, "")}…`;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Every candidate set has exactly one base. */
export function oneBase(candidates: readonly { verdict: string }[]): boolean {
  return candidates.filter((candidate) => candidate.verdict === "base").length === 1;
}

/** Artifact upsert key: one plan per ticket, re-planning replaces it. */
export function planKey(issueKey: string): string {
  return `plan:${issueKey}`;
}

/** First line of the ticket comment. The dedupe sentinel and what a reader scans for. */
export function planSentinel(issueKey: string): string {
  return `Plan: ${issueKey}`;
}

/**
 * The prompt a cloud agent gets. Deterministic on purpose: the desk model
 * copies this text into `cloud__launch`, so every word the implementer reads
 * about scope, constraints, branch naming, and what "done" means is written
 * here, not improvised per turn.
 */
export function implementationBrief(plan: Plan, target: { repo: string; ref?: string; ticketUrl?: string; slackUrl?: string }): string {
  const { repo, ref = "main" } = target;
  return [
    `Implement Jira ${plan.issueKey} on ${repo} from ${ref}: ${plan.title}`,
    target.ticketUrl === undefined ? undefined : `Ticket: ${target.ticketUrl}`,
    target.slackUrl === undefined ? undefined : `Slack thread: ${target.slackUrl}`,
    `The branch name starts with ${plan.issueKey}- and the pull request title with "${plan.issueKey}: ".`,
    "",
    `Problem: ${plan.problem}`,
    "",
    "Follow this plan. If the code disagrees with it, stop at that step and say so in the pull request description instead of improvising a different change.",
    plan.evidence === "prompt"
      ? "This plan was written from the ticket and the request without reading the repository. Verify each assumption against the code before acting on it."
      : undefined,
    "",
    `Shape: ${plan.design.shape}`,
    "",
    `Usage: ${plan.design.usage}`,
    "",
    "Steps:",
    ...plan.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    section("Preserve, the reporter's constraints and what the record says is load-bearing", plan.why.preserve),
    section("Avoid, tried or rejected before", plan.why.avoid),
    section(
      plan.evidence === "checkout"
        ? "Files likely touched, verify before editing"
        : "Files likely touched, unverified: the plan was written without a checkout",
      plan.howItWorks.whereThingsLive
    ),
    section("Tests", plan.tests),
    section("Risks to watch", plan.why.risks),
    section("Open questions. Make no assumption silently; state your choice in the pull request", plan.openQuestions),
    `Start with: ${plan.nextStep}`,
    "",
    ...pullRequestContract(plan.issueKey, target.ticketUrl, target.slackUrl),
    "Do not merge, enable auto-merge, or force-push. A human reviews and merges.",
  ]
    .filter((entry) => entry !== undefined)
    .join("\n");
}

/**
 * How the implement pull request reads, so a reviewer arriving from Slack,
 * Jira, or a GitHub notification can follow it without the plan. The key
 * leads the title because the worker, the fixer, and the security reviewer
 * find the ticket by a title or branch that starts with it. Plain dash lines,
 * not markdown headings: the brief is stored in a Jira comment, and Jira
 * turns a leading `##` into a heading node whose marker is lost on read-back.
 */
function pullRequestContract(issueKey: string, ticketUrl: string | undefined, slackUrl: string | undefined): string[] {
  return [
    "Done means one pull request on the repository, written for a reviewer who has not read this plan:",
    `- Title: "${issueKey}: " then what the change does, in under 72 characters. No brackets, tags, or timestamps from the ticket title.`,
    `- Description, first line: "Jira: ${ticketUrl ?? issueKey}".`,
    ...(slackUrl === undefined ? [] : [`- Description, second line: "Slack: ${slackUrl}".`]),
    '- Then these markdown sections, in order: "What changed" (two to four bullets a reviewer can check against the diff), "Plan" (each step above, done or not, and any step where the code disagreed with the plan), "Tests" (the commands you ran and what they printed), and "Open questions" (the choice you made for each one, or "None").',
    "- Keep the description under 40 lines. Do not paste this brief into it.",
  ];
}

// factory-desk/agent/lib/slack-link.ts writes `Slack thread: <permalink>` into
// the description of a ticket filed from Slack, after the prose and the
// reporter's quoted request. Only a Slack archive URL is taken, and the last
// one in a text, so ticket text cannot put another link into the brief.
const SLACK_THREAD = /Slack thread:\s*<?(https:\/\/[a-z0-9-]+(?:\.enterprise)?\.slack\.com\/archives\/[CG][A-Z0-9]+\/p\d{16}(?:\?[\w.=&%-]*)?)(?=[\s>|)\]]|$)/g;

/** The filing thread's permalink: the last one in the first text (description, then comments) that has one. */
export function slackThreadUrl(texts: readonly string[]): string | undefined {
  for (const text of texts) {
    const found = [...text.matchAll(SLACK_THREAD)].at(-1)?.[1];
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The ticket's browse URL on the Jira site `cloudId` names, when it is an https site URL rather than an opaque cloud id. */
export function ticketBrowseUrl(issueKey: string, cloudId: string): string | undefined {
  try {
    const url = new URL(cloudId);
    return url.protocol === "https:" ? `${url.origin}/browse/${issueKey}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The comment written on the Jira issue. Plain text with a fixed first line
 * so a re-plan can find the previous one. Reads top to bottom the way pstack
 * presents a plan: what we are doing, how it works today, why it is this
 * way, the chosen design and the shapes it beat, then the checklist.
 */
export function jiraComment(plan: Plan, repo: string, ticketUrl?: string, slackUrl?: string): string {
  const candidates = plan.design.candidates.map(
    (candidate) => `- ${candidate.name} (${candidate.verdict}): ${candidate.shape}. ${candidate.reason}`
  );
  return [
    `${planSentinel(plan.issueKey)} ${plan.title}`,
    `Evidence: ${evidenceLine(plan, repo)}. Recorded by the factory planner; approve in the Slack thread to launch a cloud agent on it.`,
    "",
    ...approvalDigest(plan),
    "Problem",
    plan.problem,
    "",
    "How it works today",
    plan.howItWorks.overview,
    ...list("Key concepts", plan.howItWorks.keyConcepts),
    ...list("Flow", plan.howItWorks.flow, true),
    ...list("Where things live", plan.howItWorks.whereThingsLive),
    ...list("Gotchas", plan.howItWorks.gotchas),
    "",
    "Why it is this way",
    ...plan.why.findings.map((entry) => `- ${entry}`),
    ...list("Preserve", plan.why.preserve),
    ...list("Change", plan.why.change),
    ...list("Avoid", plan.why.avoid),
    ...list("Risk", plan.why.risks),
    ...list("Sources consulted", plan.why.sourcesConsulted),
    "",
    "Design",
    `Usage: ${plan.design.usage}`,
    `Shape: ${plan.design.shape}`,
    "Candidates:",
    ...candidates,
    `Synthesis decision: ${plan.design.synthesisDecision}`,
    ...list("Tradeoffs accepted", plan.design.tradeoffs),
    ...list("Alternatives considered", plan.design.alternatives),
    "",
    "Steps",
    ...plan.steps.map((step, index) => `${index + 1}. ${step}`),
    ...list("Tests", plan.tests),
    ...list("Open questions", plan.openQuestions),
    "",
    `Next step: ${plan.nextStep}`,
    "",
    "Brief:",
    implementationBrief(plan, { repo, ...(ticketUrl === undefined ? {} : { ticketUrl }), ...(slackUrl === undefined ? {} : { slackUrl }) }),
  ].join("\n");
}

/**
 * The fields the desk's Slack plan post reads, one labelled block each,
 * before the long body. The desk parses these labels (`Summary:`,
 * `Approach:`, `Areas:`, `Test plan:`, `Risk:`, `Size:`) out of the comment,
 * so they stay first, single-line or dash-listed, and separated by blank
 * lines: Jira stores the comment as paragraphs, and a label that shares a
 * paragraph with the line before it may come back joined to it.
 */
function approvalDigest(plan: Plan): string[] {
  return [
    `Summary: ${oneLine(plan.summary)}`,
    "",
    `Approach: ${oneLine(plan.approach)}`,
    "",
    "Areas:",
    ...plan.areas.map((area) => `- ${oneLine(area)}`),
    "",
    "Test plan:",
    ...plan.tests.map((entry) => `- ${oneLine(entry)}`),
    "",
    `Risk: ${plan.risk.level}. ${oneLine(plan.risk.reason)}`,
    "",
    `Size: ${plan.size.estimate}. ${oneLine(plan.size.reason)}`,
    "",
  ];
}

function evidenceLine(plan: Plan, repo: string): string {
  if (plan.evidence !== "checkout") return "ticket and request only, no checkout";
  const paths = plan.howItWorks.whereThingsLive;
  return paths.length === 0 ? `read the ${repo} checkout` : `read the ${repo} checkout (${paths.join(", ")})`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function section(heading: string, items: readonly string[]): string | undefined {
  if (items.length === 0) return undefined;
  return [`${heading}:`, ...items.map((item) => `- ${item}`), ""].join("\n");
}

function list(heading: string, items: readonly string[], numbered = false): string[] {
  if (items.length === 0) return [];
  return [`${heading}:`, ...items.map((item, index) => (numbered ? `${index + 1}. ${item}` : `- ${item}`))];
}
