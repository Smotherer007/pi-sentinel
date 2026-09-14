/**
 * Doctor report — the facts a user (or the agent) needs to answer one question:
 * *is sentinel actually working, right now, in this project?*
 *
 * The mechanisms are all indirect: a hook that blocks, a pipeline that runs,
 * a checkpoint that is written, a ctx that may already be dead. Everything a
 * report could say is already in the runtime — it was just spread across a
 * status tool, a state file and three log sections, and assembling it was the
 * work. That is the gap this closes: the same facts, classified.
 *
 * Two checks in here exist because their absence cost real time:
 *
 *   - **the session's ctx.** A retired ctx makes every branch that would report
 *     or resolve a result return early. Sentinel then runs checks whose verdicts
 *     nobody can receive, and a red trace stays "the newest" in the
 *     conversation while green runs go by underneath it. That looked like a
 *     stale-message bug for an hour; it is one line here.
 *   - **an outstanding failure next to the last green run.** If the newest red
 *     is older than the newest green, the failure is answered and only the
 *     conversation still shows it. If it is newer, the loop is genuinely open —
 *     and the attempt counter says how close it is to giving up.
 *
 * Pure: facts in, report out. Every I/O that produced them happened in the
 * caller, which is what lets the classification be tested without a session.
 */

/** How much a check matters. `fail` is something that is broken now. */
export type DoctorLevel = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly level: DoctorLevel;
  readonly label: string;
  /** Optional second line for the detail that makes the label actionable. */
  readonly detail?: string;
}

/** One configured pipeline step, reduced to what a doctor can judge. */
export interface DoctorStep {
  readonly name: string;
  readonly timeoutMs: number;
  /** Number of `files` patterns; 0 means it runs for every mutation. */
  readonly files: number;
  readonly cacheable: boolean;
}

/** Everything a report is built from. Plain data, gathered by the caller. */
export interface DoctorFacts {
  readonly cwd: string;
  readonly scopeKey: string;
  readonly nodeVersion: string;

  /** Session facts only the extension instance itself knows. */
  readonly session: {
    readonly startedAtMs: number;
    /** True once pi replaced the session this instance was loaded for. */
    readonly ctxRetired: boolean;
    readonly backgroundRunning: boolean;
    readonly backgroundPending: boolean;
    readonly failureOutstanding: boolean;
    readonly repairAttempts: number;
    readonly maxAttempts: number;
    /** Files captured for the current turn, i.e. what a rollback could undo. */
    readonly turnSnapshotFiles: number;
  };

  readonly config: {
    readonly enabled: boolean;
    readonly recoveryEnabled: boolean;
    readonly autoRollback: boolean;
    readonly revertOnRegression: boolean;
    readonly bashEnabled: boolean;
    readonly bashMode: string;
    readonly protectedPaths: number;
    /** Whether undeclared writers are learned from observation. */
    readonly learnMutationTools: boolean;
    /** Tool names learned so far — sentinel's own decision, shown not hidden. */
    readonly learnedTools: readonly string[];
    readonly onFileMutation: readonly DoctorStep[];
    readonly onTurnEnd: readonly DoctorStep[];
    /** Programs a step names that could not be found on PATH. */
    readonly missingCommands: readonly string[];
  };

  readonly storage: {
    readonly stateDir: string;
    readonly writable: boolean;
    readonly checkpointCount: number;
    readonly verifiedCount: number;
    readonly cacheEntries: number | null;
  };

  readonly git: {
    readonly available: boolean;
    readonly branch?: string;
    readonly head?: string;
  };

  readonly graph: {
    readonly present: boolean;
    readonly stale: boolean;
    readonly builtAt?: string;
    readonly ageDays?: number;
    readonly nodes: number;
    readonly edges: number;
  };

  /** Newest runs from the persisted history, as ISO strings. */
  readonly runs: {
    readonly lastRedAt?: string;
    readonly lastRedStep?: string;
    readonly lastGreenAt?: string;
  };
}

/** The report, split the way a reader triages it. */
export interface DoctorReport {
  readonly sentinel: readonly DoctorCheck[];
  readonly warnings: readonly DoctorCheck[];
  readonly safety: readonly DoctorCheck[];
  /** At least one `fail` — something is broken now, not merely imperfect. */
  readonly failed: boolean;
}

/** Node floor from `engines.node`, kept next to the check that enforces it. */
export const MIN_NODE = { major: 22, minor: 18 } as const;

/** A step that may hide a hang: past this, a timeout is indistinguishable from slow work. */
export const SLOW_TIMEOUT_MS = 120_000;

function nodeSupported(version: string): boolean {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major)) return false;
  if (major !== MIN_NODE.major) return major > MIN_NODE.major;
  return (minor ?? 0) >= MIN_NODE.minor;
}

function ageOf(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, Math.floor((now - at) / 86_400_000));
}

function ok(label: string, detail?: string): DoctorCheck {
  return detail ? { level: "ok", label, detail } : { level: "ok", label };
}

function warn(label: string, detail?: string): DoctorCheck {
  return detail ? { level: "warn", label, detail } : { level: "warn", label };
}

function fail(label: string, detail?: string): DoctorCheck {
  return detail ? { level: "fail", label, detail } : { level: "fail", label };
}

/** Classify the gathered facts. Pure: same facts, same report. */
export function buildDoctorReport(facts: DoctorFacts, now = Date.now()): DoctorReport {
  const sentinel: DoctorCheck[] = [];
  const warnings: DoctorCheck[] = [];
  const safety: DoctorCheck[] = [];
  const { session, config, storage, git, graph } = facts;

  // ── Is sentinel working, and can it speak? ─────────────────────────────
  sentinel.push(
    ok(
      "hooks registered",
      `this report came from them · session up ${Math.max(0, Math.round((now - session.startedAtMs) / 60_000))} min`,
    ),
  );
  sentinel.push(ok("project root detected", `${facts.cwd} (scope ${facts.scopeKey})`));

  // The check that would have saved an hour. A retired ctx cannot deliver or
  // resolve anything — including the failure it is holding.
  sentinel.push(
    session.ctxRetired
      ? fail(
          "session ctx: RETIRED",
          "pi replaced this session; results can no longer be reported or resolved. Reload to get a live instance.",
        )
      : ok("session ctx: live"),
  );

  if (!config.enabled) {
    sentinel.push(fail("sentinel disabled", "`enabled: false` in sentinel.config.ts"));
  }

  sentinel.push(
    config.recoveryEnabled
      ? ok("recovery enabled", `max ${session.maxAttempts} attempt(s) per cycle`)
      : warn("recovery disabled", "failures are reported but never re-prompted"),
  );

  sentinel.push(
    config.bashEnabled && config.bashMode !== "off"
      ? ok(`shell guard active (${config.bashMode})`)
      : warn("shell guard off", "destructive commands run without a pre-state capture"),
  );

  sentinel.push(
    git.available
      ? ok("git available", `${git.branch ?? "?"} @ ${git.head ?? "?"}`)
      : warn("git unavailable", "no head reset, and out-of-band detection has no baseline"),
  );

  sentinel.push(
    nodeSupported(facts.nodeVersion)
      ? ok(`node ${facts.nodeVersion} supported`)
      : fail(`node ${facts.nodeVersion} too old`, `needs >= ${MIN_NODE.major}.${MIN_NODE.minor}`),
  );

  sentinel.push(
    storage.writable
      ? ok("state directory writable", storage.stateDir)
      : fail("state directory not writable", `${storage.stateDir} — history and evidence are lost`),
  );

  const steps = [...config.onFileMutation, ...config.onTurnEnd];
  sentinel.push(
    steps.length === 0
      ? warn("no pipeline steps configured", "nothing is verified after a change or at turn end")
      : ok(
          `${steps.length} pipeline step(s) configured`,
          `${config.onFileMutation.length} on mutation · ${config.onTurnEnd.length} at turn end`,
        ),
  );

  if (config.missingCommands.length > 0) {
    const missing = config.missingCommands;
    sentinel.push(
      fail(
        `${missing.length} pipeline command(s) not on PATH`,
        `${missing.join(", ")} — the step can only fail, and never for a reason code caused`,
      ),
    );
  }

  // ── An open failure, and whether anything can still answer it ──────────
  const redAt = facts.runs.lastRedAt;
  const greenAt = facts.runs.lastGreenAt;
  if (session.failureOutstanding) {
    const redAge = ageOf(redAt, now);
    const greenNewer = Boolean(redAt && greenAt && Date.parse(greenAt) > Date.parse(redAt));
    sentinel.push(
      greenNewer
        ? warn(
            "stale failure trace still in the conversation",
            `newest red ${redAt} (${facts.runs.lastRedStep ?? "?"}) is older than the newest green run ${greenAt} — ` +
              "the code is fine, only the transcript still shows the failure",
          )
        : warn(
            "failure outstanding",
            `${facts.runs.lastRedStep ?? "?"} at ${redAt ?? "?"}` +
              (redAge !== undefined ? ` (${redAge} day(s) ago)` : "") +
              ` · repair ${session.repairAttempts}/${session.maxAttempts}`,
          ),
    );
  } else if (redAt && greenAt && Date.parse(greenAt) > Date.parse(redAt)) {
    sentinel.push(ok("newest failure answered", `red ${redAt} → green ${greenAt}`));
  }

  // ── Warnings: imperfect, not broken ───────────────────────────────────
  if (session.backgroundRunning) {
    warnings.push(
      warn(
        "background check in flight",
        session.backgroundPending
          ? "one more turn is folded into the next run"
          : "the next turn-end check will wait for it",
      ),
    );
  }

  if (!graph.present) {
    warnings.push(warn("no code graph", "impact and blast-radius lines will be missing"));
  } else if (graph.stale) {
    const age = ageOf(graph.builtAt, now) ?? facts.graph.ageDays;
    // "is stale" rather than "is 0 day(s) old": after an edit the graph is
    // always stale and always minutes old, and the second rendering reads like a
    // contradiction instead of an instruction.
    warnings.push(
      warn(
        age !== undefined && age >= 1 ? `code graph is ${age} day(s) old` : "code graph is stale",
        `built ${graph.builtAt ?? "unknown"} · ${graph.nodes} nodes / ${graph.edges} edges — ` +
          "rebuild with mindplace for a truthful impact section",
      ),
    );
  }

  for (const step of config.onFileMutation) {
    if (step.files === 0) {
      warnings.push(
        warn(
          `step "${step.name}" has no files filter`,
          "it runs after every edit, including ones it cannot judge",
        ),
      );
    }
  }
  for (const step of steps) {
    if (step.timeoutMs > SLOW_TIMEOUT_MS) {
      warnings.push(
        warn(
          `step "${step.name}" timeout exceeds ${SLOW_TIMEOUT_MS / 1000}s`,
          "a hang then looks exactly like slow work",
        ),
      );
    }
  }
  if (config.onTurnEnd.length > 0 && config.onTurnEnd.every((step) => step.cacheable)) {
    warnings.push(
      warn(
        "every turn-end step is cacheable",
        "a slow, non-deterministic suite served from cache proves less than it claims",
      ),
    );
  }
  if (storage.cacheEntries === 0) {
    warnings.push(warn("verification cache is empty", "no run has been reused yet"));
  }

  // ── Safety: what a bad turn would cost ────────────────────────────────
  safety.push(
    ok(
      `protected paths: ${config.protectedPaths}`,
      config.protectedPaths === 0 ? "none configured — policy is off or empty" : undefined,
    ),
  );
  safety.push(
    config.learnedTools.length > 0
      ? ok(
          `learned writers: ${config.learnedTools.length}`,
          `${config.learnedTools.join(", ")} — snapshotted before they run; a protected path only refuses through the policy`,
        )
      : config.learnMutationTools
        ? ok("learned writers: none yet", "undeclared writers are learned from observation")
        : ok("tool learning off", "only declared names and their shapes are treated as writers"),
  );
  if (session.turnSnapshotFiles > 0) {
    safety.push(ok(`rollback READY (${session.turnSnapshotFiles} file(s) captured this turn)`));
  } else if (config.autoRollback) {
    safety.push(warn("rollback armed, nothing captured yet", "no mutation has happened this turn"));
  } else {
    safety.push(
      warn(
        config.revertOnRegression ? "rollback manual only" : "rollback off",
        "autoRollback is false: a red turn keeps its changes and reports instead",
      ),
    );
  }
  safety.push(
    ok(
      `checkpoints: ${storage.checkpointCount}`,
      storage.checkpointCount === 0 ? "none yet — a rewind has nothing to go back to" : undefined,
    ),
  );
  safety.push(ok(`verified files: ${storage.verifiedCount}`));
  safety.push(
    ok(
      `repair budget: ${session.repairAttempts}/${session.maxAttempts}`,
      session.failureOutstanding ? "a cycle is open" : "no open cycle",
    ),
  );

  return {
    sentinel,
    warnings,
    safety,
    failed: [...sentinel, ...warnings, ...safety].some((check) => check.level === "fail"),
  };
}

/** Marker per level, so the report reads the same everywhere sentinel prints. */
const MARK: Record<DoctorLevel, string> = { ok: "✓", warn: "⚠", fail: "✗" };

function renderSection(title: string, checks: readonly DoctorCheck[]): string[] {
  if (checks.length === 0) return [`${title}`, "──────────────", "  (nothing to report)"];
  const lines = [title, "──────────────"];
  for (const check of checks) {
    lines.push(`  ${MARK[check.level]} ${check.label}`);
    if (check.detail) lines.push(`      ${check.detail}`);
  }
  return lines;
}

/**
 * Render the report as text.
 *
 * Deliberately plain and fixed-width: it is read in a widget, in a tool result
 * and in a paste into an issue, and it must survive all three.
 */
export function formatDoctorReport(report: DoctorReport, facts: DoctorFacts): string {
  const head = report.failed
    ? "[sentinel] doctor — something is broken"
    : "[sentinel] doctor — armed and consistent";
  return [
    head,
    "",
    ...renderSection("Sentinel", report.sentinel),
    "",
    ...renderSection("Warnings", report.warnings),
    "",
    ...renderSection("Safety", report.safety),
    "",
    `node ${facts.nodeVersion} · ${facts.cwd}`,
  ].join("\n");
}
