# The brief crosses two models

Host code writes the implementation brief in `record_plan`. The planner's
model returns it, either as the planning reply or as the answer to a `Get
plan`. The desk's model pastes it into `cloud__launch`. Two models carry
text they are told to copy and not to edit. Do they copy it?

## Why the answer matters

The brief is the whole instruction the cloud agent gets. A model that
paraphrases it drops the ticket key, the merge rule, or a test, and the
pull request that comes back is not the plan anyone approved.

## What we know

Both models are told to copy. `approved-plan-parks-launch` checks that the
ticket key and the merge rule survive the trip, which catches the two
failures that matter most. It does not prove the brief arrives whole.

## The check

Compare the prompt in the parked `cloud__launch` call against the `brief`
field on the plan artifact, across a handful of real runs. If they drift,
add a desk-side `launch_plan` server tool that reads the artifact and
calls the launch itself. That costs the desk its rule of owning no tools,
so the drift has to be real first.
