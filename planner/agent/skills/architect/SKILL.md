---
description: Design the change before anyone writes code. Sketch at least two structurally distinct candidates from the how and why grounding, screen them against the design red flags, pick a base, graft, and record the synthesis decision, tradeoffs, alternatives, and open questions. Third planning move; feeds record_plan.
---

# Architect

Design before implementing. Sketch the caller's usage, then the data
structures and boundaries, across more than one candidate shape, and
synthesize. If the code later disagrees with the sketch, the implementer
stops and says so; that is written into the brief. This is pstack's
`architect` skill with its arena run inside one agent: you produce every
candidate yourself, so make them differ on purpose.

## Phase A. Ground

`how` and `why` are done before this skill loads. Reread their outputs.
The `preserve` and `avoid` lists are constraints, not suggestions.

## Phase B. Sketch, at least twice

Produce two to four candidates that differ in **shape**, not in detail:
a different owning data structure, a different boundary, a different
place where validation lives. Two flavors of one shape do not count. For
each candidate, before its types, write the caller's usage: what is
imported or called, what comes back. Derive the shape from the usage;
when they disagree, fix the shape.

Discipline for every candidate:

- Data structures first. Trace each dominant access pattern through the
  structure. "We'll add a map later" means the structure is wrong.
- Interface depth. Prefer a small public surface that hides substantial
  behavior, even at the cost of a less simple implementation. No wire or
  transport types on the public API.
- Shared state: if two actors might both write, default to per-actor state
  merged at the read boundary.
- Encode invariants in types over runtime checks over comments. Validate
  at boundaries, trust types inside. One source of truth per invariant.
- Idempotent transitions: what happens if a step runs twice or crashes
  halfway?
- Short call chains: if tracing the flow needs more than three files,
  flatten.

## Phase C. Screen against the red flags

Reject or revise a candidate that shows:

- **Shallow module**: a large interface hiding little. Callers coordinate
  several calls to do one thing; options expose internal stages.
- **Information leakage**: one representation, policy, or protocol detail
  known in more than one place, so changing it needs coordinated edits.
- **Temporal decomposition**: modules split by execution order (load,
  validate, transform, save) instead of by the knowledge they own.
- **Pass-through method**: forwards the same arguments to a call of the
  same shape, adding a layer and hiding nothing.

## Phase D. Pick and graft

Pick the base on which candidate a future maintainer extends most easily
without breaking invariants; on a tie, the smaller surface. Walk each
loser once for the one or two things worth porting into the base, and
fold them in so the result still reads under one mental model. When
every candidate converges on the same shape, say so; that agreement is
the decision. When they wildly diverge, the problem statement was
under-specified: tighten `problem` and sketch again.

## Phase E. Write the design into `record_plan`

Do not reach this phase when `search_sandbox` found no match for the
claimed failure. That turn is `record_needs_info`, not a design.

- `design.usage`: the caller's view, written first.
- `design.shape`: data structures, flow through the signatures, the
  load-bearing decision, what the public surface hides, where validation
  lives, what the system deliberately does not do.
- `design.candidates`: every candidate with `name`, `shape`, `verdict`
  (`base`, `grafted`, or `rejected`), and the `reason` in red-flag and
  interface-depth terms. Exactly one `base`.
- `design.synthesisDecision`: base and why, grafts and from where,
  rejections and why.
- `design.tradeoffs`: "we accept X in exchange for Y", one per line,
  including anything a reader might mistake for an oversight.
- `design.alternatives`: the shapes considered and one line each on why
  they lost. Judge on interface depth, not implementation simplicity.
- `openQuestions`: what the human must weigh in on, phrased as questions.
- `nextStep`: the first thing to build against the shape, one sentence.
- `steps` and `tests`: the ordered, verifiable checklist the implementer
  runs, derived from the base.
- The approval digest, written from the finished design: `summary`,
  `approach` (the base in plain words), `areas`, `risk` (`level` and
  `reason`), `size` (`estimate` and `reason`). The desk posts these to
  Slack for the approver; they restate the plan and add nothing to it.

Do not fold the design decision silently into the steps. A plan whose
candidates all read the same, or whose base has no stated reason, is not
finished.
