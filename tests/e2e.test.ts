/**
 * End to end inside a real pi AgentSession, with a scripted model.
 *
 * The fake-pi tests prove the hooks; this proves the contract with pi itself:
 * that a red gate at `agent_end` really continues the run, that the model sees
 * the failure, and that the loop ends once the checks pass.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";

import { isolateHome, read, tempDir, write } from "./helpers.ts";

const CHECK = `
import fs from "node:fs";
if (fs.readFileSync("src/sum.js", "utf-8").includes("a - b")) {
  console.log("not ok 1 - sum(1, 2) === 3");
  console.log("  AssertionError: expected 3, got -1");
  process.exit(1);
}
console.log("ok 1 - sum(1, 2) === 3");
`;

function fixture(): string {
  const cwd = tempDir("sentinel-e2e-");
  write(cwd, "check.mjs", CHECK);
  write(cwd, "src/sum.js", "export const sum = (a, b) => 0;\n");
  write(cwd, "sentinel.config.ts", `export default { checks: { afterEdit: [], beforeDone: [{ name: "test", cmd: "node check.mjs" }] } };`);
  return cwd;
}

async function startSession(cwd: string, withSentinel: boolean) {
  const faux = fauxProvider();
  const agentDir = path.join(process.env.HOME!, ".pi", "agent");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noSkills: true,
    noContextFiles: true,
    additionalExtensionPaths: withSentinel ? [path.resolve(import.meta.dirname, "..", "index.ts")] : [],
    extensionFactories: [(pi) => pi.registerProvider(faux.provider)],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    model: faux.getModel(),
  });
  return { session, faux };
}

const texts = (messages: any[]) =>
  messages.map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join(""))).join("\n");

let restoreHome: () => void;
before(() => {
  restoreHome = isolateHome();
});
after(() => restoreHome());

describe("a real pi session", () => {
  test("without sentinel the agent stops with a broken change", async () => {
    const cwd = fixture();
    const { session, faux } = await startSession(cwd, false);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "src/sum.js", content: "export const sum = (a, b) => a - b;\n" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Done — sum is implemented.")]),
    ]);
    await session.prompt("implement sum");
    assert.match(read(cwd, "src/sum.js")!, /a - b/);
    assert.equal(faux.state.callCount, 2);
  });

  test("with sentinel a red gate sends the agent back until the checks pass", async () => {
    const cwd = fixture();
    const { session, faux } = await startSession(cwd, true);
    let sawContract = false;
    let sawFailure = false;
    faux.setResponses([
      (context) => {
        sawContract = /## pi-sentinel/.test(context.systemPrompt ?? "");
        return fauxAssistantMessage([fauxToolCall("write", { path: "src/sum.js", content: "export const sum = (a, b) => a - b;\n" })], { stopReason: "toolUse" });
      },
      fauxAssistantMessage([fauxText("Done — sum is implemented.")]),
      (context) => {
        sawFailure = /Not done yet: "test" failed[\s\S]*expected 3, got -1/.test(texts(context.messages));
        return fauxAssistantMessage([fauxToolCall("write", { path: "src/sum.js", content: "export const sum = (a, b) => a + b;\n" })], { stopReason: "toolUse" });
      },
      fauxAssistantMessage([fauxText("Fixed the sign; the test passes now.")]),
    ]);

    await session.prompt("implement sum");

    assert.equal(sawContract, true, "the working rules reached the system prompt");
    assert.equal(sawFailure, true, "the model saw the pruned failure");
    assert.equal(faux.state.callCount, 4, "exactly one repair round");
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.match(read(cwd, "src/sum.js")!, /a \+ b/);
  });

  test("the loop is bounded when the model cannot fix it", async () => {
    const cwd = fixture();
    write(cwd, "sentinel.config.ts", `export default { checks: { afterEdit: [], beforeDone: [{ name: "test", cmd: "node check.mjs" }] }, repair: { maxAttempts: 1 } };`);
    const { session, faux } = await startSession(cwd, true);
    const broken = (n: number) =>
      fauxAssistantMessage([fauxToolCall("write", { path: "src/sum.js", content: `export const sum = (a, b) => a - b; // ${n}\n` })], { stopReason: "toolUse" });
    faux.setResponses([broken(1), fauxAssistantMessage("done"), broken(2), fauxAssistantMessage("done again")]);

    await session.prompt("implement sum");

    assert.equal(faux.state.callCount, 4, "one repair round, then sentinel stops");
    assert.equal(faux.getPendingResponseCount(), 0);
  });
});

