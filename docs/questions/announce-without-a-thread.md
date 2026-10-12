# Where a plan announces with no thread to answer

A ticket filed with `@Factory` has a Slack thread, saved in `host.kv`
under `ticket/<KEY>`, and the plan goes back into it. A ticket filed
directly in Jira has no thread. That plan goes to
`FACTORY_DESK_INTAKE_CHANNEL`, or nowhere when the variable is unset.

## Why the answer matters

If most tickets keep arriving in Jira, the common path is the one with no
thread, and a single channel message is a worse home for a plan than a
thread of its own. The desk would then open a thread per ticket and save
it under the same key, which makes the Jira path and the Slack path the
same afterwards.

## What we know

The plan is on the ticket either way, so nothing is lost. What changes is
whether a person reading Slack can follow one ticket in one place.

## The check

Count where tickets come from over the first weeks of use. If most
tickets arrive in Jira, change `announce_plan` to open a thread and
record it, and keep the channel fallback only for a ticket whose thread
post fails.
