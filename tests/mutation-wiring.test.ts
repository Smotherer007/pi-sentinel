/**
 * End-to-end wiring tests for the mutation seam and the inter-extension bus.
 *
 * `tests/mutation.test.ts` covers the classification in isolation and
 * `tests/bus.test.ts` covers the bus in isolation. These drive the real
 * extension factory against a fake pi, because the claims that matter are about
 * the *wiring*: a tool nobody declared writes a file, and the turn can still be
 * rolled back — which was impossible while "did this call write?" meant
 * comparing two tool names.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import extensionFactory from "../index.ts";
import { createRuntime } from "../src/runtime.ts";
import type { SentinelRuntime } from "../src/runtime.ts";
import { FILES_TOUCHED_CHANNEL, VERIFIED_CHANNEL } from "../src/clients/bus.ts";

type Handler = (event: any, ctx: any) => any;

interface Harness {
  api: any;
  handlers: Map<string, Handler[]>;
  tools: any[];
  emitted: Array<{ channel: string; data: unknown }>;
  notifications: Array<{ text: string; level: string }>;
  emitBus(channel: string, data: unknown): void;
}

function createHarness(): Harness {
  const handlers = new Map<string, Handler[]>();
  const busHandlers = new Map<string, Array<(data: unknown) => void>>();
  const tools: any[] = [];
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const notifications: Array<{ text: string; level: string }> = [];

  const api = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand() {},
    sendMessage() {},
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        const list = busHandlers.get(channel) ?? [];
        list.push(handler);
        busHandlers.set(channel, list);
        return () => {};
      },
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
      },
    },
  };

  return {
    api,
    handlers,
    tools,
    emitted,
    notifications,
    emitBus(channel, data) {
      for (const handler of busHandlers.get(channel) ?? []) handler(data);
    },
  };
}

async function fire(fake: Harness, name: string, event: any, ctx: any): Promise<any> {
  let result: any;
  for (const handler of fake.handlers.get(name) ?? []) {
    const value = await handler(event, ctx);
    if (value !== undefined) result = value;
  }
  return result;
}

let home: string;
let project: string;
let fake: Harness;
let runtime: SentinelRuntime;
let ctx: any;

function writeConfig(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(project, "sentinel.config.js"),
    `export default ${JSON.stringify(extra, null, 2)};\n`,
    "utf-8",
  );
}

/** Arm the extension with a cheap, matching mutation pipeline. */
async function startSession(extra: Record<string, unknown> = {}): Promise<void> {
  writeConfig({
    backgroundTurnEnd: false,
    pipelines: {
      onFileMutation: [{ name: "ok", cmd: "exit 0", timeoutMs: 5000, files: ["**/*.txt"] }],
      onTurnEnd: [],
    },
    ...extra,
  });
  await fire(fake, "session_start", { type: "session_start" }, ctx);
}

/**
 * One call of a tool nobody declared, carrying content as well as a path.
 *
 * This is the shape tier: the seam classifies it as an edit before it runs, so
 * no observation is needed and nothing has to be learned.
 */
async function callForeign(toolName: string, rel: string, body: string, callId: string): Promise<any> {
  await fire(
    fake,
    "tool_call",
    { type: "tool_call", toolName, toolCallId: callId, input: { path: rel, newText: body } },
    ctx,
  );
  const abs = path.join(project, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return fire(
    fake,
    "tool_result",
    {
      type: "tool_result",
      toolName,
      toolCallId: callId,
      input: { path: rel, newText: body },
      content: [{ type: "text", text: "ok" }],
      isError: false,
    },
    ctx,
  );
}

/**
 * One call of a tool nobody declared that names a path and nothing else.
 *
 * This is the case only the observation tier can catch — a hashline editor, an
 * anchor-based rewriter, anything whose content travels outside the arguments
 * sentinel can read. Nothing is known until the file itself is compared.
 */
async function callObserved(toolName: string, rel: string, body: string, callId: string): Promise<any> {
  await fire(
    fake,
    "tool_call",
    { type: "tool_call", toolName, toolCallId: callId, input: { path: rel } },
    ctx,
  );
  const abs = path.join(project, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return fire(
    fake,
    "tool_result",
    {
      type: "tool_result",
      toolName,
      toolCallId: callId,
      input: { path: rel },
      content: [{ type: "text", text: "ok" }],
      isError: false,
    },
    ctx,
  );
}

describe("mutation seam: a tool nobody declared", () => {
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-mut-home-"));
    project = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-mut-proj-"));
    process.env.HOME = home;
  });

  after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  beforeEach(async () => {
    runtime = createRuntime();
    fake = createHarness();
    extensionFactory(fake.api, { runtime });
    ctx = {
      cwd: project,
      hasUI: true,
      ui: {
        notify: (text: string, level = "info") => fake.notifications.push({ text, level }),
        setStatus: () => {},
        setWidget: () => {},
        select: async () => undefined,
      },
      sessionManager: { getLeafId: () => "entry-1", getSessionFile: () => undefined },
    };
    fs.rmSync(path.join(project, "sentinel.config.js"), { force: true });
    fs.rmSync(path.join(home, ".pi"), { recursive: true, force: true });
    await startSession();
    await fire(fake, "turn_start", { type: "turn_start", turnIndex: 1 }, ctx);
  });

  test("a path plus content is snapshotted and verified, with nothing to learn", async () => {
    const rel = "a.txt";
    const abs = path.join(project, rel);
    fs.writeFileSync(abs, "original");

    await callForeign("frobnicate", rel, "changed", "c1");
    assert.equal(fs.readFileSync(abs, "utf-8"), "changed");

    // The point of the seam: this call was not `edit` or `write`, and there is
    // still a pre-state to restore.
    assert.ok(
      runtime.snapshots.turnPaths().includes(abs),
      "an unclassified write must reach the turn scope",
    );
    // Classified from its arguments, so there was nothing to observe.
    assert.deepEqual(runtime.config.state().learnedMutationTools, []);

    const rollback = fake.tools.find((tool) => tool.name === "sentinel_rollback");
    await rollback.execute("rb", { mode: "turn" }, undefined, undefined, ctx);
    assert.equal(fs.readFileSync(abs, "utf-8"), "original");
  });

  test("a path with no content is learned from the file it wrote", async () => {
    const rel = "observed.txt";
    const abs = path.join(project, rel);
    fs.writeFileSync(abs, "original");

    await callObserved("frobnicate", rel, "changed", "c1");
    assert.equal(fs.readFileSync(abs, "utf-8"), "changed");

    // Nothing in the arguments said "I write", so the only evidence is the
    // file — and that evidence is enough to reclassify the tool.
    assert.deepEqual(runtime.config.state().learnedMutationTools, ["frobnicate"]);
    assert.ok(
      fake.notifications.some((n) => n.text.includes("frobnicate")),
      "learning is announced rather than silent",
    );
    assert.ok(
      runtime.snapshots.turnPaths().includes(abs),
      "the speculative capture is promoted to the turn",
    );

    const rollback = fake.tools.find((tool) => tool.name === "sentinel_rollback");
    await rollback.execute("rb", { mode: "turn" }, undefined, undefined, ctx);
    assert.equal(fs.readFileSync(abs, "utf-8"), "original");
  });

  test("once learned, the next call is captured before it runs", async () => {
    await callObserved("frobnicate", "learned-once.txt", "first", "c1");
    assert.deepEqual(runtime.config.state().learnedMutationTools, ["frobnicate"]);

    // A new turn, and now only the tool_call — no result yet, no write yet.
    await fire(fake, "turn_end", { type: "turn_end", turnIndex: 1 }, ctx);
    await fire(fake, "turn_start", { type: "turn_start", turnIndex: 2 }, ctx);
    const rel = "second.txt";
    const abs = path.join(project, rel);
    fs.writeFileSync(abs, "before the call");

    await fire(
      fake,
      "tool_call",
      { type: "tool_call", toolName: "frobnicate", toolCallId: "c2", input: { path: rel } },
      ctx,
    );

    assert.ok(
      runtime.snapshots.turnPaths().includes(abs),
      "a learned tool is snapshotted up front, not observed afterwards",
    );

    // Even if the turn never produces a result, the pre-state is there.
    fs.writeFileSync(abs, "after the call");
    const rollback = fake.tools.find((tool) => tool.name === "sentinel_rollback");
    await rollback.execute("rb", { mode: "turn" }, undefined, undefined, ctx);
    assert.equal(fs.readFileSync(abs, "utf-8"), "before the call");
  });

  test("a read-shaped call is not armed, so nothing is captured", async () => {
    const rel = "read-only.txt";
    const abs = path.join(project, rel);
    fs.writeFileSync(abs, "content");

    await fire(
      fake,
      "tool_call",
      { type: "tool_call", toolName: "read_file", toolCallId: "r1", input: { path: rel } },
      ctx,
    );
    await fire(
      fake,
      "tool_result",
      { type: "tool_result", toolName: "read_file", toolCallId: "r1", input: { path: rel }, content: [], isError: false },
      ctx,
    );

    assert.equal(runtime.snapshots.turnPaths().includes(abs), false);
    assert.deepEqual(runtime.config.state().learnedMutationTools, []);
  });
});

describe("bus: another extension's write is attributed, not faked", () => {
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-bus-home-"));
    project = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-bus-proj-"));
    process.env.HOME = home;
  });

  after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  beforeEach(async () => {
    runtime = createRuntime();
    fake = createHarness();
    extensionFactory(fake.api, { runtime });
    ctx = {
      cwd: project,
      hasUI: true,
      ui: {
        notify: (text: string, level = "info") => fake.notifications.push({ text, level }),
        setStatus: () => {},
        setWidget: () => {},
        select: async () => undefined,
      },
      sessionManager: { getLeafId: () => "entry-1", getSessionFile: () => undefined },
    };
    fs.rmSync(path.join(project, "sentinel.config.js"), { force: true });
    fs.rmSync(path.join(home, ".pi"), { recursive: true, force: true });
    await startSession({ detectOutOfBand: false });
    await fire(fake, "turn_start", { type: "turn_start", turnIndex: 1 }, ctx);
  });

  test("the write is announced, and claimed for verification only", async () => {
    const rel = "formatted.txt";
    const abs = path.join(project, rel);
    fs.writeFileSync(abs, "formatted by someone else");

    fake.emitBus(FILES_TOUCHED_CHANNEL, {
      v: 1,
      source: "pi-lens",
      reason: "autofix",
      cwd: project,
      paths: [rel],
    });

    const notice = fake.notifications.find((n) => n.text.includes(rel));
    assert.ok(notice, "the file is named in a notice");
    assert.match(notice!.text, /autofix/);
    assert.match(notice!.text, /cannot restore/);

    // Attribution without a lie: sentinel never captured a pre-state for it, so
    // it must not appear in the turn scope a rollback would restore from.
    assert.equal(runtime.snapshots.turnPaths().includes(abs), false);
  });

  test("a green turn end is published on the bus", async () => {
    await startSession({
      pipelines: {
        onFileMutation: [],
        onTurnEnd: [{ name: "ok", cmd: "exit 0", timeoutMs: 5000 }],
      },
    });
    await fire(fake, "turn_end", { type: "turn_end", turnIndex: 1 }, ctx);

    const verified = fake.emitted.find((entry) => entry.channel === VERIFIED_CHANNEL);
    assert.ok(verified, "a passing verification is announced");
    assert.equal((verified!.data as any).source, "pi-sentinel");
    assert.equal((verified!.data as any).v, 1);
    assert.equal((verified!.data as any).passed, true);
  });
});
