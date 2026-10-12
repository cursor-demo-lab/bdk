---
description: Find the recorded reasons the current shape exists before changing it, and turn them into Preserve, Change, Avoid, and Risk constraints. Second planning move, after how and before architect. Uses git_history and read_ticket plus code comments and tests; never cites code as evidence for its own intent.
---

# Why

`how` answers what the code does. `why` answers what forces gave it its
shape. Code carries no motivation; that lives in commits, pull requests,
tickets, comments, and tests, all incomplete. Pretending otherwise
produces confident guesses that mislead the implementer. This is pstack's
`why` skill run by one agent over the evidence this factory can reach.

## Evidence you have

| Source | How to read it here |
| --- | --- |
| Source control | `git_history` on the files `how` named (whole repo first, then each path). Subjects carry the pull request number as `(#N)`. Always consult. |
| Issue tracker | `read_ticket` result: title, description, comments. The `Triage:` comment is the ticket stage's verdict. |
| Code comments and tests | `grep` for `TODO`, `why`, `because`, `workaround`, the ticket key, and PR numbers; `read` the tests around the flow. A test that pins a behavior is a decision someone made. |
| Long-form docs in the checkout | `README`, `docs/`, `AGENTS.md`, `.cursor/rules` near the touched code. |
| Chat, observability, error tracking, analytics | Not reachable from this agent. Name them under `sourcesConsulted` as not searched, so the gap is visible. |

## Steps

1. **Anchor.** From `how`, list the files, symbols, and the ticket. Call
   `git_history` for the repository and for each anchored path. Note
   commits and PR numbers that touched the flow.
2. **Search each source** in the table. Record what each returned,
   including nothing.
3. **Tier every claim.** Each entry in `findings` starts with its tier:
   - `[Direct]`: an author wrote the reason down. A commit subject, a PR
     number, a comment, a ticket line. Cite it.
   - `[Supported]`: several indirect items converge. Cite them.
   - `[Inferred]`: your reading of the context. Hedge: "appears to",
     "likely", "suggests". Make the inference chain visible.
   - `[Speculative]`: plausible, thin, other stories fit. Say so.
   - `[Unknown]`: you looked and found nothing. Name what you searched.
   Never cite code as evidence for its own intent. Code is mechanics.
4. **Convert to constraints** for the design:
   - `preserve`: every explicit constraint the reporter stated (keep X,
     a limit, exact copy, a placeholder, no other changes), in their
     words, then what is load-bearing per the record. The change keeps
     all of it. Ten lines at most: merge related constraints into one
     line rather than drop any. A later reporter reply that explicitly
     changes a constraint replaces it.
   - `change`: free to alter; nothing in the record defends it.
   - `avoid`: tried and rejected before, or undoes a deliberate decision.
   - `risks`: where the rationale is thin and an unrecorded assumption
     could break.
5. **Fill `sourcesConsulted`**: one line per source, what was searched,
   what it returned or that it was unreachable.

## Failure modes

- Recency bias: the last commit is not the whole story. Trace back.
- Rubber-stamping the ticket's hypothesis. Check it against the record.
- A confident tone on thin evidence. Better an open `[Unknown]` than a
  filled-in guess the implementer acts on.
