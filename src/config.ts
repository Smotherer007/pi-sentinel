/**
 * Configuration persistence and state for pi-sentinel.
 *
 * Loads `sentinel.config.ts`/`.js` from the project cwd, falling back to
 * `~/.sentinel.config.ts` in the home directory, then finally to defaults.
 *
 * Also persists runtime state (rollback history, last verification runs) to
 * `~/.pi/sentinel-state.json` in an atomic, permission-safe manner.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type { SentinelConfig, SentinelPipelines, PipelineStep } from "./types.ts";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type SentinelConfigInput = DeepPartial<SentinelConfig>;

// ── Defaults ──────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: SentinelConfig = {
  enabled: true,
  // Rollback is opt-in & manual (Claude Code / Codex). A failing check is fed
  // back to the agent to self-correct; `autoRollback` is a deliberate
  // per-project choice for a hard working-tree reset.
  autoRollback: false,
  maxTraceLines: 12,
  pipelines: {
    onFileMutation: [
      // type-check is generous: npx can fetch/compile on first cold run.
      { name: "type-check", cmd: "npx tsc --noEmit", timeoutMs: 15000 },
      // linter is warnOnly by default so projects without eslint don't break.
      { name: "linter", cmd: "npx eslint --quiet", timeoutMs: 8000, warnOnly: true },
    ],
    onTurnEnd: [
      // node:test has no `--bail` flag (Vitest/Jest only), so plain `npm test`.
      { name: "unit-tests", cmd: "npm test", timeoutMs: 30000 },
    ],
  },
  exclude: [
    "**/node_modules/**",
    "**/.git/**",
    "**/*.md",
    "dist/**",
  ],
  include: [],
};

// ── Mutable runtime state ─────────────────────────────────────────────────

export interface SentinelState {
  /** Chronological log of rollback events. */
  rollbackHistory: Array<{
    at: string;
    branch: string;
    head: string;
    reason: string;
    method: string;
  }>;
  /** Last N verification results (capped to 20). */
  lastVerifications: Array<{
    at: string;
    step: string;
    passed: boolean;
    exitCode: number;
    durationMs: number;
  }>;
}

let state: SentinelState = { rollbackHistory: [], lastVerifications: [] };
let activeConfig: SentinelConfig = DEFAULT_CONFIG;
let configPathCache: string | null = null;

// ── Path resolution ───────────────────────────────────────────────────────

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "~";
}

function statePath(): string {
  return path.join(homeDir(), ".pi", "sentinel-state.json");
}

// ── Config loading ────────────────────────────────────────────────────────

/**
 * Type helper for authoring `sentinel.config.ts`.
 */
export function defineConfig(config: SentinelConfigInput): SentinelConfig {
  return deepMerge(DEFAULT_CONFIG, config);
}

function deepMerge<T>(base: T, override: SentinelConfigInput): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Load configuration. Tries, in order:
 *   1. `sentinel.config.ts` in cwd
 *   2. `sentinel.config.js` in cwd
 *   3. `~/.sentinel.config.ts`
 *   4. Defaults
 *
 * Config files are imported dynamically (ESM), so they can contain code.
 */
export async function loadConfig(cwd: string): Promise<SentinelConfig> {
  const candidates = [
    path.join(cwd, "sentinel.config.ts"),
    path.join(cwd, "sentinel.config.js"),
    path.join(homeDir(), ".sentinel.config.ts"),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      // Cache-bust with the file URL mtime so an edited config is re-read
      // instead of Node's module cache handing back the original module.
      const mtime = fs.statSync(file).mtimeMs;
      const url = pathToFileURL(file);
      url.searchParams.set("t", String(mtime));
      const mod = await import(url.href);
      const raw = mod.default ?? mod.config;
      if (raw && typeof raw === "object") {
        activeConfig = deepMerge(DEFAULT_CONFIG, raw as Partial<SentinelConfig>);
        return activeConfig;
      }
    } catch (err) {
      console.warn(`[sentinel] Could not load config ${file}:`, err);
    }
  }

  activeConfig = DEFAULT_CONFIG;
  return activeConfig;
}

export function getConfig(): SentinelConfig {
  return activeConfig;
}

// ── State persistence (atomic, permission-safe) ───────────────────────────

function persistState(): void {
  const filePath = statePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function loadState(): void {
  try {
    const filePath = statePath();
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (raw && typeof raw === "object") {
        state = {
          rollbackHistory: Array.isArray(raw.rollbackHistory) ? raw.rollbackHistory : [],
          lastVerifications: Array.isArray(raw.lastVerifications) ? raw.lastVerifications : [],
        };
      }
    }
  } catch {
    state = { rollbackHistory: [], lastVerifications: [] };
  }
}

// ── State accessors & mutations ───────────────────────────────────────────

export function getState(): SentinelState {
  return state;
}

export function recordRollback(entry: SentinelState["rollbackHistory"][number]): void {
  state.rollbackHistory.unshift(entry);
  if (state.rollbackHistory.length > 50) state.rollbackHistory.pop();
  persistState();
}

export function recordVerification(entry: SentinelState["lastVerifications"][number]): void {
  state.lastVerifications.unshift(entry);
  if (state.lastVerifications.length > 20) state.lastVerifications.pop();
  persistState();
}

// ── Glob matching ─────────────────────────────────────────────────────────

export function matchesGlob(pattern: string, filePath: string): boolean {
  // Build a regex from the glob.
  // - `**/` (leading) is optional: matches zero or more directories.
  // - `**` elsewhere matches anything.
  // - `*` matches within one path segment (no slash).
  const normalized = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "__DOUBLESTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/__DOUBLESTAR__/g, ".*")
    .replace(/^\.\*\//, "(?:.*/)?");
  const re = new RegExp(`^${normalized}$`);
  return re.test(filePath);
}

export function isExcluded(filePath: string, config: SentinelConfig): boolean {
  const rel = filePath.replace(/^\.\//, "").replace(/^\/.*\//, "");
  return config.exclude.some(
    (pattern) => matchesGlob(pattern, rel) || matchesGlob(pattern, filePath),
  );
}

/** @internal Reset internals — for testing only */
export function _resetForTesting(): void {
  state = { rollbackHistory: [], lastVerifications: [] };
  activeConfig = DEFAULT_CONFIG;
  configPathCache = null;
}
