# Jev triage eval

Measures how Jev types (Bug, Story, Task) and grades (low … urgent) what the desk sends it. Each
case runs through the desk's real `triageIntake` (`agent/lib/intake-triage.ts`) against live
TypeSafe, with TLSSN's issue types seeded and no Jira connection, so no ticket is created and nothing
is written anywhere.

```bash
cd factory-desk
TYPESAFE_API_KEY=… npm run eval:jev-triage                     # all cases, 3 runs each
npm run eval:jev-triage -- --split tune --label my-change      # tune split only
npm run eval:jev-triage -- --split holdout                     # frozen holdout only
npm run eval:jev-triage -- --types Bug,Task                    # a project with no Story
npm run eval:jev-triage -- --only tlssn-43 --runs 5
npm run eval:jev-triage -- --min-type-accuracy 0.9 --max-clear-bug-stories 0   # exit 1 below a bar
```

The key comes from the environment or `.env.local`. Options: `--runs N` (3), `--concurrency N` (6),
`--label NAME`, `--out DIR` (`results/`, git-ignored), `--only id,…`, `--category bug,story,…`,
`--split tune|holdout`, `--types …`, `--timeout-ms N`, `--judge [all|labels|critique]`. The report (JSON and Markdown) gives type
accuracy lenient and strict, a type confusion matrix, clear bugs typed Story, severity accuracy
and its confusion matrix, the fallback rate and its reasons, confidence buckets, run-to-run flips,
and each miss.

## Cases

- `cases.ts`: the tune split (84 cases: real TLSSN tickets and Slack reports, plus written ones).
  Each case has an expected type and severity, `accept` for defensible alternates, `clearBug` when
  typing it Story is a clear error, and a rationale.
- `holdout.ts`: 20 cases written before any run against the tuned code, with fresh wording:
  "broken thing + could it…?" bugs, Stories that sound like complaints, payee/contact data loss.
  **Frozen:** its sha256 is pinned in `jev-triage-eval.test.ts`. Never tune against it; to add
  cases, add them to `cases.ts`, or write a new holdout file and pin its hash.

`jev-triage-eval.test.ts` and `judge.test.ts` run in `npm test` with no key: dataset integrity, the holdout hash, the
exact request body Jev gets, the fallbacks, the guards, and the scoring.

## LLM judge (`--judge`)

```bash
CURSOR_API_KEY=… TYPESAFE_API_KEY=… npm run eval:jev-triage -- --judge            # both passes
npm run eval:jev-triage -- --judge labels      # label check only
npm run eval:jev-triage -- --judge critique    # Jev critique only
```

`judge.ts` calls Claude Opus 5.5 at low effort (`claude-opus-5-5`, `effort: low`) through the Cursor SDK (`@cursor/sdk`: a local agent with no tools, so the model only answers in text, and inference is Cursor-hosted). It runs two passes:

1. **Label check.** The judge labels every selected case (type, severity, and a rationale) from the reporter's words and a neutral policy (`JUDGE_POLICY`). It never sees our labels. The report gives agreement (strict, and lenient through either side's alternates) and lists the disagreements; a person decides whether a label is wrong.
2. **Jev critique.** Every tune case Jev missed, or answered at or under 0.52 on type, severity, or the gate, gets a reason and one concrete wording change to Jev's questions, marked general or case-specific. The judge then merges the general changes into at most three edits. Holdout cases are never critiqued.

The judge is live only: `judge.test.ts` covers its prompts, parsing, and scoring with a stubbed call, so `npm test` needs no key.

Latest numbers, the label changes, and the improvement loop are in [RESULTS.md](RESULTS.md).
