# Auto-drive keys on a branch name

`pr-autofixer` drives a pull request without being asked when a check
fails and the branch starts with a key from `FACTORY_JIRA_PROJECTS`
(`TLSSN-` in this deployment), or the title does and `cursor[bot]` opened
it. That is how it knows the pull request is the factory's, and with no
keys configured it drives nothing on its own. A person who names a branch
that way by hand gets the fixer too. A person who only titles a pull
request that way does not: titling with the ticket key is a common habit,
so that half of the convention is gated on the bot author, the same rule
`factory-worker` uses before it moves a ticket for a pull request.

## Why the answer matters

Free fixes on a hand-named branch are useful until someone gets a push
they did not ask for. The alternative is a registry: the desk records the
pull request URL when `cloud__get` reports it, and the fixer drives only
what it finds there.

## What we know

The convention is one string in `autoDriveProjects` and one claim in
`host.kv`, so the fixer never drives the same pull request twice. The
registry needs one desk reminder, one round trip, and one `host.kv` key.

## The check

Watch for a `TLSSN-` branch the factory did not open. One is enough to
switch to the registry. If none appears in normal use, keep the
convention and skip the extra state.
