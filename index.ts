/**
 * pi-sentinel — a verification harness for the pi coding agent.
 *
 * One job: what the agent claims about the code must be true when it stops.
 *
 *   edit/write    capture the file's pre-state; run the fast checks and attach
 *                 a red result to the tool result as a hint
 *   agent_end     the agent says it is done: save a checkpoint of the run, run
 *                 the gate checks, and send the agent back when they are red
 *                 (bounded by an attempt budget and by "the repair changed nothing")
 *   context       once a later gate run is green, older failure messages
 *                 collapse to one line so the model stops acting on them
 *   /sentinel     status, checks, verify, rewind
 *
 * Structure and orientation are pi-mindplace's job; sentinel only reads its
 * graph to name dependents in a failure.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as os from "node:os";
import * as path from "node:path";

import { CheckpointStore, RunRecorder } from "./src/checkpoints.ts";
import { ConfigLoader, resolveChecks, stateDir } from "./src/config.ts";
import type { LoadedConfig, ResolvedChecks } from "./src/config.ts";
import { contractText } from "./src/contract.ts";
import { capOutput, editFeedback, repairPrompt, stopNotice } from "./src/format/feedback.ts";
import { failureHeadline, failureSignature, summarizeFailure } from "./src/format/classify.ts";
import { insideProject, matchesAny, relativeTo } from "./src/glob.ts";
import { dependentsOf, hasGraph } from "./src/mindplace.ts";
import { beforeGate, initialRepairState, onRed } from "./src/repair.ts";
import type { RepairState } from "./src/repair.ts";
import { isInfrastructureFailure, ranAnything, runChecks } from "./src/runner.ts";
import { repoRoot } from "./src/workspace.ts";
import { Coalescer } from "./src/coalesce.ts";
import type { CheckRun, SentinelConfig, StepResult } from "./src/types.ts";

export { defineConfig, DEFAULT_CONFIG } from "./src/config.ts";
export type { SentinelConfig, Step } from "./src/types.ts";

/** `customType` of the messages sentinel puts into the conversation. */
export const SENTINEL_MESSAGE_TYPE = "sentinel";

export const SUPERSEDED_NOTICE = "[sentinel] Superseded: a later check run passed. Ignore this earlier failure.";

interface VerifyDetails {
  passed: boolean;
  step?: string;
}

const WRITE_TOOLS = new Set(["edit", "write"]);

function toolPath(input: unknown, cwd: string): string | null {
  const raw = (input as { path?: unknown; file_path?: unknown } | undefined)?.path ?? (input as { file_path?: unknown })?.file_path;
  if (typeof raw !== "string" || raw.length === 0) return null;
  let p = raw.startsWith("@") ? raw.slice(1) : raw;
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd, p);
}

function lastStopReason(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; stopReason?: string };
    if (message?.role === "assistant") return message.stopReason;
  }
  return undefined;
}

export default function sentinel(pi: ExtensionAPI) {
  const loader = new ConfigLoader();
  let loaded: LoadedConfig | null = null;
  let checks: ResolvedChecks | null = null;
  let recorder: RunRecorder | null = null;
  let label = "agent run";
  let repair: RepairState = initialRepairState();
  /** Files changed since the last user prompt, across repair rounds. */
  const cycleChanged = new Set<string>();
  /** When the gate last passed; failure messages older than this are superseded. */
  let lastGreenAt = 0;
  let lastRun: { at: string; run: CheckRun } | null = null;
  const toldAboutInfra = new Set<string>();
  /** Parallel edits in one assistant message share one check run. */
  const editChecks = new Coalescer<CheckRun>();
  const reported = new WeakSet<CheckRun>();
  let lastHint: string | null = null;

  async function refresh(cwd: string): Promise<SentinelConfig> {
    loaded = await loader.load(cwd);
    checks = resolveChecks(loaded.config, cwd);
    return loaded.config;
  }

  function config(): SentinelConfig {
    return loaded!.config;
  }

  function store(cwd: string): CheckpointStore {
    return new CheckpointStore(path.join(stateDir(cwd), "checkpoints"), config().checkpoints.retention);
  }

  function relevant(cwd: string, file: string): boolean {
    return insideProject(cwd, file) && !matchesAny(config().exclude, relativeTo(cwd, file));
  }

  function ensureRecorder(cwd: string): RunRecorder {
    recorder ??= new RunRecorder(cwd, label, repoRoot(cwd) !== null);
    return recorder;
  }

  function send(content: string, details: Record<string, unknown>, options: { wake: boolean }) {
    pi.sendMessage(
      { customType: SENTINEL_MESSAGE_TYPE, content, display: true, details: { ...details, at: Date.now() } },
      options.wake ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn" },
    );
  }

  function infraNotice(ctx: ExtensionContext, result: StepResult): void {
    if (toldAboutInfra.has(result.name)) return;
    toldAboutInfra.add(result.name);
    ctx.ui.notify(
      `Sentinel: "${result.name}" could not run (${failureHeadline(result.kind!)}): ${summarizeFailure(result.kind!, result.output)} — fix the command or set checks in sentinel.config.ts.`,
      "warning",
    );
  }

  function setStatus(ctx: ExtensionContext, text: string | undefined): void {
    try {
      ctx.ui.setStatus("sentinel", text);
    } catch {
      /* status is cosmetic */
    }
  }

  // ── session ─────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const conf = await refresh(ctx.cwd);
    repair = initialRepairState();
    cycleChanged.clear();
    recorder = null;
    for (const problem of loaded!.problems) ctx.ui.notify(`Sentinel config: ${problem}`, "warning");
    if (!conf.enabled) return;
    const gate = checks!.beforeDone.map((s) => s.name);
    setStatus(ctx, gate.length > 0 ? `sentinel: ${gate.join(" · ")}` : "sentinel: no checks");
  });

  // ── a user prompt starts a new cycle ────────────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    const conf = await refresh(ctx.cwd);
    repair = initialRepairState();
    cycleChanged.clear();
    toldAboutInfra.clear();
    lastHint = null;
    label = (event.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "agent run";
    recorder = conf.enabled ? new RunRecorder(ctx.cwd, label, repoRoot(ctx.cwd) !== null) : null;
    if (!conf.enabled || !conf.contract) return;
    const contract = contractText({
      beforeDone: checks!.beforeDone,
      maxAttempts: conf.repair.maxAttempts,
      repair: conf.repair.enabled,
      graph: conf.mindplace && hasGraph(ctx.cwd),
    });
    return { systemPrompt: `${event.systemPrompt}\n\n${contract}` };
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!loaded) await refresh(ctx.cwd);
    if (config().enabled) ensureRecorder(ctx.cwd);
  });

  // ── edits ───────────────────────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (!loaded || !config().enabled || !WRITE_TOOLS.has(event.toolName)) return;
    const file = toolPath(event.input, ctx.cwd);
    if (!file || !relevant(ctx.cwd, file)) return;
    ensureRecorder(ctx.cwd).captureBefore(file);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!loaded || !config().enabled || !WRITE_TOOLS.has(event.toolName) || event.isError) return;
    const file = toolPath(event.input, ctx.cwd);
    if (!file || !relevant(ctx.cwd, file)) return;
    const steps = checks!.afterEdit;
    if (steps.length === 0) return;

    const run = await editChecks.run(file, (files) => runChecks(steps, { cwd: ctx.cwd, changed: files, signal: ctx.signal }));
    if (run.passed || !run.failure) {
      lastHint = null;
      return;
    }
    // One hint per distinct failure: parallel edits share a run, and a failure
    // that has not changed since the last hint would only repeat itself.
    const signature = `${run.failure.name}:${failureSignature(run.failure.kind ?? "unknown", run.failure.output)}`;
    if (reported.has(run) || signature === lastHint) return;
    reported.add(run);
    lastHint = signature;
    if (isInfrastructureFailure(run.failure)) {
      infraNotice(ctx, run.failure);
      return;
    }
    const text = capOutput(
      editFeedback({ cwd: ctx.cwd, result: run.failure, focus: [file], maxTraceLines: config().maxTraceLines }),
      config().maxOutputTokens,
      path.join(stateDir(ctx.cwd), "spills"),
      run.failure.name,
    );
    return { content: [...(event.content ?? []), { type: "text" as const, text }] };
  });

  // ── the gate ────────────────────────────────────────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    if (!loaded || !config().enabled) return;
    const conf = config();
    const run = recorder ?? ensureRecorder(ctx.cwd);
    recorder = null;

    const changed = run.changedFiles().filter((file) => relevant(ctx.cwd, file));
    if (conf.checkpoints.enabled && changed.length > 0) {
      try {
        run.save(store(ctx.cwd), changed);
      } catch {
        /* a lost checkpoint must not break the turn */
      }
    }
    for (const file of changed) cycleChanged.add(file);

    const stop = lastStopReason(event.messages);
    if (stop === "aborted" || stop === "error") return; // the user interrupted, or the provider failed

    const decision = beforeGate(repair, changed.length);
    if (decision.action === "skip") return;
    if (decision.action === "stop") {
      repair = initialRepairState();
      ctx.ui.notify("Sentinel: the repair round changed no code — stopped. The last failure is still open.", "warning");
      const open = lastRun?.run.failure;
      if (open) send(stopNotice({ cwd: ctx.cwd, result: open, reason: "no-progress" }), { kind: "stopped", step: open.name }, { wake: false });
      return;
    }

    const steps = checks!.beforeDone;
    if (steps.length === 0) return;
    setStatus(ctx, "sentinel: checking…");
    const result = await runChecks(steps, { cwd: ctx.cwd, changed: [...cycleChanged], signal: ctx.signal });
    if (ctx.signal?.aborted) return; // interrupted while checking: no verdict
    lastRun = { at: new Date().toISOString(), run: result };

    for (const warning of result.warnings) {
      ctx.ui.notify(`Sentinel: "${warning.name}" reported problems (warning only).`, "warning");
    }

    if (result.passed || !result.failure) {
      if (ranAnything(result)) lastGreenAt = Date.now();
      if (repair.attempts > 0) ctx.ui.notify(`Sentinel: checks pass after ${repair.attempts} repair round(s).`, "info");
      repair = initialRepairState();
      setStatus(ctx, `sentinel: ✓ ${result.steps.filter((s) => !s.skipped).map((s) => s.name).join(" · ")}`);
      return;
    }

    const failure = result.failure;
    setStatus(ctx, `sentinel: ✗ ${failure.name}`);
    if (isInfrastructureFailure(failure)) {
      infraNotice(ctx, failure);
      return;
    }

    const spills = path.join(stateDir(ctx.cwd), "spills");
    const next = onRed(repair, conf.repair);
    repair = next.next;
    if (next.action === "repair") {
      // The repair round is a new run with its own checkpoint and change set.
      recorder = new RunRecorder(ctx.cwd, `repair ${next.attempt}: ${failure.name}`, repoRoot(ctx.cwd) !== null);
      const text = repairPrompt({
        cwd: ctx.cwd,
        result: failure,
        changed: [...cycleChanged],
        attempt: next.attempt,
        maxAttempts: conf.repair.maxAttempts,
        maxTraceLines: conf.maxTraceLines,
        dependents: conf.mindplace ? dependentsOf(ctx.cwd, [...cycleChanged]) : [],
      });
      ctx.ui.notify(`Sentinel: "${failure.name}" failed — sending the agent back (${next.attempt}/${conf.repair.maxAttempts}).`, "warning");
      send(capOutput(text, conf.maxOutputTokens, spills, failure.name), { kind: "repair", step: failure.name, attempt: next.attempt }, { wake: true });
      return;
    }

    ctx.ui.notify(
      `Sentinel: "${failure.name}" is still failing and ${next.reason === "exhausted" ? "the repair budget is used up" : "repair is off"}. ${summarizeFailure(failure.kind ?? "unknown", failure.output)}`,
      "error",
    );
    send(stopNotice({ cwd: ctx.cwd, result: failure, reason: next.reason }), { kind: "stopped", step: failure.name }, { wake: false });
  });

  // ── context hygiene ─────────────────────────────────────────────────────

  pi.on("context", async (event) => {
    if (lastGreenAt === 0) return;
    let changed = false;
    const messages = event.messages.map((message) => {
      const m = message as unknown as { role?: string; customType?: string; details?: { at?: number; kind?: string }; content?: unknown };
      if (m.role !== "custom" || m.customType !== SENTINEL_MESSAGE_TYPE) return message;
      if (m.content === SUPERSEDED_NOTICE || (m.details?.at ?? Infinity) >= lastGreenAt) return message;
      changed = true;
      return { ...message, content: SUPERSEDED_NOTICE } as typeof message;
    });
    return changed ? { messages } : undefined;
  });

  // ── tools ───────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "sentinel_verify",
    label: "Verify",
    description:
      "Run the project's checks now (the same ones sentinel runs when you finish) and get a pruned result. Use it before claiming that something passes.",
    parameters: Type.Object({
      step: Type.Optional(Type.String({ description: "Run only the step with this name." })),
    }),
    async execute(_id: string, params: { step?: string }, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
      await refresh(ctx.cwd);
      const all = checks!.beforeDone;
      const steps = params.step ? all.filter((s) => s.name === params.step) : all;
      if (steps.length === 0) {
        const names = all.map((s) => s.name).join(", ") || "none";
        return { content: [{ type: "text" as const, text: `[sentinel] No matching check. Configured: ${names}.` }], details: { passed: false } as VerifyDetails };
      }
      const result = await runChecks(steps, { cwd: ctx.cwd, signal });
      lastRun = { at: new Date().toISOString(), run: result };
      if (result.passed) {
        lastGreenAt = Date.now();
        const ran = result.steps.map((s) => `${s.name} (${(s.durationMs / 1000).toFixed(1)}s)`).join(", ");
        const warn = result.warnings.length > 0 ? `\nWarnings: ${result.warnings.map((w) => w.name).join(", ")}` : "";
        return { content: [{ type: "text" as const, text: `[sentinel] Passed: ${ran}.${warn}` }], details: { passed: true } as VerifyDetails };
      }
      const failure = result.failure!;
      const text = repairPrompt({
        cwd: ctx.cwd,
        result: failure,
        changed: [...cycleChanged],
        attempt: 0,
        maxAttempts: 0,
        maxTraceLines: config().maxTraceLines,
        dependents: config().mindplace ? dependentsOf(ctx.cwd, [...cycleChanged]) : [],
      })
        .replace(/^\[sentinel\] Not done yet: /, "[sentinel] ")
        .replace(/ Repair attempt 0\/0\./, "")
        .replace(/ When you finish, sentinel runs the checks again\..*$/s, "");
      return {
        content: [{ type: "text" as const, text: capOutput(text, config().maxOutputTokens, path.join(stateDir(ctx.cwd), "spills"), failure.name) }],
        details: { passed: false, step: failure.name } as VerifyDetails,
      };
    },
  });

  pi.registerTool({
    name: "sentinel_rewind",
    label: "Rewind",
    description:
      "List sentinel's checkpoints (one per agent run) or restore the files of one to their state before that run. Files changed after the checkpoint are left alone.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("restore")], { description: "list or restore" }),
      id: Type.Optional(Type.String({ description: "Checkpoint id or number from list. Default: newest." })),
    }),
    async execute(_id: string, params: { action: "list" | "restore"; id?: string }, _signal: unknown, _update: unknown, ctx: ExtensionContext) {
      await refresh(ctx.cwd);
      const text = params.action === "list" ? describeCheckpoints(ctx.cwd) : describeRestore(ctx.cwd, params.id);
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  function describeCheckpoints(cwd: string): string {
    const list = store(cwd).list(15);
    if (list.length === 0) return "[sentinel] No checkpoints yet.";
    return [
      "[sentinel] Checkpoints (newest first):",
      ...list.map((c) => `  ${c.id}  ${c.at.replace("T", " ").slice(0, 19)}  ${c.label} — ${c.files.length} file(s): ${c.files.slice(0, 4).map((f) => relativeTo(cwd, f)).join(", ")}`),
    ].join("\n");
  }

  function describeRestore(cwd: string, id?: string, force = false): string {
    const report = store(cwd).restore(id, { force });
    if (!report.found) return `[sentinel] No checkpoint${id ? ` "${id}"` : ""} found.`;
    const rel = (files: string[]) => files.map((f) => relativeTo(cwd, f)).join(", ");
    const lines = [`[sentinel] Rewound checkpoint ${report.id}.`];
    if (report.restored.length) lines.push(`Restored: ${rel(report.restored)}`);
    if (report.deleted.length) lines.push(`Deleted (did not exist before): ${rel(report.deleted)}`);
    if (report.conflicts.length) lines.push(`Left alone (changed after the checkpoint): ${rel(report.conflicts)}`);
    if (report.unrecoverable.length) lines.push(`Could not restore (no saved pre-state): ${rel(report.unrecoverable)}`);
    return lines.join("\n");
  }

  // ── command ─────────────────────────────────────────────────────────────

  pi.registerCommand("sentinel", {
    description: "pi-sentinel: status | checks | verify | rewind [id] [--force]",
    getArgumentCompletions: (prefix: string) =>
      ["status", "checks", "verify", "rewind"].filter((o) => o.startsWith(prefix)).map((o) => ({ label: o, value: o })),
    handler: async (args: string | undefined, ctx) => {
      const conf = await refresh(ctx.cwd);
      const [sub = "status", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const show = (lines: string[]) => ctx.ui.setWidget("sentinel", lines);

      if (sub === "checks" || sub === "status") {
        const fmt = (s: { name: string; cmd: string; warnOnly?: boolean; files?: string[] }) =>
          `  ${s.name}: ${s.cmd}${s.warnOnly ? " (warning only)" : ""}${s.files ? `  [${s.files.join(" ")}]` : ""}`;
        const lines = [
          `[sentinel] ${conf.enabled ? "on" : "off"} — config: ${loaded!.source ? path.basename(loaded!.source) : "defaults"}${checks!.detected ? " (checks detected)" : ""}`,
          "after edit:",
          ...(checks!.afterEdit.length ? checks!.afterEdit.map(fmt) : ["  —"]),
          "before done:",
          ...(checks!.beforeDone.length ? checks!.beforeDone.map(fmt) : ["  — (nothing verifies the agent's work; add checks in sentinel.config.ts)"]),
          `repair: ${conf.repair.enabled ? `up to ${conf.repair.maxAttempts} rounds` : "off"} · checkpoints: ${conf.checkpoints.enabled ? "on" : "off"} · mindplace graph: ${hasGraph(ctx.cwd) ? "found" : "none"}`,
        ];
        if (sub === "checks") lines.push(...checks!.reasons.map((r) => `  detected ${r}`));
        if (lastRun) {
          const s = lastRun.run.failure ? `✗ ${lastRun.run.failure.name}` : "✓ passed";
          lines.push(`last run: ${s} at ${lastRun.at.replace("T", " ").slice(0, 19)}`);
        }
        for (const problem of loaded!.problems) lines.push(`config problem: ${problem}`);
        show(lines);
        return;
      }

      if (sub === "verify") {
        const result = await runChecks(checks!.beforeDone, { cwd: ctx.cwd, signal: ctx.signal });
        lastRun = { at: new Date().toISOString(), run: result };
        if (result.passed) lastGreenAt = Date.now();
        show(
          result.failure
            ? [`[sentinel] ✗ ${result.failure.name} (exit ${result.failure.exitCode})`, ...result.failure.output.split("\n").slice(-30)]
            : [`[sentinel] ✓ ${result.steps.map((s) => s.name).join(", ") || "no checks configured"}`],
        );
        return;
      }

      if (sub === "rewind") {
        const force = rest.includes("--force");
        const id = rest.find((r) => r !== "--force");
        if (!id && !force && ctx.hasUI) {
          const list = store(ctx.cwd).list(15);
          if (list.length === 0) return show(["[sentinel] No checkpoints yet."]);
          const choice = await ctx.ui.select(
            "Rewind files to before which run?",
            list.map((c) => `${c.id} · ${c.at.replace("T", " ").slice(11, 19)} · ${c.label} (${c.files.length} files)`),
          );
          if (!choice) return;
          return show(describeRestore(ctx.cwd, choice.split(" ")[0]).split("\n"));
        }
        return show(describeRestore(ctx.cwd, id, force).split("\n"));
      }

      show([`[sentinel] Unknown subcommand "${sub}". Use: status | checks | verify | rewind [id] [--force]`]);
    },
  });
}
