/**
 * VerificationCache — do not re-answer a question that has not changed.
 *
 * Re-running `tsc` on a file that has not been touched since the last green
 * run is wasted wall-clock time in a loop where every second is latency the
 * user feels. The cache key is built from everything that can change the
 * answer:
 *
 *   - the content of every changed file (hashed, not mtime),
 *   - the content of the changed files' *dependencies* the toolchain reads
 *     (lock files, tsconfig, package.json),
 *   - the effective step configuration (command, cwd, env, timeout),
 *   - the Node version and the few environment variables that alter results,
 *   - the trigger, because mutation and turn pipelines are different checks.
 *
 * Two safety rules:
 *   1. **only passing runs are cached.** A cached failure would freeze a
 *      transient problem (a flaky port, a cold cache) into a permanent one.
 *   2. **a step marked `cacheable: false` disables caching for the whole run.**
 *      Non-deterministic suites are exactly what must never be reused.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { projectDir } from "../config.ts";
import { hashFile } from "./snapshot.ts";
import type { PipelineRunResult, PipelineStep } from "../types.ts";

/** Bumped when the key construction changes, invalidating old entries. */
export const CACHE_VERSION = 1;

/** Files that change what a check would report, even when sources do not. */
const DEPENDENCY_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "tsconfig.json",
  "tsconfig.base.json",
];

/** Environment variables that can change a verification result. */
const RELEVANT_ENV = ["NODE_ENV", "CI", "TZ", "LANG", "LC_ALL", "NODE_OPTIONS"];

export interface CacheKeyInput {
  trigger: "onFileMutation" | "onTurnEnd";
  cwd: string;
  /** Files the verification is about (absolute or relative). */
  focusPaths: string[];
  /** The steps that will actually run, in order. */
  steps: PipelineStep[];
  env?: Record<string, string | undefined>;
}

/** Stable description of a step's effective configuration. */
function stepSignature(step: PipelineStep): string {
  return JSON.stringify({
    name: step.name,
    cmd: step.cmd,
    timeoutMs: step.timeoutMs,
    cwd: step.cwd ?? null,
    warnOnly: step.warnOnly ?? false,
    priority: step.priority ?? null,
    phase: step.phase ?? null,
    env: step.env ? Object.entries(step.env).sort() : null,
  });
}

/**
 * Build the cache key for a run. Two runs share a key only if they would ask
 * exactly the same question of exactly the same code state.
 */
export function createCacheKey(input: CacheKeyInput): string {
  const env = input.env ?? process.env;

  const files = [...new Set(input.focusPaths.map((p) => path.resolve(p)))]
    .sort()
    .map((abs) => {
      const rel = path.relative(input.cwd, abs) || abs;
      return `${rel.replace(/\\/g, "/")}:${hashFile(abs) ?? "missing"}`;
    });

  const dependencies = DEPENDENCY_FILES.map((name) => {
    const abs = path.join(input.cwd, name);
    return `${name}:${fs.existsSync(abs) ? hashFile(abs) : "absent"}`;
  });

  const environment = RELEVANT_ENV.map((name) => `${name}=${env[name] ?? ""}`);

  const payload = JSON.stringify({
    version: CACHE_VERSION,
    trigger: input.trigger,
    node: process.version,
    files,
    dependencies,
    environment,
    steps: input.steps.map(stepSignature),
  });

  return createHash("sha1").update(payload).digest("hex").slice(0, 24);
}

interface CacheEntry {
  at: number;
  result: PipelineRunResult;
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

export interface VerificationCacheOptions {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  persist: boolean;
  cwd: string;
}

/**
 * In-memory cache with optional disk persistence per project.
 *
 * A corrupt or unreadable cache file is ignored rather than repaired: the
 * cache is an optimisation, never a source of truth.
 */
export class VerificationCache {
  private options: VerificationCacheOptions;
  private entries = new Map<string, CacheEntry>();
  private loaded = false;
  private hits = 0;
  private misses = 0;

  constructor(options: VerificationCacheOptions) {
    this.options = options;
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /** The cached result for a key, or null. Counts a hit/miss either way. */
  get(key: string, now: number = Date.now()): PipelineRunResult | null {
    if (!this.options.enabled) return null;
    this.load();

    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (this.expired(entry, now)) {
      this.entries.delete(key);
      this.misses += 1;
      return null;
    }

    this.hits += 1;
    // Never hand out the same object twice: callers mutate run results
    // (e.g. flipping `cached`), and a shared reference would leak that.
    return { ...entry.result, steps: entry.result.steps.map((step) => ({ ...step })), cached: true };
  }

  /** Store a *passing* run only. Failures are never reused. */
  set(key: string, result: PipelineRunResult, now: number = Date.now()): void {
    if (!this.options.enabled || !result.passed) return;
    this.load();

    this.entries.set(key, { at: now, result: { ...result, cached: false } });
    this.evict(now);
    this.persist();
  }

  /** Remove every entry (test/manual reset). */
  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    if (!this.options.persist) return;
    try {
      fs.rmSync(this.file(), { force: true });
    } catch {
      /* ignore */
    }
  }

  /** Cache counters, folded into the persisted metrics by the caller. */
  stats(): { hits: number; misses: number; entries: number } {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size };
  }

  /** @internal Reset counters without touching entries. */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  /** @internal Number of stored entries. */
  size(): number {
    this.load();
    return this.entries.size;
  }

  /** Re-point the cache at new settings (the config can change mid-session). */
  updateOptions(options: VerificationCacheOptions): void {
    this.options = options;
  }

  private expired(entry: CacheEntry, now: number): boolean {
    if (this.options.ttlMs <= 0) return false;
    return now - entry.at > this.options.ttlMs;
  }

  private file(): string {
    return path.join(projectDir(this.options.cwd), "verify-cache.json");
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.options.persist) return;

    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf-8")) as CacheFile;
      if (!raw || raw.version !== CACHE_VERSION || !raw.entries) return;
      const now = Date.now();
      for (const [key, entry] of Object.entries(raw.entries)) {
        if (!entry || typeof entry.at !== "number" || !entry.result?.passed) continue;
        if (this.expired(entry, now)) continue;
        this.entries.set(key, entry);
      }
    } catch {
      /* absent or corrupt — start clean */
    }
  }

  private evict(now: number): void {
    for (const [key, entry] of [...this.entries]) {
      if (this.expired(entry, now)) this.entries.delete(key);
    }
    const limit = this.options.maxEntries;
    if (limit <= 0) return;
    while (this.entries.size > limit) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) break;
      this.entries.delete(oldest[0]);
    }
  }

  private persist(): void {
    if (!this.options.persist) return;
    const file = this.file();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const payload: CacheFile = {
        version: CACHE_VERSION,
        entries: Object.fromEntries(this.entries),
      };
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* the cache is best-effort by definition */
    }
  }
}

// ── Shared instance ───────────────────────────────────────────────────────

let sharedCache: VerificationCache | null = null;
let sharedCwd: string | null = null;

/**
 * The process-wide cache for a project. Reads the persisted file once per
 * project instead of once per verification run.
 */
export function getVerificationCache(
  cwd: string,
  options: Omit<VerificationCacheOptions, "cwd">,
): VerificationCache {
  const resolved = path.resolve(cwd);
  if (!sharedCache || sharedCwd !== resolved) {
    sharedCache = new VerificationCache({ ...options, cwd: resolved });
    sharedCwd = resolved;
    return sharedCache;
  }
  sharedCache.updateOptions({ ...options, cwd: resolved });
  return sharedCache;
}

/** The shared instance, when one exists (read-only status reporting). */
export function peekVerificationCache(): VerificationCache | null {
  return sharedCache;
}

/** @internal Drop the shared instance — for testing only */
export function _resetCacheForTesting(): void {
  sharedCache = null;
  sharedCwd = null;
}
