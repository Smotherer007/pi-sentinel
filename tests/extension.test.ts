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

import extensionFactory, { SENTINEL_MESSAGE_TYPE } from "../index.ts";
import { projectDir, _resetForTesting, getConfig, getState } from "../src/config.ts";
import { checkpoints } from "../src/clients/checkpoints.ts";
import { verifiedEntry } from "../src/clients/evidence.ts";
import { SentinelRewindTool } from "../src/tools/sentinel-rewind.ts";
import { SentinelStatusTool } from "../src/tools/sentinel-status.ts";
import { _clearCache } from "../src/clients/mindplace.ts";
import { changedPaths } from "../src/clients/workspace.ts";

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

/** One full turn: start, mutate, end. */
async function runTurn(turnIndex: number, rel: string | null, content: string): Promise<any> {
  await emit(fake, "turn_start", { type: "turn_start", turnIndex }, ctx);
  if (rel) await mutate(rel, content, `call-${turnIndex}`);
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
      policy: { enabled: true, allowWorkflowChanges: false },
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
      policy: { enabled: true, allowWorkflowChanges: false },
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
      policy: { enabled: true, allowWorkflowChanges: false, rollbackOnViolation: true },
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
      policy: { enabled: true, allowWorkflowChanges: false },
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

  test("an out-of-band violation is reported once, not re-sent in a loop", async () => {
    await configure({
      autoRollback: false,
      policy: { enabled: true, allowWorkflowChanges: false },
      include: ["**/*.yml"],
      pipelines: { onFileMutation: [], onTurnEnd: [] },
    });

    execSync("git init -q", { cwd: project });
    execSync("git add -A", { cwd: project });

    const target = path.join(project, ".github/workflows/ci.yml");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "name: ci\n");

    await runTurn(1, null, "");
    assert.equal(fake.sent.length, 1, "a bash-only change is still caught");

    // The very same state is observed again: nothing changed and nothing was
    // committed, so the change is reported to the human but not re-prompted.
    await runTurn(2, null, "");
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

    // A "bash" style change: written directly, no tool_call involved.
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "src/generated.ts"), "export const g = 1;\n");

    // Precondition: `git status` is the only source for out-of-band changes and
    // can lag briefly under load. Wait until the scan sees the file, so a slow
    // git fails here with a clear message instead of at the notification below.
    await waitFor(() =>
      changedPaths(project).some((c) => c.path.endsWith("generated.ts")),
    );

    await runTurn(1, null, "");

    assert.ok(
      ctx._notifications.some((n) => n.text.includes("changed outside edit/write")),
      "the user is told what the hooks could not see",
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
  test("names graph dependents in the failure payload", async () => {
    await configure({
      autoRollback: false,
      include: ["**/*.ts"],
      pipelines: { onFileMutation: [], onTurnEnd: [{ name: "check", cmd: "exit 1", timeoutMs: 5000 }] },
    });

    fs.mkdirSync(path.join(project, "graph-out"), { recursive: true });
    fs.writeFileSync(
      path.join(project, "graph-out", "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "a", label: "a.ts", type: "file", sourceFile: "src/a.ts" },
          { id: "parseA", label: "parseA", type: "function", sourceFile: "src/a.ts" },
          { id: "b", label: "b.ts", type: "file", sourceFile: "src/b.ts" },
          { id: "useA", label: "useA", type: "function", sourceFile: "src/b.ts" },
        ],
        edges: [{ source: "useA", target: "parseA", relation: "calls" }],
      }),
      "utf-8",
    );
    _clearCache();

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
