# Learnings

What we learned by reading other people's factories, kept separate from
what we decided. `rationale.md` says why this factory is shaped the way it
is. These files say what the evidence was.

## Files

| File | Source | What it holds |
| --- | --- | --- |
| [everysphere-factory-patterns.md](everysphere-factory-patterns.md) | The 25 Agent SDK agents in `<PRIVATE_MONOREPO>` under `factory/`, read 22 Sep 2026 | How Cursor's own factory chains agents, threads Slack, gates writes, stores state, plans, drives GitHub, writes to a tracker, evaluates, tests, and lays out a project |
| [production-idioms-to-adopt.md](production-idioms-to-adopt.md) | The same read | Eight changes worth making here, each with the file to copy from and the file it changes |
| [where-this-factory-diverges.md](where-this-factory-diverges.md) | The same read | Six things this factory does that the production factory avoids, with the evidence, so each one is a choice and not an accident |

Paths in these files are relative to `factory/` in the `everysphere`
checkout unless they start with a project name in this repository.

## Checked against the framework

Every API claim in these files was read back against the installed
`@cursor/july@0.2.1` type declarations on 22 Sep 2026, in
`factory-desk/node_modules/@cursor/july/dist`. That matters because the
everysphere factory is on the same release line: its agents depend on
`workspace:@cursor/bdk@*`, which is version 0.2.1. Nothing it leaves out
is missing from the version we hold, so each difference is a choice rather
than a version gap.

Four checks changed what the files say, and each one is marked in place.

| Claim | What 0.2.1 says |
| --- | --- |
| Peer connections are exotic | `{ agent: "<slug>" }` is a first-class connection transport with its own type guard, `isPeerConnectionTransport` (`types.d.ts:1043`). Ours are supported, just unused over there |
| The kv has no compare-and-set | Right for the agent-facing `host.kv`, which is typed `HostKvApi` with `get`, `put`, and `delete`. A storage backend can supply `HostKvCasApi` with `putIfAbsent`, `putIfVersion`, and `listKeys`, and `supportsKvCas(kv)` probes for it (`types.d.ts:533,571`) |
| Eval writes need a hand-rolled dry run | 0.2.1 has both. `purpose` is `"live" \| "eval"` (`types.d.ts:1568`), and separately a session can be created with `dryRun`, in which the host answers a `"write"` tool from its `dryRunResult` and never calls `execute` (`tools.d.ts:92`, `types.d.ts:1441`) |
| `--url` and `--slug` eval routes | Both are documented flags on `agent-sdk eval` in 0.2.1 (`dist/docs/reference/cli.md:176,178`) |
