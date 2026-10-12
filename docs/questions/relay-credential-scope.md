# Credential scope across GitHub channels

`resolveCursorGithubPermissions` takes the highest permission tier across
every mounted target. `pr-autofixer` asks for `contents-write` because it
pushes a fix branch. Does `security-reviewer` still receive its own
narrower credential, or does the host hand both channels the same
`contents-write` token?

## Why the answer matters

The security reviewer reads a diff and writes one comment. It has no
reason to hold a token that can push. If the host credential is shared,
the factory teaches the opposite of what it claims about least privilege,
and the fix is to serve the reviewer on its own host.

## What we know

The tier resolution lives in
`channels/github/cursor-account.ts`. It is the max across targets, which
settles the host credential. Whether each channel's outbound calls mint a
per-channel token under that maximum is not written down anywhere we have
read.

## The check

Serve both projects, then from inside each channel's handler log the
scopes of the token the channel actually uses. A reviewer token that
reports `contents: write` fails the check.
