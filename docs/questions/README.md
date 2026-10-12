# Questions

One file per open question about this factory. A question earns a file
when the answer changes what we build and nobody has run the check yet.
`rationale.md` keeps the questions that are already answered, next to the
decision they support.

A file states the question, why the answer matters, what we know, and the
check that would settle it. When the check runs, write the answer at the
top of the file, date it, and move the one-line result into
`rationale.md`. Keep the file. A closed question is the record of why the
factory is shaped the way it is.

## Open

| Question | Blocks | Check |
| --- | --- | --- |
| [Two `cursorAccount` consumers on one host](two-cursoraccount-consumers.md) | Serving `security-reviewer` and `pr-autofixer` together | Replay one pull request with both mounted |
| [Credential scope across GitHub channels](relay-credential-scope.md) | Keeping the reviewer read-only | Read the minted token's scopes on both channels |
| [Does `startDrive` fail closed for an unlisted repository](start-drive-unlisted-repo.md) | Trusting the allowlist as the gate | Answered 22 Sep 2026 by reading `start-drive.ts`: it did not, so the gate was added there (`out_of_scope`); result in `rationale.md` |
| [Peer tool names come from filename order](peer-tool-names.md) | Renaming a connection file | Rename in a branch and run the desk evals |
| [Where a plan announces with no thread to answer](announce-without-a-thread.md) | Tickets filed in Jira, not Slack | Count how many tickets arrive from each side |
| [The brief crosses two models](brief-across-two-models.md) | Whether the desk needs its own launch tool | Compare the launched prompt to the artifact |
| [Auto-drive keys on a branch name](auto-drive-naming-convention.md) | Whether a person's branch gets the fixer | Watch for a hand-named `TLSSN-` branch |
| [How long the handoff waits on the peer call](hook-holds-the-event-stream.md) | Triage latency under load | Time `plan_issue` from inside `record_triage`; the hook itself is gone, answered in the file |
