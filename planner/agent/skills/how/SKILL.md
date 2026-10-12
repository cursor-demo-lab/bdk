---
description: Ground a ticket before designing. Build the senior-engineer mental model of the subsystem the ticket touches, from the checkout, with read tools only. First of the three planning moves; run it before why and architect.
---

# How

Answer "how does the code this ticket touches work?" at the level a senior
engineer needs to start working in it: enough for a working mental model,
not annotated source. This is pstack's `how` skill run by one read-only
agent: you are the explorer and the explainer.

## Steps

1. **Assess scope.** A single module or a narrow question is simple:
   read it directly. A subsystem across several files, or a cross-cutting
   change, is complex: pick two to four angles (entry points and triggers,
   data shapes and where they are validated, the write path and its side
   effects, tests and conventions) and trace each one in turn before
   writing anything.
2. **Trace, do not skim.** Call `search_sandbox` with the feature, error
   text, or path the ticket names, `ls` the root once, then `grep` and
   `read` the files the search returned. Follow the flow from trigger to
   result. Ten reads is the normal budget; go past it only when a
   decision point is still unclear, and say so in the gotchas. Zero
   matches, or `available: false`, means the claimed failure is not on
   this ref: stop and call `record_needs_info`. Do not design a feature
   the tree does not have.
3. **Reconcile.** Where two angles overlap or disagree, check the code and
   pick the reading the code supports.
4. **Write the explanation** into `howItWorks` for `record_plan`:
   - `overview`: what this thing is, what it does, why it exists.
   - `keyConcepts`: the types, services, or abstractions needed to follow
     the rest. Brief.
   - `flow`: the core. What triggers it, what happens step by step, where
     data goes, what the decision points are. Name files and functions:
     "`exportJob` in `src/export/csv.ts` calls `buildRows`", not "the job
     delegates to a builder".
   - `whereThingsLive`: the paths someone needs to start here. Only paths
     you opened or listed.
   - `gotchas`: non-obvious behavior, surprising coupling, pitfalls. Empty
     when there is nothing worth calling out.

## Style

- Concrete language, not abstractions about abstractions.
- When something is complex, say why. When it is simple, do not pad it.
- Never describe code you did not open. An empty workspace or a search
  that misses the claimed path is `record_needs_info`, not a plan written
  from the ticket.
