import { defineConfig } from "./src/config.ts";

export default defineConfig({
  // Verification + feedback by default (Claude Code / Codex). Restore is
  // opt-in: set `autoRollback: true` only if you also want sentinel to
  // restore the files it changed on a failed check. Recovery is otherwise
  // manual.
  enabled: true,
  autoRollback: false,
  maxTraceLines: 12,

  pipelines: {
    onFileMutation: [
      // Keep this group FAST — it runs after every edit/write. The project's
      // own script uses the locally installed TypeScript (no `npx` registry
      // lookup) and `--incremental`, so repeat runs only re-check changed
      // files.
      { name: "type-check", cmd: "npm run typecheck", timeoutMs: 60000 },
    ],
    onTurnEnd: [
      // Slow, whole-project checks belong at turn end.
      { name: "unit-tests", cmd: "npm test", timeoutMs: 60000 },
    ],
  },

  include: ["**/*.ts"],
  exclude: ["**/node_modules/**", "**/.git/**", "**/*.md", "dist/**"],
});
