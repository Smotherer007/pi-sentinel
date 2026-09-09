import { defineConfig } from "./src/config.ts";

export default defineConfig({
  enabled: true,
  autoRollback: true,
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
      { name: "unit-tests", cmd: "npm test -- --bail", timeoutMs: 30000 },
    ],
  },

  exclude: ["**/node_modules/**", "**/.git/**", "**/*.md", "dist/**"],
});
