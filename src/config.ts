/**
 * Configuration: defaults, the optional `sentinel.config.ts`, and where
 * sentinel keeps its files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { detectChecks } from "./detect.ts";
import type { SentinelConfig, Step } from "./types.ts";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends unknown[] | string ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export type SentinelConfigInput = DeepPartial<SentinelConfig>;

export const DEFAULT_CONFIG: SentinelConfig = {
  enabled: true,
  checks: { afterEdit: "auto", beforeDone: "auto" },
  repair: { enabled: true, maxAttempts: 3 },
  checkpoints: { enabled: true, retention: 30 },
  maxOutputTokens: 2500,
  maxTraceLines: 20,
  exclude: ["**/node_modules/**", "**/.git/**", "dist/**", "build/**", "coverage/**", "graph-out/**"],
  mindplace: true,
  contract: true,
};

export const DEFAULT_TIMEOUT_MS = 120_000;

/** Identity helper so a config file gets type checking. */
export function defineConfig(config: SentinelConfigInput): SentinelConfigInput {
  return config;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key], value) : value;
  }
  return out as T;
}

export function resolveConfig(input: SentinelConfigInput | undefined): SentinelConfig {
  const merged = merge(structuredClone(DEFAULT_CONFIG), input);
  merged.repair.maxAttempts = Math.max(0, Math.floor(Number(merged.repair.maxAttempts) || 0));
  merged.checkpoints.retention = Math.max(1, Math.floor(Number(merged.checkpoints.retention) || 1));
  return merged;
}

/** Problems a user should hear about instead of a silently wrong run. */
export function configProblems(config: SentinelConfig): string[] {
  const problems: string[] = [];
  for (const group of ["afterEdit", "beforeDone"] as const) {
    const steps = config.checks[group];
    if (steps === "auto") continue;
    if (!Array.isArray(steps)) {
      problems.push(`checks.${group} must be "auto" or an array of steps`);
      continue;
    }
    steps.forEach((step, i) => {
      if (!step || typeof step.name !== "string" || typeof step.cmd !== "string") {
        problems.push(`checks.${group}[${i}] needs a name and a cmd`);
      } else if (step.timeoutMs !== undefined && !(step.timeoutMs > 0)) {
        problems.push(`checks.${group}[${i}] (${step.name}): timeoutMs must be positive`);
      }
    });
  }
  return problems;
}

export const CONFIG_FILES = ["sentinel.config.ts", "sentinel.config.js", "sentinel.config.mjs"];

export interface LoadedConfig {
  config: SentinelConfig;
  /** The file it came from, or null for the defaults. */
  source: string | null;
  problems: string[];
}

/**
 * Loads `sentinel.config.*` from the project root, re-importing only when the
 * file content changed, so edits take effect without restarting pi.
 */
export class ConfigLoader {
  private cached: { key: string; loaded: LoadedConfig } | null = null;

  async load(cwd: string): Promise<LoadedConfig> {
    for (const name of CONFIG_FILES) {
      const file = path.join(cwd, name);
      let content: Buffer;
      try {
        content = fs.readFileSync(file);
      } catch {
        continue;
      }
      const stamp = createHash("sha1").update(content).digest("hex").slice(0, 12);
      const key = `${file}#${stamp}`;
      if (this.cached?.key === key) return this.cached.loaded;
      try {
        const url = pathToFileURL(file);
        url.searchParams.set("v", stamp);
        const mod = await import(url.href);
        const config = resolveConfig(mod.default ?? mod.config);
        const loaded = { config, source: file, problems: configProblems(config) };
        this.cached = { key, loaded };
        return loaded;
      } catch (err) {
        const loaded = {
          config: DEFAULT_CONFIG,
          source: file,
          problems: [`could not load ${name}: ${(err as Error).message}`],
        };
        this.cached = { key, loaded };
        return loaded;
      }
    }
    this.cached = null;
    return { config: DEFAULT_CONFIG, source: null, problems: [] };
  }
}

export interface ResolvedChecks {
  afterEdit: Step[];
  beforeDone: Step[];
  detected: boolean;
  reasons: string[];
}

/** The steps to run, with `"auto"` replaced by what the project has. */
export function resolveChecks(config: SentinelConfig, cwd: string): ResolvedChecks {
  const needsDetection = config.checks.afterEdit === "auto" || config.checks.beforeDone === "auto";
  const detected = needsDetection ? detectChecks(cwd) : null;
  const pick = (value: Step[] | "auto", auto: Step[] | undefined): Step[] =>
    value === "auto" ? (auto ?? []) : Array.isArray(value) ? value.filter((s) => s && s.cmd) : [];
  return {
    afterEdit: pick(config.checks.afterEdit, detected?.afterEdit),
    beforeDone: pick(config.checks.beforeDone, detected?.beforeDone),
    detected: detected !== null,
    reasons: detected?.reasons ?? [],
  };
}

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || process.cwd();
}

/** Per-project directory for checkpoints and spilled output, outside the repo. */
export function stateDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 10);
  const base = path.basename(resolved).replace(/[^a-zA-Z0-9._-]/g, "_") || "root";
  return path.join(homeDir(), ".pi", "sentinel-state", `${base}-${hash}`);
}
