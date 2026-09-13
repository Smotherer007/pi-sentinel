/**
 * Configuration persistence and state for pi-sentinel.
 *
 * Loads `sentinel.config.ts`/`.js` from the project cwd, falling back to
 * `~/.sentinel.config.ts` in the home directory, then finally to defaults.
 *
 * Also persists runtime state (rollback history, last verification runs) to
 * `~/.pi/sentinel-state/<project>.json` in an atomic, permission-safe manner.
 * State is scoped per project so histories of unrelated repos don't mix.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import type {
  PipelineStep,
  PolicyConfig,
  RecoveryConfig,
  SentinelConfig,
  SentinelMetrics,
  StepPriority,
} from "./types.ts";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type SentinelConfigInput = DeepPartial<SentinelConfig>;

// ── Defaults ──────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: SentinelConfig = {
  // Every feature is ON by default: the guard is meant to feel like Codex /
  // Claude Code out of the box, not like a switchboard to assemble first.
  // The one irreversible behaviour is autoRollback — see the README section
  // "Rollback model" for what it restores and how to turn it off.
  enabled: true,
  autoRollback: true,

  // P0 — feedback is the product: re-prompt the agent on a red turn.
  autoFix: true,
  maxAutoRetries: 3,

  // Bounded recovery: the same loop as autoFix/maxAutoRetries, but explicit.
  // `rollbackAfterExhaustion` is off by default so an upgrade never restores
  // more than it did before; turn it on to return to the pre-cycle state once
  // the attempt budget is spent.
  recovery: {
    enabled: true,
    maxAttempts: 3,
    rollbackAfterExhaustion: false,
  },

  // Diff/change policy — opt-in. Existing projects are never blocked until
  // they explicitly enable a rule.
  policy: {
    enabled: false,
    maxChangedFiles: 0,
    maxAddedLines: 0,
    allowPackageChanges: true,
    allowLockfileChanges: true,
    allowWorkflowChanges: true,
    sensitivePaths: [],
    rollbackOnViolation: false,
  },

  // P1 — keep enough checkpoints to undo a working session, not the repo.
  checkpointRetention: 50,

  // P2 — hashes of green states, regression revert, stale-trace hygiene.
  trackVerifiedState: true,
  revertOnRegression: true,
  pruneStaleTraces: true,

  // P3 — bash/formatter/git changes are otherwise invisible to the hooks.
  detectOutOfBand: true,

  // P4 — bounded repair rules in the system prompt.
  revisionContract: true,

  // P5 — checks run in the background and re-wake the agent on failure.
  // Set false to get a deterministic turn ending at the cost of latency.
  backgroundTurnEnd: true,
  maxOutputTokens: 2500,

  // Mindplace synergy — impact analysis when a graph is present.
  impactAwareFocus: true,

  maxTraceLines: 12,

  // ── P6: performance, cache & escalation ────────────────────────────────
  // Deliberately conservative defaults: these change *observable behaviour*
  // (batching, reusing results, refusing to repeat a failure), so a project
  // that upgrades to this version keeps the exact 2.0.0 semantics until it
  // opts in. The safety limits below (`maxOutputBytes`, `killGraceMs`) are
  // not toggles — they only bound damage and are on unconditionally.
  verification: {
    // 0 = verify every mutation immediately (pre-3.0 behaviour).
    debounceMs: 0,
    maxOutputBytes: 256 * 1024,
    killGraceMs: 500,
    cache: {
      enabled: false,
      ttlMs: 300_000,
      maxEntries: 50,
      persist: true,
    },
    failureEscalation: {
      enabled: false,
      maxRepeatedFailures: 3,
    },
  },
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
  /**
   * P0 audit trail: every auto-fix decision, including the ones where the
   * guard stopped the loop. Mirrors Codex's continuation-prompt receipts.
   */
  autoFixHistory: Array<{
    at: string;
    step: string;
    attempt: number;
    /** injected = the agent was re-prompted; stopped = guard gave up. */
    outcome: "injected" | "stopped" | "exhausted";
    reason: string;
  }>;
  /** P2 audit trail: files detected as regressed from a verified state. */
  regressions: Array<{
    at: string;
    path: string;
    verifiedAt: string;
    reverted: boolean;
  }>;
  /** P6: performance counters, surfaced by `/sentinel status`. */
  metrics: SentinelMetrics;
  /** P6: one entry per turn that ran a verification (compact history). */
  turnHistory: Array<{
    at: string;
    turnIndex: number;
    passed: boolean;
    /** Failing step, when the turn was red. */
    step?: string;
  }>;
  /** P6 audit trail: failures repeated often enough to escalate. */
  escalations: Array<{
    at: string;
    step: string;
    kind: string;
    count: number;
    signature: string;
  }>;
  /** Change-policy audit trail: what rule fired and on which files. */
  policyViolations: Array<{
    at: string;
    rules: string[];
    files: string[];
  }>;
}

/** All-zero metrics, so state files written by older versions still load. */
export function emptyMetrics(): SentinelMetrics {
  return {
    checks: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    skippedSteps: 0,
    retries: 0,
    escalations: 0,
    cacheHits: 0,
    cacheMisses: 0,
    totalDurationMs: 0,
    rollbacks: 0,
    partialRollbacks: 0,
    policyViolations: 0,
  };
}

function emptyState(): SentinelState {
  return {
    rollbackHistory: [],
    lastVerifications: [],
    autoFixHistory: [],
    regressions: [],
    metrics: emptyMetrics(),
    turnHistory: [],
    escalations: [],
    policyViolations: [],
  };
}

let state: SentinelState = emptyState();
let activeConfig: SentinelConfig = DEFAULT_CONFIG;
let stateScope: string | null = null;

// ── Path resolution ───────────────────────────────────────────────────────

export function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "~";
}

/** Stable, filesystem-safe key for a project directory. */
export function scopeKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 10);
  const base = path.basename(resolved).replace(/[^a-zA-Z0-9._-]/g, "_") || "root";
  return `${base}-${hash}`;
}

/**
 * Per-project directory for everything sentinel persists: state, checkpoints,
 * verified states and spilled output. Derived from the cwd rather than from
 * `stateScope`, so helpers can be called before `loadConfig()` ran.
 */
export function projectDir(cwd: string): string {
  return path.join(homeDir(), ".pi", "sentinel-state", scopeKey(cwd));
}

function statePath(): string {
  return path.join(homeDir(), ".pi", "sentinel-state", `${stateScope ?? "global"}.json`);
}

/**
 * Point the state store at a project. Reloads persisted state when the
 * scope actually changes, so switching sessions never shows stale history.
 */
export function setStateScope(cwd: string): void {
  const key = scopeKey(cwd);
  if (key === stateScope) return;
  stateScope = key;
  loadState();
}

// ── Config loading ────────────────────────────────────────────────────────

/**
 * Type helper for authoring `sentinel.config.ts`.
 */
export function defineConfig(config: SentinelConfigInput): SentinelConfig {
  return normaliseConfig(deepMerge(DEFAULT_CONFIG, config), config);
}

/**
 * Reconcile the canonical `recovery` block with the legacy `autoFix` /
 * `maxAutoRetries` keys.
 *
 * The two spellings must never disagree. An explicit `recovery.maxAttempts`
 * wins; otherwise a configured `maxAutoRetries` is adopted, so a project that
 * upgrades from 2.x keeps its exact attempt budget. The legacy fields are then
 * written back so `revisionContract` and the status output stay truthful.
 */
function normaliseConfig(
  merged: SentinelConfig,
  raw: SentinelConfigInput | undefined,
): SentinelConfig {
  const rawRecovery = (raw?.recovery ?? {}) as Partial<RecoveryConfig>;
  const legacyMax = (raw as { maxAutoRetries?: number } | undefined)?.maxAutoRetries;
  const legacyEnabled = (raw as { autoFix?: boolean } | undefined)?.autoFix;

  const maxAttempts = rawRecovery.maxAttempts ?? legacyMax ?? merged.recovery.maxAttempts;
  const enabled = rawRecovery.enabled ?? legacyEnabled ?? merged.recovery.enabled;

  merged.recovery = {
    enabled,
    maxAttempts: Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 1,
    rollbackAfterExhaustion:
      rawRecovery.rollbackAfterExhaustion ?? merged.recovery.rollbackAfterExhaustion,
  };
  merged.autoFix = merged.recovery.enabled;
  merged.maxAutoRetries = merged.recovery.maxAttempts;
  return merged;
}

/** Settings a change policy needs, with safe defaults for out-of-date callers. */
export function policyOf(config: SentinelConfig): PolicyConfig {
  return config.policy ?? DEFAULT_CONFIG.policy;
}

/** Settings the recovery loop needs, with safe defaults for older callers. */
export function recoveryOf(config: SentinelConfig): RecoveryConfig {
  return config.recovery ?? {
    enabled: config.autoFix,
    maxAttempts: config.maxAutoRetries,
    rollbackAfterExhaustion: false,
  };
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
  setStateScope(cwd);

  const candidates = [
    path.join(cwd, "sentinel.config.ts"),
    path.join(cwd, "sentinel.config.js"),
    path.join(homeDir(), ".sentinel.config.ts"),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      // Cache-bust by *content*, not by mtime. Node's ESM loader caches by URL,
      // and mtime has inconsistent resolution across filesystems (coarse on
      // some CI containers and network mounts). Two edits inside one mtime tick
      // would then silently keep the old config — the hash cannot collide that
      // way, and an unchanged file is still served from the module cache.
      const stamp = createHash("sha1")
        .update(fs.readFileSync(file))
        .digest("hex")
        .slice(0, 16);
      const url = pathToFileURL(file);
      url.searchParams.set("v", stamp);
      const mod = await import(url.href);
      const raw = mod.default ?? mod.config;
      if (raw && typeof raw === "object") {
        activeConfig = normaliseConfig(deepMerge(DEFAULT_CONFIG, raw as Partial<SentinelConfig>), raw as SentinelConfigInput);
        // Report dangerous values early and by name. They are *not* silently
        // repaired: the user should see exactly what is wrong and fix it.
        for (const problem of configProblems(activeConfig)) {
          console.warn(`[sentinel] config: ${problem}`);
        }
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
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Persisting history is an audit convenience, never a reason to fail a
    // verification run or crash a hook. A full/read-only disk must not turn
    // "checks passed" into an exception the agent sees.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    console.warn("[sentinel] could not persist state:", err);
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
          autoFixHistory: Array.isArray(raw.autoFixHistory) ? raw.autoFixHistory : [],
          regressions: Array.isArray(raw.regressions) ? raw.regressions : [],
          // Merge onto zeros: a state file from an older version has no
          // counters at all, and a partial write must not yield NaN totals.
          metrics: { ...emptyMetrics(), ...(raw.metrics ?? {}) },
          turnHistory: Array.isArray(raw.turnHistory) ? raw.turnHistory : [],
          escalations: Array.isArray(raw.escalations) ? raw.escalations : [],
          policyViolations: Array.isArray(raw.policyViolations) ? raw.policyViolations : [],
        };
        return;
      }
    }
  } catch {
    /* fall through to a clean state */
  }
  state = emptyState();
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

/** Batch variant: persists once instead of once per step. */
export function recordVerifications(entries: SentinelState["lastVerifications"]): void {
  if (entries.length === 0) return;
  for (const entry of entries) state.lastVerifications.unshift(entry);
  if (state.lastVerifications.length > 20) state.lastVerifications.length = 20;
  persistState();
}

export function recordVerification(entry: SentinelState["lastVerifications"][number]): void {
  recordVerifications([entry]);
}

/** P0: log an auto-fix decision (injected / stopped / exhausted). */
export function recordAutoFix(entry: SentinelState["autoFixHistory"][number]): void {
  state.autoFixHistory.unshift(entry);
  if (state.autoFixHistory.length > 20) state.autoFixHistory.length = 20;
  persistState();
}

/** P2: log a regressed file (optionally one that was reverted). */
export function recordRegression(entry: SentinelState["regressions"][number]): void {
  state.regressions.unshift(entry);
  if (state.regressions.length > 20) state.regressions.length = 20;
  persistState();
}

/** P6: add a batch of counters (one call per verification run). */
export function recordMetrics(delta: Partial<SentinelMetrics>): void {
  for (const [key, value] of Object.entries(delta)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const current = state.metrics[key as keyof SentinelMetrics] ?? 0;
    state.metrics[key as keyof SentinelMetrics] = current + value;
  }
  persistState();
}

/** P6: log a failure that repeated often enough to escalate. */
export function recordEscalation(entry: SentinelState["escalations"][number]): void {
  state.escalations.unshift(entry);
  if (state.escalations.length > 20) state.escalations.length = 20;
  persistState();
}

/** Change policy: log a violation (rule ids + the files it concerned). */
export function recordPolicyViolation(entry: SentinelState["policyViolations"][number]): void {
  state.policyViolations.unshift(entry);
  if (state.policyViolations.length > 20) state.policyViolations.length = 20;
  persistState();
}

/** P6: record the outcome of a turn, for the compact history block. */
export function recordTurnOutcome(entry: SentinelState["turnHistory"][number]): void {
  const newest = state.turnHistory[0];
  // A turn can produce several runs (mutation + turn end). Keep the newest,
  // but never append a second line for the same turn index and outcome.
  if (newest && newest.turnIndex === entry.turnIndex && newest.passed === entry.passed) {
    state.turnHistory[0] = entry;
  } else {
    state.turnHistory.unshift(entry);
  }
  if (state.turnHistory.length > 20) state.turnHistory.length = 20;
  persistState();
}

// ── Glob matching ─────────────────────────────────────────────────────────

/** Convert a POSIX-style glob to an anchored regular expression. */
function globToRegExp(glob: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 2;
        if (glob[i] === "/") {
          // `**/` matches zero or more leading directories.
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        i += 1;
        out += "[^/]*";
      }
    } else if (c === "?") {
      i += 1;
      out += "[^/]";
    } else if ("\\^$+?.()|{}[]".includes(c)) {
      i += 1;
      out += `\\${c}`;
    } else {
      i += 1;
      out += c;
    }
  }
  return new RegExp(`${out}$`);
}

/**
 * Match a POSIX-style glob (`**`, `*`, `?`) against a normalised path.
 * Callers should pass a project-relative path for anchored patterns; the
 * absolute path is also compared so path-agnostic patterns still work.
 */
export function matchesGlob(pattern: string, filePath: string): boolean {
  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const f = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  try {
    return globToRegExp(p).test(f);
  } catch {
    return false;
  }
}

/** Turn an absolute path into a project-relative one when possible. */
function toRelative(filePath: string, cwd?: string): string {
  const normalised = filePath.replace(/\\/g, "/");
  if (cwd && path.isAbsolute(filePath)) {
    const rel = path.relative(cwd, filePath).replace(/\\/g, "/");
    if (rel && !rel.startsWith("..")) return rel;
  }
  return normalised.replace(/^\.\//, "");
}

export function isExcluded(filePath: string, config: SentinelConfig, cwd?: string): boolean {
  const rel = toRelative(filePath, cwd);
  return config.exclude.some((pattern) => matchesGlob(pattern, rel));
}

/**
 * Decide whether a mutated file should trigger verification.
 *
 * - `exclude` always wins.
 * - When `include` is empty, everything not excluded is verified.
 * - Otherwise the file must match at least one `include` pattern.
 */
export function shouldVerify(filePath: string, config: SentinelConfig, cwd?: string): boolean {
  const rel = toRelative(filePath, cwd);
  if (isExcluded(filePath, config, cwd)) return false;
  if (config.include.length === 0) return true;
  return config.include.some((pattern) => matchesGlob(pattern, rel));
}

/** Type guard for a configured pipeline step (used by tests/tools). */
export function isPipelineStep(value: unknown): value is PipelineStep {
  return isPlainObject(value) && typeof value.name === "string" && typeof value.cmd === "string";
}

/**
 * Effective priority of a step.
 *
 * `warnOnly` is the pre-3.0 spelling of `priority: "warning"` and keeps
 * working unchanged; an explicit priority wins so both styles can be mixed.
 */
export function priorityOf(step: PipelineStep): StepPriority {
  if (step.priority) return step.priority;
  return step.warnOnly ? "warning" : "normal";
}

/**
 * Whether a step belongs to the pipeline group that is running.
 * A step without a `phase` runs in both groups (the pre-3.0 behaviour).
 */
export function stepPhaseMatches(
  step: PipelineStep,
  trigger: "onFileMutation" | "onTurnEnd",
): boolean {
  if (!step.phase) return true;
  const wanted = trigger === "onFileMutation" ? "mutation" : "turn";
  return step.phase === wanted;
}

/**
 * Whether a step cares about the files that changed.
 *
 * - No `files` patterns: the step is always relevant (back-compatible).
 * - No changed files known: run the step — skipping a check because we could
 *   not see what changed would be a silent loss of verification.
 * - Otherwise at least one changed file must match one pattern.
 */
export function stepMatchesFiles(
  step: PipelineStep,
  changedFiles: string[],
  cwd?: string,
): boolean {
  if (!step.files || step.files.length === 0) return true;
  if (changedFiles.length === 0) return true;
  return changedFiles.some((file) => {
    const rel = toRelative(file, cwd);
    return step.files!.some((pattern) => matchesGlob(pattern, rel));
  });
}

/**
 * Human-readable problems with a loaded configuration.
 *
 * Deliberately non-mutating: a dangerous value is reported by name so the user
 * can fix it, never silently repaired into something else. The runner refuses
 * an invalid `timeoutMs` anyway, so this is the early, visible half of the same
 * guarantee.
 */
export function configProblems(config: SentinelConfig): string[] {
  const problems: string[] = [];
  const groups: Array<[string, PipelineStep[] | undefined]> = [
    ["pipelines.onFileMutation", config.pipelines?.onFileMutation],
    ["pipelines.onTurnEnd", config.pipelines?.onTurnEnd],
  ];
  for (const [group, steps] of groups) {
    for (const step of steps ?? []) {
      const name = step?.name ?? "(unnamed)";
      if (!step || typeof step.cmd !== "string" || step.cmd.trim() === "") {
        problems.push(`${group}: step "${name}" has an empty command`);
      }
      if (!Number.isFinite(step?.timeoutMs) || (step?.timeoutMs ?? 0) <= 0) {
        problems.push(
          `${group}: step "${name}" has an invalid timeoutMs (${String(step?.timeoutMs)}); it would time out immediately and is refused at run time`,
        );
      }
    }
  }
  const maxBytes = config.verification?.maxOutputBytes;
  if (!Number.isFinite(maxBytes) || (maxBytes ?? 0) < 2) {
    problems.push(
      `verification.maxOutputBytes (${String(maxBytes)}) is not a usable bound; the default is used instead`,
    );
  }
  if (!Number.isFinite(config.maxTraceLines) || config.maxTraceLines <= 0) {
    problems.push(
      `maxTraceLines (${String(config.maxTraceLines)}) keeps no error lines; failures will arrive without a trace`,
    );
  }
  if (!Number.isFinite(config.maxOutputTokens) || config.maxOutputTokens < 0) {
    problems.push(
      `maxOutputTokens (${String(config.maxOutputTokens)}) is not a usable budget`,
    );
  }
  if (Number.isFinite(config.checkpointRetention) && config.checkpointRetention <= 0) {
    problems.push(
      "checkpointRetention <= 0 disables pruning, so checkpoints grow without bound on disk",
    );
  }
  if (
    config.verification?.cache?.enabled &&
    Number.isFinite(config.verification.cache.maxEntries) &&
    config.verification.cache.maxEntries <= 0
  ) {
    problems.push("verification.cache.maxEntries <= 0 leaves the cache unbounded");
  }
  return problems;
}

/** @internal Reset internals — for testing only */
export function _resetForTesting(): void {
  state = emptyState();
  activeConfig = DEFAULT_CONFIG;
  stateScope = null;
}

/** @internal Override the active config — for testing only */
export function _setConfigForTesting(config: SentinelConfig): void {
  activeConfig = config;
}
