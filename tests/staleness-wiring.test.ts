/**
 * End-to-end tests for stale verdicts.
 *
 * The complaint these answer: a red report arrived for a state that had already
 * been fixed, and it had already spent repair attempts by the time a human read
 * it. The guard that existed bound the *turn's* files, so a whole-project step
 * (`npm test`) went stale whenever anything else in the project moved — which,
 * while an agent is working, is the normal case.
 *
 * The control case matters as much as the stale one: the guard must discard
 * verdicts whose inputs moved, not verdicts in general.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import extensionFactory from "../index.ts";
import { createRuntime } from "../src/runtime.ts";
import type { SentinelRuntime } from "../src/runtime.ts";

type Handler = (event: any, ctx: any) => any;

interface Harness {
  api: any;
  handlers: Map<string, Handler[]>;
  sent: Array<{ message: any; options: any }>;
  notifications: Array<{ text: string; level: string }>;
}

function createHarness(): Harness {
  const handlers = new Map<string, Handler[]>();
  const sent: Array<{ message: any; options: any }> = [];
  const notifications: Array<{ text: string; level: string }> = [];
  const api = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
    events: { on: () => () => {}, emit: () => {} },
  };
  return { api, handlers, sent, notifications };
}

async function fire(fake: Harness, name: string, event: any, ctx: any): Promise<any> {
  let result: any;
  for (const handler of fake.handlers.get(name) ?? []) {
    const value = await handler(event, ctx);
    if (value !== undefined) result = value;
  }
  return result;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A failing onTurnEnd step that holds the run open long enough to move a file. */
const SLOW_FAIL = 'node -e "setTimeout(()=>process.exit(1),400)"';

let home: string;
let project: string;
let fake: Harness;
let runtime: SentinelRuntime;
let ctx: any;

async function startSession(): Promise<void> {
  fs.writeFileSync(
    path.join(project, "sentinel.config.js"),
    `export default ${JSON.stringify(
      {
        backgroundTurnEnd: true,
        detectOutOfBand: false,
        include: ["**/*.ts"],
        exclude: ["**/node_modules/**"],
        pipelines: {
          onFileMutation: [],
          onTurnEnd: [{ name: "slow-fail", cmd: SLOW_FAIL, timeoutMs: 5000, cacheable: false }],
        },
      },
      null,
      2,
    )};\n`,
    "utf-8",
  );
  await fire(fake, "session_start", { type: "session_start" }, ctx);
}

describe("staleness: a verdict whose inputs moved", () => {
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-stale-home-"));
    project = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-stale-proj-"));
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
    fs.rmSync(path.join(project, "src"), { recursive: true, force: true });
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "src", "base.ts"), "export const base = 1;\n");
    await startSession();
    await fire(fake, "turn_start", { type: "turn_start", turnIndex: 1 }, ctx);
  });

  test("is discarded, spends no attempt, and never reaches the agent", async () => {
    await fire(fake, "turn_end", { type: "turn_end", turnIndex: 1 }, ctx);

    // The check is now running. Move a file it reads but the turn never touched
    // — exactly what an agent editing while `npm test` runs does.
    fs.writeFileSync(path.join(project, "src", "moved.ts"), "export const moved = 1;\n");

    await waitFor(() => fake.notifications.some((n) => n.text.includes("discarded")));

    const notice = fake.notifications.find((n) => n.text.includes("discarded"))!;
    assert.match(notice.text, /stale result was discarded/);
    assert.match(notice.text, /src\/moved\.ts/);
    assert.match(notice.text, /cost no repair attempt/);

    // Nothing was sent to the model, and the red verdict is not history.
    assert.equal(fake.sent.length, 0, "a stale verdict must not re-prompt the agent");
    assert.deepEqual(
      runtime.config.state().turnHistory.filter((entry) => !entry.passed),
      [],
      "a stale verdict must not become the newest red turn",
    );
    assert.deepEqual(runtime.config.state().autoFixHistory, [], "no attempt was spent");
  });

  test("control: an unchanged tree still delivers the failure", async () => {
    await fire(fake, "turn_end", { type: "turn_end", turnIndex: 1 }, ctx);

    await waitFor(() => runtime.config.state().turnHistory.length > 0);

    assert.equal(fake.notifications.some((n) => n.text.includes("discarded")), false);
    assert.equal(runtime.config.state().turnHistory[0].passed, false);
    assert.ok(fake.sent.length > 0, "a genuine failure still re-prompts the agent");
    assert.ok(runtime.config.state().autoFixHistory.length > 0);
  });
});
