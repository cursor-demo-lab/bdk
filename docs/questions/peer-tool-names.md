# Peer tool names come from filename order

The desk holds two peer connections and both peers advertise `ask` and
`check`. July suffixes the later connection, so the planner is `ask_2` and
`check_2` only while `ticket-planner.ts` sorts after `pr-autofixer.ts`.
Renaming either file swaps the names underneath the desk's instructions.

## Why the answer matters

The desk's instructions name the tools in prose. A rename that nobody
notices sends a plan request to the fixer. The question is whether July
offers a way to pin an advertised name, or whether the factory has to
keep holding the convention with a filename.

## What we know

`desk.eval.ts` names all four tools, so a swap fails the evals loudly
rather than quietly. That makes the risk visible, not absent.

## The check

Read the connection loader in the installed `@cursor/july` for an explicit
name option. If there is none, rename `ticket-planner.ts` to sort first in
a branch, run `agent-sdk eval --dir ./factory-desk`, and confirm the evals
catch it. Then decide whether to record the constraint in
`factory-desk/AGENTS.md` as a rule against renaming.
