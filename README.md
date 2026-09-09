# pi-sentinel

Astra/Codex-style in-loop verification & rollback hardening for the [pi coding agent](https://github.com/earendil-works/pi).

Sentinel prunes failed tool-execution traces (saving tokens), runs configured validation pipelines (`tsc`, `eslint`, tests), and rolls the working tree back when invariant violations are detected — so bad code never pollutes the agent's context.

## Installation

```bash
# Install from npm (once published)
pi install npm:@patimweb/pi-sentinel

# Install from local path during development
pi install /path/to/pi-sentinel
```

## How it works

```
                    ┌─────────────────────────────────────────┐
                    │               Pi Core Loop              │
                    └────────────────────┬────────────────────┘
                                         │ Tool Call: edit / write
                                         ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ @patimweb/pi-sentinel Guard                                               │
│                                                                           │
│  1. Pre-Check Diff ──> 2. Execute Linter / TSC ──> 3. Trace Pruning        │
│                                                          │                │
└──────────────────────────────────────────────────────────┼────────────────┘
                                                           │
                                   ┌───────────────────────┴───────────────────────┐
                                   ▼                                               ▼
                         [Status: SUCCESS]                                 [Status: FAILURE]
                                   │                                               │
                                   ▼                                               ▼
                       Commit Turn to History                       1. Git Worktree Rollback
                                                                    2. Inject Clean Error Trace
```

## Tools

| Tool | Description |
|------|-------------|
| `sentinel_verify` | Run verification pipelines on demand (mutation or turn). Optionally roll back on failure. |
| `sentinel_rollback` | Manually roll back the working tree to HEAD. |
| `sentinel_status` | Show active config, git state, rollback + verification history. |

## Commands

| Command | Description |
|---------|-------------|
| `/sentinel` | Show help. |
| `/sentinel status` | Show current state. |
| `/sentinel verify` | Run `onFileMutation` pipelines now. |
| `/sentinel test` | Run `onTurnEnd` pipelines now. |
| `/sentinel rollback` | Roll back the working tree. |
| `/sentinel config` | Dump the active configuration. |

## Configuration

Create `sentinel.config.ts` in the project root (or `~/.sentinel.config.ts`):

```ts
import { defineConfig } from "@patimweb/pi-sentinel";

export default defineConfig({
  enabled: true,
  // Rollback is opt-in. Like Claude Code / Codex, a failed check is fed back
  // to the agent so it can self-correct. Set `autoRollback: true` only if you
  // also want sentinel to hard-reset the working tree on a failure.
  autoRollback: false,
  maxTraceLines: 12,

  pipelines: {
    onFileMutation: [
      { name: "type-check", cmd: "npx tsc --noEmit", timeoutMs: 15000 },
      { name: "linter", cmd: "npx eslint --quiet", timeoutMs: 8000, warnOnly: true },
    ],
    onTurnEnd: [
      { name: "unit-tests", cmd: "npm test", timeoutMs: 30000 },
    ],
  },

  exclude: ["**/node_modules/**", "**/.git/**", "**/*.md", "dist/**"],
});
```

> **warnOnly**: `linter` is `warnOnly` by default so projects without eslint don't trigger a hard rollback. Set `warnOnly: false` to make a step critical.

## Hooks & trigger points

| Hook | Trigger | Pipeline group | On failure |
|------|---------|----------------|------------|
| `tool_result` | after `edit` / `write` | `onFileMutation` | Modify result to `isError` (feedback loop) |
| `turn_end` | after an agent turn | `onTurnEnd` | Wake agent with the error |
| `sentinel_verify` | on demand | `mutation` or `turn` | Report / optional rollback |

## Design

Following the data-oriented pattern used across `@patimweb` packages:

- All domain data is represented as plain immutable interfaces (`src/types.ts`)
- I/O is isolated in client modules (`src/clients/`)
- Pure formatting functions convert data to display strings (`src/formatting/`)
- Each capability is a single-responsibility tool module (`src/tools/`)
- Config/state uses atomic, permission-safe file persistence (`src/config.ts`)

## Synergy with pi-mindplace

| Package | Phase | Role |
|---------|-------|------|
| `pi-mindplace` | Read phase | Builds a minimal AST-graph context so Pi knows exactly what/where to edit. |
| `pi-sentinel` | Write phase | Guarantees every change passes type/lint/test checks and discards failed attempts before they compromise context. |

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
