# How long the chain hook blocks the triage session

**Answered 22 Sep 2026.** The hook is gone. `record_triage` calls the
planner at the end of its own `execute`, so the wait is inside the tool's
turn and nothing depends on hook dispatch surviving process exit. The
remaining question, how long `plan_issue` takes to admit a session under
load, is still worth one measurement, and the check below applies to the
call in the tool.

The hook that chains triage to planning calls `plan_issue` over the peer
edge and waits. `plan_issue` returns as soon as the planning session is
admitted, not when the plan is written, so the wait is one MCP round trip.
How long is that trip when the host is busy?

## Why the answer matters

The hook runs inside the triage session's event stream. A slow round trip
delays every later event in that session, and triage is the step a person
is waiting on after filing a ticket.

## What we know

The wait covers admission only. If `ctx.send` ever changes to block until
the turn completes, the same hook would block the stream for the length of
a plan, which is minutes.

## The check

Log the time around the `plan_issue` call at the end of `execute` in
`triage-jira/agent/tools/record_triage.ts` (the hook file no longer
exists) and read it under a few concurrent tickets. If it grows past a second, either use `waitUntil` or
fire the call without awaiting it and let the planner's own session report
failure.
