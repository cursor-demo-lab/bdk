# security-reviewer

Cursor Agent SDK project (`@cursor/july`). This file is for coding agents
editing the project. The served agent's prompt is `agent/instructions.md`.

## Loop

```bash
agent-sdk validate --dir .
agent-sdk info --dir . --json
agent-sdk run --dir . --message "..."
agent-sdk eval --dir .
npm run check && npm test
```

Run the CLI under Node, never Bun.

## Layout

- `agent/instructions.md` is the always-on prompt. Keep it short.
- `agent/tools/<name>.ts` is one tool per file. The filename is the tool name.
- `agent/lib/` is shared code. Never discovered.
- `evals/` is filesystem evals (`evals/evals.config.ts` required).
  Not `agent/evals/`. That path is ignored.

## Do not

- Grow host TypeScript for formatting, classification, or reply composition.
  That stays in instructions/skills. Host code owns auth, idempotency,
  evidence seeding, and side-effect gates.
- Add npm deps on a first cut. Stick to what `@cursor/july` already ships.
  The `@opentelemetry/*` packages are July's own, pinned to the versions it
  installs. Runtime code needs only `@opentelemetry/api` and `@opentelemetry/api-logs`;
  the SDK packages are devDependencies for tests.
- Point `serve` at a parent folder during bring-up. It mounts every sibling.

## Pointers

- Package loop: `node_modules/@cursor/july/AGENTS.md`
- Skills: `node_modules/@cursor/july/skills/` (`create-agent`, `deploy`, `evals`, `hillclimb`, `debug`)
- Docs: `npx -p @cursor/july@0.2.25 agent-sdk docs`
- LLM docs index: `node_modules/@cursor/july/dist/docs/llms.txt`
