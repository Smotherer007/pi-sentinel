import { defineConfig } from "./src/config.ts";

export default defineConfig({
  // Verification + feedback by default (Claude Code / Codex). Rollback is
  // opt-in: set `autoRollback: true` only if you also want sentinel to hard-
  // reset the working tree on a failed check. Recovery is otherwise manual.
  enabled: true,
  autoRollback: false,
  maxTraceLines: 12,

  pipelines: {
    onFileMutation: [
      // Use the project's own script (local TypeScript) — avoids `npx` registry
      // lookups that hang in the subprocess. `tsc --noEmit` checks the whole
      // installed pi SDK tree (~1700 files), so it can take >12s cold; the
      // timeout is generous to avoid spurious failures.
      { name: "type-check", cmd: "npm run typecheck", timeoutMs: 60000 },
    ],
    onTurnEnd: [
      // node:test has no `--bail` flag (Vitest/Jest) — plain `npm test`.
      { name: "unit-tests", cmd: "npm test", timeoutMs: 30000 },
    ],
  },

  exclude: ["**/node_modules/**", "**/.git/**", "**/*.md", "dist/**"],
});
