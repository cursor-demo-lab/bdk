# Two `cursorAccount` consumers on one host

Two projects in this factory declare a `cursorAccount` GitHub channel over
the same repositories: `security-reviewer` and `pr-autofixer`. Does
Cursor's source control event stream deliver one pull request event to
both channels, or does it deliver per principal, so the two relays split
or duplicate what arrives?

## Why the answer matters

If delivery is per principal, serving both projects on one host either
drops the review or runs the fixer twice on the same failed check. The
factory would then need one relay project that fans out over peer
connections, which is a different shape from the one in `plan.md`.

## What we know

The relay starts without `--cursor-events` whenever a mount has a
`cursorAccount` GitHub channel with a repository scope, and
`resolveCursorGithubEventConfig` unions the repositories of every target.
So one relay serves both channels. Nobody has watched what that union
does to delivery.

## The check

Serve both projects on one dev host and replay one pull request:

```bash
agent-sdk github replay <owner>/<repo>#<n> --dir ./security-reviewer
```

Then read the host log. `security-reviewer` should post its findings and
`pr-autofixer` should buffer the same event. Two posts, or one silent
channel, answers the question.
