/**
 * End-to-end tests for the hook wiring in index.ts.
 *
 * The unit tests cover the clients; these drive the real extension factory
 * against a fake ExtensionAPI, so the behaviour that matters in practice is
 * actually exercised: P0 re-prompting and its stop conditions, P1 checkpoint
 * flushing, P2 evidence and trace pruning, P3 out-of-band detection,
 * P4 contract injection and P5 background checks with a bounded payload.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";

import extensionFactory, { SENTINEL_MESSAGE_TYPE, SENTINEL_NOTICE_TYPE } from "../index.ts";
import { projectDir, _resetForTesting, getConfig, getState } from "../src/config.ts";
import { checkpoints } from "../src/clients/checkpoints.ts";
import { verifiedEntry, allVerified } from "../src/clients/evidence.ts";
import { SentinelRewindTool } from "../src/tools/sentinel-rewind.ts";
import { SentinelStatusTool } from "../src/tools/sentinel-status.ts";
import { _clearCache } from "../src/clients/mindplace.ts";
import { changedPaths } from "../src/clients/workspace.ts";
import { _clearRepoRootCache } from "../src/clients/git-client.ts";

type Handler = (event: any, ctx: any) => any;

interface FakePi {
  api: any;
  handlers: Map<string, Handler[]>;
  tools: any[];
  commands: any[];
  sent: Array<{ message: any; options: any }>;
}

function createFakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const tools: any[] = [];
  const commands: any[] = [];
  const sent: Array<{ message: any; options: any }> = [];

  const api = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand(name: string, options: any) {
      commands.push({ name, ...options });
    },
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
  };

  return { api, handlers, tools, commands, sent };
}

interface FakeCtx {
  cwd: string;
  ui: any;
  sessionManager: any;
  hasUI: boolean;
  _notifications: Array<{ text: string; level: string }>;
  _statuses: Map<string, unknown>;
  _widgets: Map<string, unknown>;
}

function makeCtx(cwd: string): FakeCtx {
  const notifications: Array<{ text: string; level: string }> = [];
  const statuses = new Map<string, unknown>();
  const widgets = new Map<string, unknown>();

  return {
    cwd,
    hasUI: true,
    ui: {
      notify: (text: string, level = "info") => notifications.push({ text, level }),
      setStatus: (key: string, value?: string) => statuses.set(key, value),
      setWidget: (key: string, lines: string[]) => widgets.set(key, lines),
      select: async () => undefined,
    },
    sessionManager: { getLeafId: () => "entry-1", getSessionFile: () => undefined },
    _notifications: notifications,
    _statuses: statuses,
    _widgets: widgets,
  };
}

async function emit(fake: FakePi, name: string, event: any, ctx: FakeCtx): Promise<any> {
  let result: any;
  for (const handler of fake.handlers.get(name) ?? []) {
    const value = await handler(event, ctx);
    if (value !== undefined) result = value;
  }
  return result;
}

function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("condition never became true"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

let home: string;
let project: string;
let fake: FakePi;
let ctx: FakeCtx;

/** Write a project config that the loader picks up by content hash. */
function writeConfig(extra: Record<string, unknown> = {}): void {
  const file = path.join(project, "sentinel.config.js");
  fs.writeFileSync(file, `export default ${JSON.stringify(extra, null, 2)};\n`, "utf-8");
}

/**
 * A configuration with cheap, explicit pipelines.
 *
 * `backgroundTurnEnd` defaults to false in tests so a turn's outcome is known
 * when the hook resolves — the dedicated background test turns it back on.
 */
async function configure(extra: Record<string, unknown> = {}): Promise<void> {
  writeConfig({
    backgroundTurnEnd: false,
    pipelines: { onFileMutation: [], onTurnEnd: [] },
    ...extra,
  });
  await emit(fake, "session_start", { type: "session_start" }, ctx);
}

/** Simulate an edit/write mutation, including the pre-state capture hook. */
async function mutate(rel: string, content: string, callId = "call-1"): Promise<any> {
  await emit(
    fake,
    "tool_call",
    { type: "tool_call", toolName: "edit", toolCallId: callId, input: { path: rel } },
    ctx,
  );

  const abs = path.join(project, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);

  return emit(
    fake,
    "tool_result",
    {
      type: "tool_result",
      toolName: "edit",
      toolCallId: callId,
      input: { path: rel },
      content: [{ type: "text", text: "updated" }],
      isError: false,
    },
    ctx,
  );
}

/**
 * One full turn: start, mutate, end.
 *
 * `duringTurn` runs after `turn_start` (and after the optional mutation), so a
 * test can simulate a change that bypasses the hooks entirely — a formatter,
 * `sed -i`, a code generator the agent invoked through bash. Out-of-band
 * detection is about changes made *while the turn runs*; a file that was
 * already dirty beforehand belongs to whoever made it dirty.
 */
async function runTurn(
  turnIndex: number,
  rel: string | null,
  content: string,
  duringTurn?: () => void | Promise<void>,
): Promise<any> {
  await emit(fake, "turn_start", { type: "turn_start", turnIndex }, ctx);
  if (rel) await mutate(rel, content, `call-${turnIndex}`);
  if (duringTurn) await duringTurn();
  const result = await emit(
    fake,
    "turn_end",
    { type: "turn_end", turnIndex, message: {}, toolResults: [] },
    ctx,
  );
  return result;
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ext-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  project = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ext-"));
  // ESM resolution for the generated sentinel.config.js.
  fs.writeFileSync(path.join(project, "package.json"), '{"type":"module"}\n');
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

beforeEach(async () => {
  _clearCache();
  _resetForTesting();
  // The project directory is re-created (and re-`git init`ed) per test, so a
  // memoised repository root from a previous test would be a stale answer.
  _clearRepoRootCache();

  // Wipe the whole project except the module-type marker, so no test can leak
  // files (and therefore out-of-band detections) into the next one.
  for (const entry of fs.readdirSync(project)) {
    if (entry === "package.json") continue;
    fs.rmSync(path.join(project, entry), { recursive: true, force: true });
  }
  fs.rmSync(projectDir(project), { recursive: true, force: true });

  fake = createFakePi();
  extensionFactory(fake.api);
  ctx = makeCtx(project);
  checkpoints.clear(project);
});

describe("extension registration", () => {
  test("registers the tools, the command and every hook", () => {
    assert.deepEqual(
      fake.tools.map((t) => t.name).sort(),
      ["sentinel_rewind", "sentinel_rollback", "sentinel_status", "sentinel_verify"],
    );
    assert.equal(fake.commands.length, 1);
    assert.equal(fake.commands[0].name, "sentinel");

    for (const hook of [
      "session_start",
      "before_agent_start",
      "message_start",
      "turn_start",
      "tool_call",
      "tool_result",
      "turn_end",
      "session_compact",
      "context",
    ]) {
      assert.ok(fake.handlers.has(hook), `missing hook: ${hook}`);
    }
  });

  test("ships with every feature enabled when no config exists", async () => {
    await emit(fake, "session_start", { type: "session_start" }, ctx);
    const conf = getConfig();

    assert.equal(conf.enabled, true);
    assert.equal(conf.autoRollback, true);
    assert.equal(conf.autoFix, true);
    assert.equal(conf.trackVerifiedState, true);
    assert.equal(conf.revertOnRegression, true);
    assert.equal(conf.pruneStaleTraces, true);
    assert.equal(conf.detectOutOfBand, true);
    assert.equal(conf.revisionContract, true);
    assert.equal(conf.backgroundTurnEnd, true);
    assert.equal(conf.impactAwareFocus, true);
  });

  test("announces the armed features at session start", async () => {
    await configure();
    assert.ok(
      ctx._notifications.some((n) => n.text.includes("Sentinel armed")),
      "the user should know the guard is active",
    );
  });
});

describe("P4 — revision contract", () => {
  test("is appended to the system prompt", async () => {
    await configure();
    const result = await emit(
      fake,
      "before_agent_start",
      { type: "before_agent_start", prompt: "do work", systemPrompt: "BASE PROMPT" },
      ctx,
    );

    assert.ok(result.systemPrompt.startsWith("BASE PROMPT"));
    assert.ok(result.systemPrompt.includes("[sentinel:revision-contract]"));
    assert.ok(result.systemPrompt.includes("At most 3 repair attempts"));
  });

  test("can be switched off", async () => {
    await configure({ revisionContract: false });
    const result = await emit(
      fake,
      "before_agent_start",
      { type: "before_agent_start", prompt: "do work", systemPrompt: "BASE" },
      ctx,
    );
    assert.equal(result, undefined);
  });
});

describe("P0 — closing the loop", () => {
  test("re-prompts the agent when the turn ends red", async () => {
    await configure({
      autoRollback: false,
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "check", cmd: "exit 3", timeoutMs: 5000 }],
      },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");

    assert.equal(fake.sent.length, 1, "the agent is woken once");
    assert.equal(fake.sent[0].message.customType, SENTINEL_MESSAGE_TYPE);
    assert.equal(fake.sent[0].options.deliverAs, "followUp");
    assert.equal(fake.sent[0].options.triggerTurn, true);
    assert.ok(fake.sent[0].message.content.includes('step "check"'));
    assert.ok(fake.sent[0].message.content.includes("Repair attempt 1/3"));
  });

  test("never wakes the agent when the checks pass", async () => {
    await configure({ pipelines: { onFileMutation: [], onTurnEnd: [{ name: "ok", cmd: "exit 0", timeoutMs: 5000 }] } });
    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    assert.equal(fake.sent.length, 0);
  });

  test("stops when the code state did not change since the last attempt", async () => {
    await configure({
      autoRollback: false,
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "check", cmd: "exit 1", timeoutMs: 5000 }] },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    assert.equal(fake.sent.length, 1);

    // A second turn that changes nothing must not repeat the same prompt.
    await runTurn(2, null, "");
    assert.equal(fake.sent.length, 1, "an identical state is not re-prompted");
    assert.ok(
      ctx._notifications.some((n) => n.text.includes("did not change")),
      "the human is told why the loop stopped",
    );
  });

  test("gives up after maxAutoRetries when the state keeps changing", async () => {
    await configure({
      autoRollback: false,
      maxAutoRetries: 2,
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "check", cmd: "exit 1", timeoutMs: 5000 }] },
    });

    await runTurn(1, "src/a.ts", "revision 1\n");
    await runTurn(2, "src/a.ts", "revision 2\n");
    assert.equal(fake.sent.length, 2, "two attempts, then stop");

    await runTurn(3, "src/a.ts", "revision 3\n");
    assert.equal(fake.sent.length, 2, "the budget is exhausted, not reset");
    assert.ok(ctx._notifications.some((n) => n.text.includes("exhausted")));
  });

  test("a real user message resets the repair budget", async () => {
    await configure({
      autoRollback: false,
      maxAutoRetries: 1,
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "check", cmd: "exit 1", timeoutMs: 5000 }] },
    });

    await runTurn(1, "src/a.ts", "revision 1\n");
    assert.equal(fake.sent.length, 1);

    await emit(fake, "message_start", { type: "message_start", message: { role: "user" } }, ctx);
    await runTurn(2, "src/a.ts", "revision 2\n");
    assert.equal(fake.sent.length, 2, "a new prompt reopens the budget");
  });

  test("sentinel's own continuation does not reset the budget", async () => {
    await configure({
      autoRollback: false,
      maxAutoRetries: 1,
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "check", cmd: "exit 1", timeoutMs: 5000 }] },
    });

    await runTurn(1, "src/a.ts", "revision 1\n");
    // The auto-fix message arrives in the session as a custom message.
    await emit(
      fake,
      "message_start",
      {
        type: "message_start",
        message: { role: "custom", customType: SENTINEL_MESSAGE_TYPE, content: "x" },
      },
      ctx,
    );
    await runTurn(2, "src/a.ts", "revision 2\n");
    assert.equal(fake.sent.length, 1, "the loop stays bounded");
  });

  test("does not wake the agent for a warnOnly failure", async () => {
    await configure({
      autoRollback: false,
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "lint", cmd: "exit 1", timeoutMs: 5000, warnOnly: true }],
      },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    assert.equal(fake.sent.length, 0, "warnings never trigger a continuation");
    assert.ok(ctx._notifications.some((n) => n.text.includes("Sentinel warnings")));
  });
});

describe("recovery — bounded attempts", () => {
  test("rollbackAfterExhaustion restores the state before the failing cycle", async () => {
    await configure({
      autoRollback: false,
      recovery: { enabled: true, maxAttempts: 1, rollbackAfterExhaustion: true },
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "check", cmd: "exit 1", timeoutMs: 5000 }] },
    });

    const file = path.join(project, "src/a.ts");
    await runTurn(1, "src/a.ts", "revision 1\n");
    assert.equal(fake.sent.length, 1, "the first attempt is re-prompted");
    assert.ok(fs.existsSync(file));

    await runTurn(2, "src/a.ts", "revision 2\n");
    assert.equal(fake.sent.length, 1, "the attempt budget is spent");
    assert.ok(ctx._notifications.some((n) => n.text.includes("recovery exhausted")));
    assert.equal(
      fs.existsSync(file),
      false,
      "the state before the whole failing cycle is restored, not just the last edit",
    );
  });

  test("the legacy maxAutoRetries still bounds the loop", async () => {
    await configure({
      autoRollback: false,
      maxAutoRetries: 1,
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "check", cmd: "exit 1", timeoutMs: 5000 }] },
    });

    await runTurn(1, "src/a.ts", "revision 1\n");
    await runTurn(2, "src/a.ts", "revision 2\n");

    assert.equal(fake.sent.length, 1, "one attempt, then stop");
    assert.ok(ctx._notifications.some((n) => n.text.includes("recovery attempts exhausted")));
  });

  test("a green turn resets the recovery counter", async () => {
    await configure({
      autoRollback: false,
      // Off: a regression revert would rewrite src/a.ts back to the verified
      // state and make the next red turn look like "state unchanged".
      revertOnRegression: false,
      maxAutoRetries: 1,
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [
          {
            name: "toggle",
            cmd: "node -e \"const fs=require('fs');const s=fs.existsSync('state.txt')?fs.readFileSync('state.txt','utf8'):'';process.exit(s==='green'?0:1)\"",
            timeoutMs: 10000,
          },
        ],
      },
    });

    await runTurn(1, "src/a.ts", "revision 1\n");
    assert.equal(fake.sent.length, 1, "the red turn is re-prompted");

    // A green turn must clear the budget...
    fs.writeFileSync(path.join(project, "state.txt"), "green");
    await runTurn(2, "src/a.ts", "revision 2\n");
    assert.equal(fake.sent.length, 1, "a green turn does not re-prompt");

    // ...so the next red cycle gets its own attempt again.
    fs.writeFileSync(path.join(project, "state.txt"), "red");
    await runTurn(3, "src/a.ts", "revision 3\n");
    assert.equal(fake.sent.length, 2, "the reset budget allows a new attempt");

    await runTurn(4, "src/a.ts", "revision 4\n");
    assert.equal(fake.sent.length, 2, "the new budget is bounded again");
    assert.ok(
      ctx._notifications.some((n) => n.text.includes("recovery attempts exhausted")),
      "notifications: " + JSON.stringify(ctx._notifications.map((n) => n.text)),
    );
  });
});

describe("P7 — change policy", () => {
  test("a disallowed workflow stops the turn and tells the agent what to revert", async () => {
    await configure({
      autoRollback: false,
      policy: { enabled: true, allowWorkflowChanges: false, blockBeforeWrite: false },
      pipelines: { onFileMutation: [], onTurnEnd: [] },
    });

    const before = {
      violations: getState().policyViolations.length,
      metric: getState().metrics.policyViolations,
    };
    await runTurn(1, ".github/workflows/ci.yml", "name: ci\n");

    assert.equal(fake.sent.length, 1, "the agent is asked to revert it");
    const body = fake.sent[0].message.content as string;
    assert.ok(body.includes("Change policy violation"));
    assert.ok(body.includes(".github/workflows/ci.yml"));
    assert.ok(ctx._notifications.some((n) => n.text.includes("Change policy violation")));
    assert.equal(getState().policyViolations.length, before.violations + 1);
    assert.equal(getState().metrics.policyViolations, before.metric + 1);
    assert.deepEqual(getState().policyViolations[0].rules, ["allowWorkflowChanges"]);
  });

  test("stops the turn before verification runs", async () => {
    await configure({
      autoRollback: false,
      policy: { enabled: true, allowWorkflowChanges: false, blockBeforeWrite: false },
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [
          { name: "marker", cmd: "node -e \"require('fs').writeFileSync('ran.marker','x')\"", timeoutMs: 5000 },
        ],
      },
    });

    await runTurn(1, ".github/workflows/ci.yml", "name: ci\n");

    assert.equal(
      fs.existsSync(path.join(project, "ran.marker")),
      false,
      "a policy stop short-circuits the pipeline",
    );
  });

  test("rollbackOnViolation restores the offending file", async () => {
    await configure({
      autoRollback: false,
      policy: { enabled: true, allowWorkflowChanges: false, rollbackOnViolation: true, blockBeforeWrite: false },
      pipelines: { onFileMutation: [], onTurnEnd: [] },
    });

    await runTurn(1, ".github/workflows/ci.yml", "name: ci\n");

    assert.equal(fs.existsSync(path.join(project, ".github/workflows/ci.yml")), false);
    const body = fake.sent[0].message.content as string;
    assert.ok(body.includes("restored to their pre-turn state"));
  });

  test("an ordinary turn within the limits is not stopped", async () => {
    await configure({
      autoRollback: false,
      policy: { enabled: true, maxChangedFiles: 10, maxAddedLines: 100 },
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "ok", cmd: "exit 0", timeoutMs: 5000 }] },
    });

    const before = getState().policyViolations.length;
    await runTurn(1, "src/a.ts", "export const a = 1;\n");

    assert.equal(fake.sent.length, 0);
    assert.equal(getState().policyViolations.length, before, "no violation is recorded");
  });

  test("a violation in one turn does not leak into the next", async () => {
    await configure({
      autoRollback: false,
      policy: { enabled: true, allowWorkflowChanges: false, blockBeforeWrite: false },
      pipelines: { onFileMutation: [], onTurnEnd: [] },
    });

    const before = getState().policyViolations.length;
    await runTurn(1, ".github/workflows/ci.yml", "name: ci\n");
    assert.equal(getState().policyViolations.length, before + 1);

    // Turn 2 touches only an ordinary file: it must be clean and must not
    // inherit or re-report turn 1's violation.
    await runTurn(2, "src/a.ts", "export const a = 1;\n");
    assert.equal(getState().policyViolations.length, before + 1, "no violation is carried over");
    assert.equal(fake.sent.length, 1, "only the violating turn produced a follow-up");
  });

  test("a protected path is refused before the write happens", async () => {
    await configure({
      autoRollback: false,
      policy: { enabled: true, allowWorkflowChanges: false, blockBeforeWrite: true },
      pipelines: { onFileMutation: [], onTurnEnd: [] },
    });

    const before = getState().metrics.blockedWrites;

    await emit(fake, "turn_start", { type: "turn_start", turnIndex: 1 }, ctx);
    const decision = await emit(
      fake,
      "tool_call",
      {
        type: "tool_call",
        toolName: "write",
        toolCallId: "call-1",
        input: { path: ".github/workflows/ci.yml" },
      },
      ctx,
    );

    assert.equal(decision?.block, true, "the tool call is refused");
    assert.ok(String(decision.reason).includes(".github/workflows/ci.yml"));
    assert.ok(
      String(decision.reason).includes("nothing changed on disk"),
      "the agent is told there is nothing to undo",
    );
    assert.equal(
      fs.existsSync(path.join(project, ".github/workflows/ci.yml")),
      false,
      "the cheapest rollback is the write that never happened",
    );
    assert.equal(getState().metrics.blockedWrites, before + 1);
    assert.ok(ctx._notifications.some((n) => n.text.includes("refused a write")));
  });

  test("an ordinary path is not refused", async () => {
    await configure({
      autoRollback: false,
      policy: { enabled: true, allowWorkflowChanges: false, blockBeforeWrite: true },
      pipelines: { onFileMutation: [], onTurnEnd: [] },
    });

    await emit(fake, "turn_start", { type: "turn_start", turnIndex: 1 }, ctx);
    const decision = await emit(
      fake,
      "tool_call",
      { type: "tool_call", toolName: "edit", toolCallId: "call-1", input: { path: "src/a.ts" } },
      ctx,
    );

    assert.equal(decision?.block, undefined);
  });

  test("an out-of-band violation is reported once, not re-sent in a loop", async () => {
    await configure({
      autoRollback: false,
      policy: { enabled: true, allowWorkflowChanges: false, blockBeforeWrite: false },
      include: ["**/*.yml"],
      pipelines: { onFileMutation: [], onTurnEnd: [] },
    });

    execSync("git init -q", { cwd: project });
    execSync("git add -A", { cwd: project });

    const target = path.join(project, ".github/workflows/ci.yml");

    await runTurn(1, null, "", async () => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "name: ci\n");
      await waitFor(() => changedPaths(project).some((c) => c.path.endsWith("ci.yml")));
    });
    assert.equal(fake.sent.length, 1, "a bash-only change is still caught");

    // Turn 2 changes nothing: the file is still dirty, but it was dirty when
    // the turn began, so it is not this turn's doing and is not re-reported.
    await runTurn(2, null, "");
    assert.equal(fake.sent.length, 1, "an untouched violation is not re-sent");
  });

  test("re-creating a rolled-back violation is reported once, not in a loop", async () => {
    await configure({
      autoRollback: false,
      policy: { enabled: true, allowWorkflowChanges: false, rollbackOnViolation: true, blockBeforeWrite: false },
      pipelines: { onFileMutation: [], onTurnEnd: [] },
    });

    // Turn 1 writes the forbidden file; the policy restores it away again.
    await runTurn(1, ".github/workflows/ci.yml", "name: ci\n");
    assert.equal(fake.sent.length, 1);
    assert.equal(fs.existsSync(path.join(project, ".github/workflows/ci.yml")), false);

    // Turn 2 re-creates exactly the same file: the same violation about the
    // same content. That is the loop the signature guard exists for.
    await runTurn(2, ".github/workflows/ci.yml", "name: ci\n");
    assert.equal(fake.sent.length, 1, "an identical violation is not re-sent");
    assert.ok(ctx._notifications.some((n) => n.text.includes("same policy violation repeated")));
  });
});

describe("mutation feedback", () => {
  test("a failing mutation pipeline returns an isError result with the trace", async () => {
    await configure({
      autoRollback: false,
      pipelines: {
        onFileMutation: [{ name: "type-check", cmd: "exit 2", timeoutMs: 5000 }],
        onTurnEnd: [],
      },
    });

    const result = await mutate("src/a.ts", "export const a = 1;\n");
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('step "type-check"'));
    assert.ok(result.content[0].text.includes("still in place"));
    assert.equal(result.content[1].text, "updated", "the original result is preserved");
  });

  test("a passing mutation returns nothing to modify", async () => {
    await configure({
      pipelines: {
        onFileMutation: [{ name: "ok", cmd: "exit 0", timeoutMs: 5000 }],
        onTurnEnd: [],
      },
    });
    const result = await mutate("src/a.ts", "export const a = 1;\n");
    assert.equal(result, undefined);
  });

  test("skips the pipeline for files outside include", async () => {
    await configure({
      include: ["src/**/*.ts"],
      pipelines: {
        onFileMutation: [{ name: "type-check", cmd: "exit 2", timeoutMs: 5000 }],
        onTurnEnd: [],
      },
    });

    const result = await mutate("docs/readme.ts", "not included\n");
    assert.equal(result, undefined, "excluded files never fail a mutation");
  });

  test("skips the pipeline for a byte-identical rewrite", async () => {
    await configure({
      pipelines: {
        onFileMutation: [{ name: "type-check", cmd: "exit 2", timeoutMs: 5000 }],
        onTurnEnd: [],
      },
    });

    const abs = path.join(project, "src/same.ts");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "export const same = 1;\n");

    // Capture the pre-state, then "edit" the file to the same bytes.
    await emit(
      fake,
      "tool_call",
      { type: "tool_call", toolName: "edit", toolCallId: "same-1", input: { path: "src/same.ts" } },
      ctx,
    );
    const result = await emit(
      fake,
      "tool_result",
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "same-1",
        input: { path: "src/same.ts" },
        content: [{ type: "text", text: "no change" }],
        isError: false,
      },
      ctx,
    );

    assert.equal(result, undefined, "nothing changed, so nothing to verify");
  });
});

describe("P1 — checkpoints and rewind", () => {
  test("flushes a checkpoint for every turn that changed files", async () => {
    await configure({ pipelines: { onFileMutation: [], onTurnEnd: [] } });
    await runTurn(1, "src/a.ts", "revision\n");

    const list = checkpoints.list(project);
    assert.equal(list.length, 1);
    assert.equal(list[0].turnIndex, 1);
    assert.equal(list[0].fileCount, 1);
    assert.ok(list[0].label.includes("src/a.ts"), `unexpected label: ${list[0].label}`);
  });

  test("rewinds the working tree to before that turn", async () => {
    await configure({ pipelines: { onFileMutation: [], onTurnEnd: [] } });
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "src/a.ts"), "original\n");

    await runTurn(1, "src/a.ts", "rewritten\n");
    assert.equal(fs.readFileSync(path.join(project, "src/a.ts"), "utf-8"), "rewritten\n");

    const result = await SentinelRewindTool.execute(
      "rewind",
      { mode: "code" },
      undefined,
      undefined,
      { cwd: project },
    );

    assert.equal((result.details as any).rewound, true);
    assert.equal(fs.readFileSync(path.join(project, "src/a.ts"), "utf-8"), "original\n");
  });

  test("lists checkpoints without touching the tree", async () => {
    await configure({ pipelines: { onFileMutation: [], onTurnEnd: [] } });
    await runTurn(1, "src/a.ts", "revision\n");

    const result = await SentinelRewindTool.execute(
      "rewind",
      { mode: "list" },
      undefined,
      undefined,
      { cwd: project },
    );

    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(text.includes("Checkpoints (newest first)"));
    assert.equal(fs.readFileSync(path.join(project, "src/a.ts"), "utf-8"), "revision\n");
  });

  test("reports honestly when there is nothing to rewind", async () => {
    await configure({ pipelines: { onFileMutation: [], onTurnEnd: [] } });
    const result = await SentinelRewindTool.execute(
      "rewind",
      { mode: "code" },
      undefined,
      undefined,
      { cwd: project },
    );
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(text.includes("No checkpoint available"));
    assert.equal((result.details as any).rewound, false);
  });
});

describe("P2 — evidence and stale traces", () => {
  test("records a green state and reports a regression later", async () => {
    await configure({
      autoRollback: false,
      include: ["**/*.ts"],
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "tests", cmd: "exit 0", timeoutMs: 5000 }] },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    assert.ok(verifiedEntry(project, path.join(project, "src/a.ts")), "a green state is remembered");

    // Now break the file and make the same check fail.
    writeConfig({
      autoRollback: false,
      backgroundTurnEnd: false,
      include: ["**/*.ts"],
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "tests", cmd: "exit 1", timeoutMs: 5000 }] },
    });
    await emit(fake, "session_start", { type: "session_start" }, ctx);
    await runTurn(2, "src/a.ts", "export const a = 'broken';\n");

    const body = fake.sent[0]?.message.content ?? "";
    assert.ok(body.includes("Regressed from a verified state"), body);
    assert.ok(body.includes("src/a.ts"));
  });

  test("restores a regressed file when revertOnRegression is on", async () => {
    await configure({
      autoRollback: false,
      revertOnRegression: true,
      include: ["**/*.ts"],
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "tests", cmd: "exit 0", timeoutMs: 5000 }] },
    });
    await runTurn(1, "src/a.ts", "export const a = 1;\n");

    writeConfig({
      autoRollback: false,
      backgroundTurnEnd: false,
      revertOnRegression: true,
      include: ["**/*.ts"],
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "tests", cmd: "exit 1", timeoutMs: 5000 }] },
    });
    await emit(fake, "session_start", { type: "session_start" }, ctx);
    await runTurn(2, "src/a.ts", "export const a = 'broken';\n");

    assert.equal(
      fs.readFileSync(path.join(project, "src/a.ts"), "utf-8"),
      "export const a = 1;\n",
      "the verified state is restored",
    );
  });

  test("marks older sentinel traces superseded before the LLM call", async () => {
    await configure();
    const messages = [
      { role: "custom", customType: SENTINEL_MESSAGE_TYPE, content: "old trace", display: true },
      { role: "user", content: "please continue" },
      { role: "custom", customType: SENTINEL_MESSAGE_TYPE, content: "new trace", display: true },
    ];

    const result = await emit(fake, "context", { type: "context", messages }, ctx);
    assert.ok(result, "the hook must return modified messages");
    assert.ok(result.messages[0].content.includes("superseded"));
    assert.equal(result.messages[2].content, "new trace", "the newest trace stays live");
    assert.deepEqual(result.messages[1], messages[1], "other messages are untouched");
  });

  test("leaves the context alone with a single trace", async () => {
    await configure();
    const messages = [
      { role: "custom", customType: SENTINEL_MESSAGE_TYPE, content: "only trace", display: true },
    ];
    assert.equal(await emit(fake, "context", { type: "context", messages }, ctx), undefined);
  });

  test("respects pruneStaleTraces: false", async () => {
    await configure({ pruneStaleTraces: false });
    const messages = [
      { role: "custom", customType: SENTINEL_MESSAGE_TYPE, content: "old", display: true },
      { role: "custom", customType: SENTINEL_MESSAGE_TYPE, content: "new", display: true },
    ];
    assert.equal(await emit(fake, "context", { type: "context", messages }, ctx), undefined);
  });
});

describe("P3 — out-of-band changes", () => {
  test("verifies files that no edit/write hook ever saw", async () => {
    await configure({
      autoRollback: false,
      include: ["**/*.ts"],
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "check", cmd: "exit 0", timeoutMs: 5000 }] },
    });

    execSync("git init -q", { cwd: project });
    execSync("git add -A", { cwd: project });

    await runTurn(1, null, "", async () => {
      // A "bash" style change: written directly, no tool_call involved.
      fs.mkdirSync(path.join(project, "src"), { recursive: true });
      fs.writeFileSync(path.join(project, "src/generated.ts"), "export const g = 1;\n");

      // Precondition: `git status` is the only source for out-of-band changes
      // and can lag briefly under load. Wait until the scan sees the file, so a
      // slow git fails here with a clear message instead of at the assertion.
      await waitFor(() =>
        changedPaths(project).some((c) => c.path.endsWith("generated.ts")),
      );
    });

    assert.ok(
      ctx._notifications.some((n) => n.text.includes("changed outside edit/write")),
      "the user is told what the hooks could not see",
    );
  });

  test("work that was already dirty before the turn is not attributed to it", async () => {
    await configure({
      autoRollback: false,
      include: ["**/*.ts"],
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "check", cmd: "exit 0", timeoutMs: 5000 }] },
    });

    execSync("git init -q", { cwd: project });
    execSync("git add -A", { cwd: project });

    // The user's own work in flight, made before the agent did anything.
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "src/wip.ts"), "export const wip = 1;\n");
    await waitFor(() => changedPaths(project).some((c) => c.path.endsWith("wip.ts")));

    await runTurn(1, null, "");

    assert.equal(
      ctx._notifications.some((n) => n.text.includes("changed outside edit/write")),
      false,
      "the working tree is not the turn's diff",
    );
  });

  test("stays quiet when everything went through the hooks", async () => {
    await configure({
      include: ["**/*.ts"],
      pipelines: { onFileMutation: [], onTurnEnd: [] },
    });

    execSync("git init -q", { cwd: project });
    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    execSync("git add -A", { cwd: project });

    assert.equal(
      ctx._notifications.some((n) => n.text.includes("changed outside edit/write")),
      false,
    );
  });
});

describe("environment failures are not code failures", () => {
  test("a missing command never rolls back and never spends a repair attempt", async () => {
    await configure({
      autoRollback: true,
      recovery: { enabled: true, maxAttempts: 3 },
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [
          { name: "missing-tool", cmd: "sentinel-no-such-binary-xyz", timeoutMs: 5000 },
        ],
      },
    });

    // State is persisted per project and outlives a single test, so every
    // counter is compared as a delta.
    const before = getState().autoFixHistory.length;
    await runTurn(1, "src/a.ts", "export const a = 1;\n");

    assert.equal(
      fs.readFileSync(path.join(project, "src/a.ts"), "utf-8"),
      "export const a = 1;\n",
      "the agent's work survives a broken pipeline",
    );
    assert.equal(fake.sent.length, 0, "the agent is not sent back to edit code");
    assert.equal(
      getState().autoFixHistory.length,
      before,
      "no repair attempt is charged for an environment failure",
    );
    assert.ok(
      ctx._notifications.some((n) => n.text.includes("environment reason")),
      "the human is told why nothing happened",
    );
  });

  test("a timeout leaves the working tree alone", async () => {
    await configure({
      autoRollback: true,
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "slow", cmd: "node -e 'setTimeout(()=>{}, 5000)'", timeoutMs: 150 }],
      },
    });

    const before = getState().metrics.rollbacks;
    await runTurn(1, "src/a.ts", "export const a = 1;\n");

    assert.equal(fs.existsSync(path.join(project, "src/a.ts")), true);
    assert.equal(
      getState().metrics.rollbacks,
      before,
      "a slow check is not a reason to undo work",
    );
  });

  test("a real type error still rolls back", async () => {
    await configure({
      autoRollback: true,
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [
          {
            name: "type-check",
            cmd: "node -e 'console.error(\"src/a.ts(1,1): error TS2322: nope\"); process.exit(2)'",
            timeoutMs: 5000,
          },
        ],
      },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");

    assert.equal(
      fs.existsSync(path.join(project, "src/a.ts")),
      false,
      "a genuine code failure is still undone",
    );
  });
});

describe("green evidence reaches the agent", () => {
  test("the contract names the files that are verified right now", async () => {
    await configure({
      autoRollback: false,
      trackVerifiedState: true,
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "ok", cmd: "exit 0", timeoutMs: 5000 }] },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");

    const result = await emit(
      fake,
      "before_agent_start",
      { type: "before_agent_start", prompt: "next", systemPrompt: "BASE" },
      ctx,
    );

    assert.ok(
      result.systemPrompt.includes("Verified green right now"),
      "the rule about green code is backed by the list it refers to",
    );
    assert.ok(result.systemPrompt.includes("src/a.ts"));
  });

  test("a file that changed since it passed is no longer claimed as green", async () => {
    await configure({
      autoRollback: false,
      trackVerifiedState: true,
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "ok", cmd: "exit 0", timeoutMs: 5000 }] },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    fs.writeFileSync(path.join(project, "src/a.ts"), "export const a = 999;\n");

    const result = await emit(
      fake,
      "before_agent_start",
      { type: "before_agent_start", prompt: "next", systemPrompt: "BASE" },
      ctx,
    );

    assert.equal(
      result.systemPrompt.includes("src/a.ts"),
      false,
      "evidence is bound to content, not to a file name",
    );
  });

  test("nothing is claimed when the ledger is off", async () => {
    await configure({
      autoRollback: false,
      trackVerifiedState: false,
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "ok", cmd: "exit 0", timeoutMs: 5000 }] },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    const result = await emit(
      fake,
      "before_agent_start",
      { type: "before_agent_start", prompt: "next", systemPrompt: "BASE" },
      ctx,
    );

    assert.equal(result.systemPrompt.includes("Verified green right now"), false);
  });
});

describe("a trace stops being current when the code moves", () => {
  async function redTurnThenContext(mutate: () => void) {
    await configure({
      autoRollback: false,
      recovery: { enabled: true, maxAttempts: 3 },
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [
          {
            name: "type-check",
            cmd: "node -e 'console.error(\"error TS2322: nope\"); process.exit(2)'",
            timeoutMs: 5000,
          },
        ],
      },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    assert.equal(fake.sent.length, 1, "the red turn produced a trace");

    mutate();

    return emit(
      fake,
      "context",
      {
        type: "context",
        messages: [
          { role: "user", content: "go on" },
          {
            role: "custom",
            customType: SENTINEL_MESSAGE_TYPE,
            content: fake.sent[0].message.content,
            display: true,
          },
        ],
      },
      ctx,
    );
  }

  test("the live trace is marked stale once its files change", async () => {
    const result = await redTurnThenContext(() => {
      fs.writeFileSync(path.join(project, "src/a.ts"), "export const a = 2;\n");
    });

    assert.ok(result?.messages, "the context is rewritten");
    const body = String(result.messages[1].content);
    assert.ok(body.includes("STALE"), "the agent is told the result is out of date");
    assert.ok(body.includes("error TS2322"), "the diagnostics themselves are kept");
  });

  test("an unchanged tree leaves the live trace alone", async () => {
    const result = await redTurnThenContext(() => {});
    assert.equal(result, undefined, "nothing to rewrite");
  });
});

describe("repair cycles do not widen", () => {
  test("an attempt that reaches past the original failure is named", async () => {
    await configure({
      autoRollback: false,
      recovery: { enabled: true, maxAttempts: 5, scopeGuard: "report" },
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [
          {
            name: "type-check",
            cmd: "node -e 'console.error(\"error TS2322: nope\"); process.exit(2)'",
            timeoutMs: 5000,
          },
        ],
      },
    });

    // Turn 1 fails on a.ts: that is what the cycle is about.
    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    assert.equal(fake.sent.length, 1);
    assert.equal(
      (fake.sent[0].message.content as string).includes("REPAIR SCOPE EXCEEDED"),
      false,
      "the turn that opens a cycle cannot exceed it",
    );

    // Turn 2 edits a different file instead of fixing the cause.
    await runTurn(2, "src/unrelated.ts", "export const u = 1;\n");

    const body = fake.sent[1].message.content as string;
    assert.ok(body.includes("REPAIR SCOPE EXCEEDED"), "the widening is reported");
    assert.ok(body.includes("unrelated.ts"));
    assert.ok(
      ctx._notifications.some((n) => n.text.includes("outside the failure it started from")),
      "the human sees it too",
    );
  });

  test("scopeGuard: block refuses the widening edit outright", async () => {
    await configure({
      autoRollback: false,
      recovery: { enabled: true, maxAttempts: 5, scopeGuard: "block" },
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "type-check", cmd: "exit 2", timeoutMs: 5000 }],
      },
    });

    // Turn 1 opens the cycle on a.ts.
    await runTurn(1, "src/a.ts", "export const a = 1;\n");

    // Turn 2 tries to edit something else instead of fixing the cause.
    await emit(fake, "turn_start", { type: "turn_start", turnIndex: 2 }, ctx);
    const decision = await emit(
      fake,
      "tool_call",
      {
        type: "tool_call",
        toolName: "edit",
        toolCallId: "call-2",
        input: { path: "src/unrelated.ts" },
      },
      ctx,
    );

    assert.equal(decision?.block, true, "the edit never happens");
    assert.ok(String(decision.reason).includes("src/a.ts"), "the reason names the real scope");
    assert.equal(fs.existsSync(path.join(project, "src/unrelated.ts")), false);

    // The file the cycle is about stays editable.
    const allowed = await emit(
      fake,
      "tool_call",
      { type: "tool_call", toolName: "edit", toolCallId: "call-3", input: { path: "src/a.ts" } },
      ctx,
    );
    assert.equal(allowed?.block, undefined, "fixing the cause is exactly what is wanted");
  });

  test("scopeGuard: off keeps quiet", async () => {
    await configure({
      autoRollback: false,
      recovery: { enabled: true, maxAttempts: 5, scopeGuard: "off" },
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "type-check", cmd: "exit 2", timeoutMs: 5000 }],
      },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    await runTurn(2, "src/unrelated.ts", "export const u = 1;\n");

    const body = fake.sent[1].message.content as string;
    assert.equal(body.includes("REPAIR SCOPE EXCEEDED"), false);
  });

  test("a new user message opens a fresh cycle", async () => {
    await configure({
      autoRollback: false,
      recovery: { enabled: true, maxAttempts: 5, scopeGuard: "report" },
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "type-check", cmd: "exit 2", timeoutMs: 5000 }],
      },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    await emit(fake, "message_start", { type: "message_start", message: { role: "user" } }, ctx);
    await runTurn(2, "src/unrelated.ts", "export const u = 1;\n");

    const body = fake.sent[1].message.content as string;
    assert.equal(
      body.includes("REPAIR SCOPE EXCEEDED"),
      false,
      "the user asked for something else; that is not a widening repair",
    );
  });
});

describe("compaction does not launder stale evidence", () => {
  async function compact() {
    return emit(
      fake,
      "session_compact",
      { type: "session_compact", compactionEntry: {}, fromExtension: false, reason: "threshold", willRetry: false },
      ctx,
    );
  }

  test("the invariants are restated after the context is cut", async () => {
    await configure({
      autoRollback: false,
      trackVerifiedState: true,
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "ok", cmd: "exit 0", timeoutMs: 5000 }] },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    const sentBefore = fake.sent.length;

    await compact();

    assert.equal(fake.sent.length, sentBefore + 1, "a notice is sent");
    const notice = fake.sent[fake.sent.length - 1];
    assert.equal(notice.message.customType, SENTINEL_NOTICE_TYPE, "a notice is not a trace");
    assert.equal(notice.options.triggerTurn, false, "restating facts must not start a turn");

    const body = notice.message.content as string;
    assert.ok(body.includes("not evidence"), "a summarized check result is disowned");
    assert.ok(body.includes("[sentinel:revision-contract]"), "the contract is restated");
    assert.ok(body.includes("src/a.ts"), "the green files are restated as fact");
  });

  test("the repair budget survives a compaction", async () => {
    await configure({
      autoRollback: false,
      recovery: { enabled: true, maxAttempts: 2 },
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "type-check", cmd: "exit 2", timeoutMs: 5000 }],
      },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    await compact();

    const notice = fake.sent[fake.sent.length - 1].message.content as string;
    assert.ok(
      notice.includes("attempt 1 of 2"),
      "a loop cannot buy fresh attempts by compacting",
    );

    // The budget is spent, not restarted: the second red turn exhausts it.
    await runTurn(2, "src/a.ts", "export const a = 2;\n");
    await runTurn(3, "src/a.ts", "export const a = 3;\n");
    assert.ok(
      getState().autoFixHistory.some((entry) => entry.outcome === "exhausted"),
      "the bound still applies across the compaction",
    );
  });

  test("a compaction notice is never superseded as if it were a trace", async () => {
    await configure({ autoRollback: false, pipelines: { onFileMutation: [], onTurnEnd: [] } });

    const result = await emit(
      fake,
      "context",
      {
        type: "context",
        messages: [
          { role: "custom", customType: SENTINEL_NOTICE_TYPE, content: "standing notice" },
          { role: "custom", customType: SENTINEL_MESSAGE_TYPE, content: "old trace" },
          { role: "custom", customType: SENTINEL_MESSAGE_TYPE, content: "new trace" },
        ],
      },
      ctx,
    );

    assert.equal(result.messages[0].content, "standing notice", "the notice is left alone");
    assert.ok(String(result.messages[1].content).includes("superseded"));
    assert.equal(result.messages[2].content, "new trace");
  });
});

describe("P5 — output budget and background checks", () => {
  test("bounds the payload and spills the full output", async () => {
    await configure({
      autoRollback: false,
      maxOutputTokens: 60,
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [
          {
            name: "noisy",
            cmd: "node -e 'for (let i = 0; i < 4000; i++) console.error(\"error TS9999: boom \" + i); process.exit(1)'",
            timeoutMs: 20000,
          },
        ],
      },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");

    const body = fake.sent[0].message.content as string;
    assert.ok(body.length < 2_000, `payload must stay bounded, got ${body.length}`);
    assert.ok(body.includes("output truncated"), "truncation is announced");

    const spills = path.join(projectDir(project), "spills");
    assert.equal(fs.existsSync(spills), true, "the full output is written to disk");
    assert.ok(fs.readdirSync(spills).some((f) => f.endsWith(".log")));
  });

  test("runs turn-end checks without blocking the turn, then re-wakes", async () => {
    await configure({
      autoRollback: false,
      backgroundTurnEnd: true,
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "slow", cmd: "sleep 0.4; exit 1", timeoutMs: 20000 }],
      },
    });

    const started = Date.now();
    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 350, `turn_end must not wait for the checks (took ${elapsed}ms)`);

    await waitFor(() => fake.sent.length > 0);
    assert.ok(fake.sent[0].message.content.includes('step "slow"'));
    await waitFor(() => ctx._statuses.get("sentinel") === undefined);
  });

  test("a turn that arrives during a running check is verified, not dropped", async () => {
    await configure({
      autoRollback: false,
      backgroundTurnEnd: true,
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [
          {
            // Each execution leaves a mark, so "did this turn get verified?"
            // is answered by counting runs rather than by reading a payload.
            name: "slow",
            cmd: "sleep 0.4; echo run >> ran.log; exit 1",
            timeoutMs: 20000,
          },
        ],
      },
    });

    // Turn 1 starts the slow check. Turn 2 lands while it is still running:
    // dropping it would let its changes reach the user with no verification
    // and no trace at all.
    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    await runTurn(2, "src/b.ts", "export const b = 2;\n");

    assert.ok(
      ctx._notifications.some((n) => n.text.includes("folded into the next run")),
      "the waiting turn is announced rather than silently skipped",
    );

    // The folded-in turn is owed a verification, so the pipeline runs a second
    // time once the first run is done.
    const log = path.join(project, "ran.log");
    await waitFor(
      () => fs.existsSync(log) && fs.readFileSync(log, "utf-8").trim().split("\n").length >= 2,
      20000,
    );
    await waitFor(() => ctx._statuses.get("sentinel") === undefined, 20000);
    assert.ok(fake.sent.length >= 2, "both turns produced feedback");
  });

  test("backgroundTurnEnd: false makes the turn wait for the result", async () => {
    await configure({
      autoRollback: false,
      backgroundTurnEnd: false,
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "sync", cmd: "node -e 'setTimeout(() => process.exit(1), 300)'", timeoutMs: 20000 }],
      },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    assert.equal(fake.sent.length, 1, "the failure is known before the turn resolves");
  });
});

describe("rollback behaviour", () => {
  test("autoRollback restores the turn's files and says so", async () => {
    await configure({
      autoRollback: true,
      backgroundTurnEnd: false,
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "check", cmd: "exit 1", timeoutMs: 5000 }],
      },
    });

    await runTurn(1, "src/a.ts", "broken\n");

    assert.equal(fs.existsSync(path.join(project, "src/a.ts")), false, "the new file is undone");
    const body = fake.sent[0].message.content as string;
    assert.ok(body.includes("rolled back"), body);
  });

  test("autoRollback: false keeps the work and says so", async () => {
    await configure({
      autoRollback: false,
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "check", cmd: "exit 1", timeoutMs: 5000 }],
      },
    });

    await runTurn(1, "src/a.ts", "kept\n");

    assert.equal(fs.readFileSync(path.join(project, "src/a.ts"), "utf-8"), "kept\n");
    const body = fake.sent[0].message.content as string;
    assert.equal(body.includes("rolled back"), false);
  });
});

describe("mindplace impact section", () => {
  /** A two-file graph: `dependent` calls into src/a.ts. */
  function writeGraph(dependent: string): void {
    const dependentId = dependent.replace(/[^a-z0-9]/gi, "_");
    fs.mkdirSync(path.join(project, "graph-out"), { recursive: true });
    fs.writeFileSync(
      path.join(project, "graph-out", "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "a", label: "a", type: "file", sourceFile: "src/a.ts" },
          { id: "parseA", label: "parseA", type: "function", sourceFile: "src/a.ts" },
          {
            id: "b",
            label: dependent,
            type: "file",
            sourceFile: dependent,
          },
          {
            id: dependentId,
            label: "useA",
            type: "function",
            sourceFile: dependent,
          },
        ],
        edges: [{ source: dependentId, target: "parseA", relation: "calls" }],
      }),
      "utf-8",
    );
    _clearCache();
  }

  test("names graph dependents in the failure payload", async () => {
    await configure({
      autoRollback: false,
      include: ["**/*.ts"],
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "check", cmd: "exit 1", timeoutMs: 5000 }] },
    });

    writeGraph("src/b.ts");

    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    const body = fake.sent[0].message.content as string;

    assert.ok(body.includes("Impact (code graph):"), body);
    assert.ok(body.includes("parseA"));
    assert.ok(body.includes("src/b.ts"), "the dependent is named");
  });

  test("omits the section without a graph", async () => {
    await configure({
      autoRollback: false,
      include: ["**/*.ts"],
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "check", cmd: "exit 1", timeoutMs: 5000 }] },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");
    const body = fake.sent[0].message.content as string;
    assert.equal(body.includes("Impact (code graph):"), false);
  });
});

/**
 * The diagnostic focus and the evidence scope are different sets.
 *
 * The mutation path widens the mutated file with its graph dependents so their
 * errors are promoted out of the raw output. That widened set used to be handed
 * to four different questions at once, of which only the first wants it.
 */
describe("diagnostics expand, evidence does not", () => {
  /** A two-file graph: `dependent` calls into src/a.ts, and both exist on disk. */
  function writeDependentGraph(dependent: string): void {
    fs.mkdirSync(path.join(project, "graph-out"), { recursive: true });
    fs.writeFileSync(
      path.join(project, "graph-out", "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "a", label: "a", type: "file", sourceFile: "src/a.ts" },
          { id: "parseA", label: "parseA", type: "function", sourceFile: "src/a.ts" },
          { id: "b", label: dependent, type: "file", sourceFile: dependent },
          { id: "useA", label: "useA", type: "function", sourceFile: dependent },
        ],
        edges: [{ source: "useA", target: "parseA", relation: "calls" }],
      }),
      "utf-8",
    );
    // The dependent must exist: `recordVerified` only records files it can
    // hash, so a phantom path would make the ledger assertion below vacuous.
    fs.mkdirSync(path.dirname(path.join(project, dependent)), { recursive: true });
    fs.writeFileSync(path.join(project, dependent), "export const b = 2;\n", "utf-8");
    _clearCache();
  }

  test("a dependency that was merely recompiled is not recorded as verified", async () => {
    await configure({
      autoRollback: false,
      include: ["**/*.ts"],
      pipelines: {
        onFileMutation: [{ name: "check", cmd: "exit 0", timeoutMs: 5000 }],
        onTurnEnd: [],
      },
    });
    writeDependentGraph("src/b.ts");

    await mutate("src/a.ts", "export const a = 1;\n");

    // Before the split, the expanded focus set reached the ledger and the
    // dependent was claimed as "verified green right now" from then on.
    assert.deepEqual(
      allVerified(project).map((entry) => path.relative(project, entry.path)),
      ["src/a.ts"],
    );
    assert.equal(verifiedEntry(project, path.join(project, "src/b.ts")), null);
  });

  test("the step filter matches the file that changed, not its dependents", async () => {
    await configure({
      autoRollback: false,
      include: [],
      pipelines: {
        // A step for another language: it must not run because a `.py`
        // neighbour happens to import the edited `.ts` file.
        onFileMutation: [{ name: "python-only", cmd: "exit 1", files: ["**/*.py"], timeoutMs: 5000 }],
        onTurnEnd: [],
      },
    });
    writeDependentGraph("src/b.py");

    const result = await mutate("src/a.ts", "export const a = 1;\n");
    assert.equal(result, undefined, "the .py step does not apply to a .ts edit");
  });

  test("a mutation failure names the dependents of what changed", async () => {
    await configure({
      autoRollback: false,
      include: ["**/*.ts"],
      pipelines: {
        onFileMutation: [{ name: "check", cmd: "exit 1", timeoutMs: 5000 }],
        onTurnEnd: [],
      },
    });
    writeDependentGraph("src/b.ts");

    const result = await mutate("src/a.ts", "export const a = 1;\n");
    const text = (result.content as Array<{ text: string }>).map((b) => b.text).join("\n");

    // The impact section is about the edited file's blast radius. Fed with the
    // expanded set it filtered its own dependents out as "self" and reported
    // every entry with "→ none".
    assert.ok(text.includes("Impact (code graph):"), text);
    assert.ok(text.includes("→ src/b.ts"), `the dependent is named as one:\n${text}`);
  });
});

describe("disabled / status", () => {
  test("does nothing at all when disabled", async () => {
    await configure({
      enabled: false,
      autoRollback: false,
      pipelines: {
        onFileMutation: [{ name: "noisy", cmd: "exit 9", timeoutMs: 5000 }],
        onTurnEnd: [{ name: "noisy", cmd: "exit 9", timeoutMs: 5000 }],
      },
    });

    const result = await runTurn(1, "src/a.ts", "export const a = 1;\n");
    assert.equal(result, undefined);
    assert.equal(fake.sent.length, 0);
  });

  test("sentinel_status reports features, checkpoints and the graph", async () => {
    await configure({ pipelines: { onFileMutation: [], onTurnEnd: [] } });
    await runTurn(1, "src/a.ts", "export const a = 1;\n");

    const result = await SentinelStatusTool.execute(
      "status",
      {},
      undefined,
      undefined,
      { cwd: project },
    );
    const text = (result.content as Array<{ text: string }>)[0].text;

    assert.ok(text.includes("autoFix (legacy alias): true"));
    assert.ok(text.includes("recovery: true | maxAttempts: 3"));
    assert.ok(text.includes("policy: false"));
    assert.ok(text.includes("checkpointRetention"));
    assert.ok(text.includes("Recent checkpoints"));
    assert.ok(text.includes("code graph (mindplace): absent"));
  });
});

describe("P6 — coalescing, conflicts, escalation and metrics", () => {
  /** A step that counts its own runs in a file inside the project. */
  function countingStep(name: string, exitCode: number): Record<string, unknown> {
    const program = `const fs=require('fs');const f='runs.txt';fs.appendFileSync(f,'${name}\\n');process.exit(${exitCode})`;
    return { name, cmd: `node -e "${program}"`, timeoutMs: 10000 };
  }

  function runCount(): number {
    const file = path.join(project, "runs.txt");
    if (!fs.existsSync(file)) return 0;
    return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).length;
  }

  test("debounce coalesces edits that land together into one verification", async () => {
    await configure({
      autoRollback: false,
      verification: { debounceMs: 120 },
      pipelines: { onFileMutation: [countingStep("check", 2)], onTurnEnd: [] },
    });

    await Promise.all([mutate("src/a.ts", "a\n", "call-a"), mutate("src/b.ts", "b\n", "call-b")]);
    assert.equal(runCount(), 1, "one run answers both mutations");
    assert.equal(fake.sent.length, 0, "mutation failures are reported as tool results");
  });

  test("without a debounce window every edit is verified on its own", async () => {
    await configure({
      autoRollback: false,
      pipelines: { onFileMutation: [countingStep("check", 2)], onTurnEnd: [] },
    });

    await mutate("src/a.ts", "a\n", "call-a");
    await mutate("src/b.ts", "b\n", "call-b");
    assert.equal(runCount(), 2);
  });

  test("the failure payload names the kind and the file is left alone", async () => {
    await configure({
      autoRollback: false,
      pipelines: { onFileMutation: [countingStep("check", 0)], onTurnEnd: [] },
    });
    const ok = await mutate("src/a.ts", "a\n", "call-ok");
    assert.equal(ok, undefined, "a passing mutation changes nothing");
  });

  test("records verification metrics in the project state", async () => {
    await configure({
      autoRollback: false,
      pipelines: { onFileMutation: [countingStep("check", 2)], onTurnEnd: [] },
    });

    await mutate("src/a.ts", "a\n", "call-metrics");
    const metrics = getState().metrics;
    assert.ok(metrics.checks >= 1, "a step ran");
    assert.ok(metrics.failures >= 1, "and it failed");
  });

  test("escalates when the same failure repeats", async () => {
    await configure({
      autoFix: false,
      autoRollback: false,
      verification: { failureEscalation: { enabled: true, maxRepeatedFailures: 2 } },
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [
          {
            name: "tests",
            cmd: "echo \"src/a.ts(1,1): error TS2322: boom\" && exit 1",
            timeoutMs: 10000,
          },
        ],
      },
    });

    await runTurn(1, "src/a.ts", "one\n");
    assert.equal(
      ctx._notifications.some((n) => n.text.includes("Repeated verification failure")),
      false,
      "one failure is not a loop",
    );

    await runTurn(2, "src/a.ts", "two\n");
    assert.ok(
      ctx._notifications.some((n) => n.text.includes("Repeated verification failure")),
      "the second identical failure escalates",
    );
    assert.ok(getState().escalations.length >= 1, "and is audited");
  });

  test("a green run clears the escalation counters", async () => {
    await configure({
      autoFix: false,
      autoRollback: false,
      verification: { failureEscalation: { enabled: true, maxRepeatedFailures: 2 } },
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "tests", cmd: "exit 1", timeoutMs: 10000 }],
      },
    });
    await runTurn(1, "src/a.ts", "one\n");
    await runTurn(2, "src/a.ts", "two\n");

    writeConfig({
      autoFix: false,
      autoRollback: false,
      backgroundTurnEnd: false,
      verification: { failureEscalation: { enabled: true, maxRepeatedFailures: 2 } },
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "tests", cmd: "exit 0", timeoutMs: 10000 }] },
    });
    await emit(fake, "session_start", { type: "session_start" }, ctx);
    await runTurn(3, "src/a.ts", "three\n");

    const status = await SentinelStatusTool.execute("s", {}, undefined, undefined, { cwd: project });
    const text = (status.content as Array<{ text: string }>)[0].text;
    assert.ok(text.includes("Escalating failures: none"), text);
    assert.ok(text.includes("Performance"));
  });

  test("a rewind refuses to overwrite a file edited after that turn", async () => {
    await configure({ autoRollback: false, pipelines: { onFileMutation: [], onTurnEnd: [] } });
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "src/a.ts"), "original\n");

    await runTurn(1, "src/a.ts", "agent version\n");
    // Another process edits the file after the turn ended.
    fs.writeFileSync(path.join(project, "src/a.ts"), "user version\n");

    const result = await SentinelRewindTool.execute("r", { mode: "code" }, undefined, undefined, {
      cwd: project,
    });
    const details = result.details as { rewound: boolean; conflicted: string[] };
    assert.equal(details.rewound, false);
    assert.equal(details.conflicted.length, 1);
    assert.equal(fs.readFileSync(path.join(project, "src/a.ts"), "utf-8"), "user version\n");
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(text.includes("ROLLBACK CONFLICT"), text);
  });

  test("the status tool reports the performance counters", async () => {
    await configure({
      autoRollback: false,
      pipelines: { onFileMutation: [countingStep("check", 2)], onTurnEnd: [] },
    });
    await mutate("src/a.ts", "a\n", "call-status");

    const result = await SentinelStatusTool.execute("s", {}, undefined, undefined, { cwd: project });
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(text.includes("Performance"), text);
    assert.ok(text.includes("checks:"));
    assert.ok(text.includes("debounce: 0ms"));
  });

  test("/sentinel config never prints configured credentials", async () => {
    await configure({
      pipelines: {
        onFileMutation: [
          {
            name: "leaky",
            cmd: "exit 0",
            timeoutMs: 1000,
            env: { DEPLOY_TOKEN: "super-secret-token-1234" },
          },
        ],
        onTurnEnd: [],
      },
    });

    const command = fake.commands[0];
    await command.handler("config", ctx);
    const lines = (ctx._widgets.get("sentinel") ?? []) as string[];
    const printed = lines.join("\n");
    assert.equal(printed.includes("super-secret-token-1234"), false);
    assert.ok(printed.includes("[redacted]"));
    assert.ok(printed.includes("DEPLOY_TOKEN"), "the key stays visible");
  });
});

describe("data safety — foreign work and unknown state", () => {
  test("a user's out-of-band edit to a verified file is never reverted", async () => {
    // Regression: the P2 regression revert used to consider every path in the
    // turn's focus, including files that only appeared via out-of-band
    // detection — so a user's manual edit to a previously verified file was
    // silently overwritten while the agent was working on something else.
    await configure({
      autoRollback: false,
      revertOnRegression: true,
      include: ["**/*.ts"],
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "chk", cmd: "exit 0", timeoutMs: 5000 }],
      },
    });
    execSync("git init -q", { cwd: project });

    await runTurn(1, "src/a.ts", "export const a = 1; // green\n");
    assert.ok(verifiedEntry(project, path.join(project, "src/a.ts")), "a.ts is verified");

    // The user edits the verified file outside any agent turn.
    fs.writeFileSync(path.join(project, "src/a.ts"), "export const a = 2; // USER WORK\n");

    // A later turn fails, but the agent only touched a different file.
    await configure({
      autoRollback: false,
      revertOnRegression: true,
      include: ["**/*.ts"],
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "chk", cmd: "exit 1", timeoutMs: 5000 }],
      },
    });
    await runTurn(2, "src/b.ts", "export const b = 1;\n");

    assert.equal(
      fs.readFileSync(path.join(project, "src/a.ts"), "utf-8"),
      "export const a = 2; // USER WORK\n",
      "the user's manual edit must survive",
    );
    const body = fake.sent[0]?.message.content ?? "";
    assert.equal(
      body.includes("Regressed from a verified state"),
      false,
      "sentinel must not attribute a user's pre-turn edit to the agent",
    );
  });

  test("a step skipped by its file filter does not create verified evidence", async () => {
    // Regression: a skipped step still appeared in `run.steps`, so a run that
    // proved nothing was recorded as a verified state.
    await configure({
      autoRollback: false,
      include: ["**/*.ts"],
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "python-only", cmd: "exit 0", timeoutMs: 5000, files: ["**/*.py"] }],
      },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");

    assert.equal(
      verifiedEntry(project, path.join(project, "src/a.ts")),
      null,
      "no check ran, so nothing was proved",
    );
  });

  test("a partial restore is reported as an unknown state", async () => {
    await configure({
      autoRollback: true,
      backgroundTurnEnd: false,
      include: ["**/*.ts"],
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "chk", cmd: "exit 1", timeoutMs: 5000 }],
      },
    });

    // Pre-existing and larger than MAX_SNAPSHOT_BYTES: sentinel keeps no
    // content and so cannot restore it. The message must not claim the change
    // is still in place.
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "src/big.ts"), "y".repeat(4 * 1024 * 1024 + 64));
    await runTurn(1, "src/big.ts", "x".repeat(4 * 1024 * 1024 + 64));

    const body = fake.sent[0]?.message.content ?? "";
    assert.ok(body.includes("RESTORE INCOMPLETE"), body);
    assert.ok(body.includes("UNKNOWN"), body);
    assert.ok(
      ctx._notifications.some((n) => n.text.includes("only part of the turn")),
      "the user is told the restore was partial",
    );
  });
});

describe("background staleness — a moved tree invalidates the result", () => {
  test("a background failure is discarded when the code changed while it ran", async () => {
    // The check itself edits the file it is judging, then fails — the exact
    // shape of "the agent moved on while npm test was still running". Acting on
    // that failure would send the repair loop after code that already changed.
    await configure({
      autoRollback: false,
      backgroundTurnEnd: true,
      include: ["**/*.ts"],
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [
          {
            name: "stale",
            cmd: "node -e \"require('fs').appendFileSync('src/a.ts',' // moved during the run'); process.exit(1)\"",
            timeoutMs: 10000,
          },
        ],
      },
    });

    await runTurn(1, "src/a.ts", "export const a = 1;\n");

    await waitFor(() =>
      ctx._notifications.some((n) => n.text.includes("stale result was discarded")),
    );
    assert.equal(fake.sent.length, 0, "the agent must not be re-prompted on a stale result");
  });
});
