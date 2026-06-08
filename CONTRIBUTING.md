# Contributing to conduit

Thanks for helping build the authorization layer for the agent economy.

## Setup

```bash
bun install
bun test          # run the suite
bun run typecheck # tsc --noEmit across all directories
```

## Project layout

| Directory | What lives here |
|-----------|-----------------|
| `kernel/` | The authorization kernel — permissions, capabilities, audit, approvals, registry. The core; keep it dependency-light (`zod` only). |
| `mcp/` | conduit exposed as an MCP server (STDIO + HTTP transports). |
| `control-plane/` | The hosted HTTP API, dashboard, and billing (the commercial layer). |
| `web/` | The landing page — a static dark-technical marketing site. |
| `cli/` | Offline demos. |
| `examples/` | A live LLM agent governed by conduit. |
| `tests/` | `bun:test` suites mirroring the kernel modules. |

## Ground rules

- **The kernel stays small and pure.** New runtime dependencies in `kernel/` need a strong reason.
- **Every kernel change ships with a test.** The suite must stay green.
- **Immutability.** Treat records (capabilities, audit events) as immutable — copy, don't mutate.
- **Typecheck must pass.** `bun run typecheck` is clean before every PR.
- **No `any`.** Use `unknown` at boundaries and narrow.
- **Files stay focused.** Prefer many small modules over large ones.

## Before opening a PR

```bash
bun run typecheck && bun test
```

Then describe *why* the change is needed, not just what changed.

## Reporting issues

Security-sensitive issues (anything affecting the soundness of the permission
model or the audit chain) — please flag them clearly in the issue title.
