/**
 * The real extension factory against a fake pi: the lifecycle a session goes
 * through, with real check commands and real files.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import sentinel, { SENTINEL_MESSAGE_TYPE, SUPERSEDED_NOTICE } from "../index.ts";
import { createCtx, createFakePi, gitInit, isolateHome, read, resetCaches, tempDir, write } from "./helpers.ts";
import type { FakeCtx, FakePi } from "./helpers.ts";

/** A check that fails while src/sum.js contains BUG, and counts its runs. */
const CHECK = `
import fs from "node:fs";
fs.appendFileSync(".runs", process.argv[2] + "\\n");
const src = fs.readFileSync("src/sum.js", "utf-8");
if (src.includes("BUG")) {
  console.log("not ok 1 - sum adds numbers");
  console.log("  AssertionError: expected 3, got 2");
  console.log("    at src/sum.js:1:1");
  process.exit(1);
}
console.log("ok 1 - sum adds numbers");
`;

function project(configBody: string): string {
  const cwd = tempDir("sentinel-project-");
  write(cwd, "check.mjs", CHECK);
  write(cwd, "src/sum.js", "export const sum = (a, b) => a + b;\n");
  write(cwd, "sentinel.config.ts", `export default ${configBody};`);
  return cwd;
}

const GATE = `{
  checks: {
    afterEdit: [{ name: "quick", cmd: "node check.mjs quick", files: ["**/*.js"] }],
    beforeDone: [{ name: "test", cmd: "node check.mjs test" }],
  },
  repair: { maxAttempts: 2 },
}`;

function runs(cwd: string, name: string): number {
  return (read(cwd, ".runs") ?? "").split("\n").filter((l) => l === name).length;
}

interface Session {
  pi: FakePi;
  ctx: FakeCtx;
  cwd: string;
}

async function start(cwd: string): Promise<Session> {
  const pi = createFakePi();
  sentinel(pi.api);
  const ctx = createCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  return { pi, ctx, cwd };
}

async function prompt(s: Session, text = "do the task"): Promise<string> {
  const result = await s.pi.fire("before_agent_start", { prompt: text, systemPrompt: "BASE" }, s.ctx);
  return result?.systemPrompt ?? "BASE";
}

let callId = 0;

/** An `edit`/`write` tool call as pi would run it: tool_call, the write, tool_result. */
async function edit(s: Session, rel: string, content: string) {
  const id = `call-${++callId}`;
  const input = { path: rel, content };
  await s.pi.fire("tool_call", { toolName: "write", toolCallId: id, input }, s.ctx);
  write(s.cwd, rel, content);
  return s.pi.fire("tool_result", { toolName: "write", toolCallId: id, input, content: [{ type: "text", text: "ok" }], isError: false }, s.ctx);
}

async function agentRun(s: Session, work: () => Promise<void>, stopReason = "stop") {
  await s.pi.fire("agent_start", {}, s.ctx);
  await work();
  await s.pi.fire("agent_end", { messages: [{ role: "assistant", stopReason }] }, s.ctx);
}

let restoreHome: () => void;
before(() => {
  restoreHome = isolateHome();
});
after(() => restoreHome());
beforeEach(resetCaches);

describe("system prompt", () => {
  test("adds the working rules with the gate's check names", async () => {
    const s = await start(project(GATE));
    const system = await prompt(s);
    assert.match(system, /^BASE\n\n## pi-sentinel/);
    assert.match(system, /sentinel runs `test`\. If one fails you are sent back to fix it \(at most 2 rounds\)/);
  });

  test("can be turned off", async () => {
    const s = await start(project(`{ contract: false }`));
    assert.equal(await prompt(s), "BASE");
  });
});

describe("after an edit", () => {
  test("a red fast check is attached to the tool result as a hint", async () => {
    const s = await start(project(GATE));
    await prompt(s);
    await s.pi.fire("agent_start", {}, s.ctx);
    const result = await edit(s, "src/sum.js", "export const sum = (a, b) => a - b; // BUG\n");
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].text, "ok", "the original result stays first");
    assert.match(result.content[1].text, /\[sentinel\] "quick" failed \(failing test/);
    assert.match(result.content[1].text, /keep going/);
    assert.equal(result.isError, undefined, "an edit is not turned into an error");
  });

  test("a green check leaves the result untouched, and unrelated files run nothing", async () => {
    const s = await start(project(GATE));
    await prompt(s);
    assert.equal(await edit(s, "src/sum.js", "export const sum = (a, b) => a + b; // fine\n"), undefined);
    assert.equal(await edit(s, "notes.md", "text"), undefined);
    assert.equal(runs(s.cwd, "quick"), 1);
  });

  test("parallel edits share one check run and one hint", async () => {
    const s = await start(project(GATE));
    await prompt(s);
    const results = await Promise.all([
      edit(s, "src/sum.js", "BUG 1"),
      edit(s, "src/a.js", "a"),
      edit(s, "src/b.js", "b"),
    ]);
    assert.equal(results.filter((r) => r?.content?.length === 2).length, 1);
    assert.ok(runs(s.cwd, "quick") <= 2, `ran ${runs(s.cwd, "quick")} times`);
  });
});

describe("the gate at agent_end", () => {
  test("red sends the agent back; a green repair closes the loop and supersedes the failure", async () => {
    const s = await start(project(GATE));
    await prompt(s);

    await agentRun(s, async () => {
      await edit(s, "src/sum.js", "export const sum = (a, b) => a - b; // BUG\n");
    });
    assert.equal(s.pi.sent.length, 1);
    const [repairMsg] = s.pi.sent;
    assert.equal(repairMsg.message.customType, SENTINEL_MESSAGE_TYPE);
    assert.deepEqual(repairMsg.options, { deliverAs: "followUp", triggerTurn: true });
    assert.match(repairMsg.message.content, /Not done yet: "test" failed .* Repair attempt 1\/2/);
    assert.match(repairMsg.message.content, /Changed in this run: src\/sum\.js/);

    // pi continues with the follow-up as a new agent run.
    await agentRun(s, async () => {
      await edit(s, "src/sum.js", "export const sum = (a, b) => a + b;\n");
    });
    assert.equal(s.pi.sent.length, 1, "green sends nothing");
    assert.ok(s.ctx.notifications.some((n) => /pass after 1 repair/.test(n.text)));

    const context = await s.pi.fire(
      "context",
      { messages: [{ role: "user", content: "task" }, { role: "custom", ...repairMsg.message, timestamp: 0 }] },
      s.ctx,
    );
    assert.equal(context.messages[1].content, SUPERSEDED_NOTICE);
    assert.equal(context.messages[0].content, "task");
  });

  test("the budget is bounded: after maxAttempts sentinel stops and tells the next turn", async () => {
    const s = await start(project(GATE));
    await prompt(s);
    for (let i = 0; i < 3; i += 1) {
      await agentRun(s, async () => {
        await edit(s, "src/sum.js", `BUG attempt ${i}`);
      });
    }
    const kinds = s.pi.sent.map((m) => m.message.details.kind);
    assert.deepEqual(kinds, ["repair", "repair", "stopped"]);
    assert.deepEqual(s.pi.sent[2].options, { deliverAs: "nextTurn" });
    assert.match(s.pi.sent[1].message.content, /last attempt/);
    assert.ok(s.ctx.notifications.some((n) => n.level === "error" && /repair budget is used up/.test(n.text)));
  });

  test("a repair round that changes nothing stops without re-running the checks", async () => {
    const s = await start(project(GATE));
    await prompt(s);
    await agentRun(s, async () => {
      await edit(s, "src/sum.js", "BUG");
    });
    const before = runs(s.cwd, "test");
    await agentRun(s, async () => {});
    assert.equal(runs(s.cwd, "test"), before);
    assert.deepEqual(s.pi.sent.map((m) => m.message.details.kind), ["repair", "stopped"]);
    assert.match(s.pi.sent[1].message.content, /did not change any code/);
    assert.ok(s.ctx.notifications.some((n) => /changed no code/.test(n.text)));
  });

  test("a new user prompt starts a fresh budget", async () => {
    const s = await start(project(`{ checks: { afterEdit: [], beforeDone: [{ name: "test", cmd: "node check.mjs test" }] }, repair: { maxAttempts: 1 } }`));
    await prompt(s);
    await agentRun(s, async () => {
      await edit(s, "src/sum.js", "BUG a");
    });
    await prompt(s, "try again");
    await agentRun(s, async () => {
      await edit(s, "src/sum.js", "BUG b");
    });
    assert.deepEqual(s.pi.sent.map((m) => m.message.details.kind), ["repair", "repair"]);
  });

  test("no changes, no checks", async () => {
    const s = await start(project(GATE));
    await prompt(s);
    await agentRun(s, async () => {});
    assert.equal(runs(s.cwd, "test"), 0);
  });

  test("an interrupted run is not gated", async () => {
    const s = await start(project(GATE));
    await prompt(s);
    await agentRun(s, async () => {
      await edit(s, "src/sum.js", "BUG");
    }, "aborted");
    assert.equal(runs(s.cwd, "test"), 0);
    assert.equal(s.pi.sent.length, 0);
  });

  test("a check that cannot run is reported to the user, never to the agent", async () => {
    const s = await start(project(`{ checks: { afterEdit: [], beforeDone: [{ name: "test", cmd: "no-such-binary-xyz" }] } }`));
    await prompt(s);
    await agentRun(s, async () => {
      await edit(s, "src/sum.js", "whatever");
    });
    assert.equal(s.pi.sent.length, 0);
    assert.ok(s.ctx.notifications.some((n) => /could not run \(command not found\)/.test(n.text)));
  });

  test("changes made through bash are gated in a git repository", async () => {
    const cwd = project(GATE);
    gitInit(cwd);
    const s = await start(cwd);
    await prompt(s);
    await agentRun(s, async () => {
      write(cwd, "src/sum.js", "BUG from sed"); // no edit/write tool call
    });
    assert.equal(s.pi.sent.length, 1);
    assert.match(s.pi.sent[0].message.content, /Changed in this run: src\/sum\.js/);
  });

  test("disabled means silent", async () => {
    const s = await start(project(`{ enabled: false, checks: { beforeDone: [{ name: "test", cmd: "node check.mjs test" }] } }`));
    assert.equal(await prompt(s), "BASE");
    await agentRun(s, async () => {
      await edit(s, "src/sum.js", "BUG");
    });
    assert.equal(runs(s.cwd, "test"), 0);
  });
});

describe("tools and command", () => {
  test("sentinel_rewind lists and restores the files of a run", async () => {
    const s = await start(project(`{ checks: { afterEdit: [], beforeDone: [] } }`));
    await prompt(s, "rename things");
    await agentRun(s, async () => {
      await edit(s, "src/sum.js", "changed");
      await edit(s, "src/new.js", "created");
    });
    const tool = s.pi.tools.get("sentinel_rewind");
    const list = await tool.execute("1", { action: "list" }, undefined, undefined, s.ctx);
    assert.match(list.content[0].text, /rename things — 2 file\(s\)/);

    const restored = await tool.execute("2", { action: "restore" }, undefined, undefined, s.ctx);
    assert.match(restored.content[0].text, /Restored: src\/sum\.js/);
    assert.match(restored.content[0].text, /Deleted \(did not exist before\): src\/new\.js/);
    assert.equal(read(s.cwd, "src/sum.js"), "export const sum = (a, b) => a + b;\n");
    assert.equal(fs.existsSync(path.join(s.cwd, "src/new.js")), false);
  });

  test("sentinel_verify runs the gate on demand", async () => {
    const s = await start(project(GATE));
    const tool = s.pi.tools.get("sentinel_verify");
    const green = await tool.execute("1", {}, undefined, undefined, s.ctx);
    assert.match(green.content[0].text, /Passed: test/);
    write(s.cwd, "src/sum.js", "BUG");
    const red = await tool.execute("2", {}, undefined, undefined, s.ctx);
    assert.equal(red.details.passed, false);
    assert.match(red.content[0].text, /^\[sentinel\] "test" failed/);
    assert.doesNotMatch(red.content[0].text, /Repair attempt/);
    const unknown = await tool.execute("3", { step: "nope" }, undefined, undefined, s.ctx);
    assert.match(unknown.content[0].text, /Configured: test/);
  });

  test("/sentinel checks shows what runs and why", async () => {
    const cwd = tempDir();
    write(cwd, "package.json", JSON.stringify({ scripts: { typecheck: "tsc", test: "node --test" } }));
    const s = await start(cwd);
    await s.pi.commands.get("sentinel").handler("checks", s.ctx);
    const text = s.ctx.widget.join("\n");
    assert.match(text, /config: defaults \(checks detected\)/);
    assert.match(text, /typecheck: npm run typecheck/);
    assert.match(text, /test: npm test/);
    assert.match(text, /detected test: package.json script "test"/);
  });
});
