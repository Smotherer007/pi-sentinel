import { defineConfig } from "./src/config.ts";

export default defineConfig({
  enabled: true,
  autoRollback: true,
  maxTraceLines: 12,

  pipelines: {
    onFileMutation: [
      { name: "type-check", cmd: "npx tsc --noEmit", timeoutMs: 6000 },
      { name: "linter", cmd: "npx eslint --quiet", timeoutMs: 4000 },
    ],
    onTurnEnd: [
      { name: "unit-tests", cmd: "npm test -- --bail", timeoutMs: 12000 },
    ],
  },

  exclude: ["**/node_modules/**", "**/.git/**", "**/*.md", "dist/**"],
});
