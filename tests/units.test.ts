import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { beforeGate, initialRepairState, onRed } from "../src/repair.ts";
import { Coalescer } from "../src/coalesce.ts";
import { detectChecks } from "../src/detect.ts";
import { ConfigLoader, DEFAULT_CONFIG, configProblems, resolveChecks, resolveConfig } from "../src/config.ts";
import { dependentsOf, hasGraph } from "../src/mindplace.ts";
import { contractText } from "../src/contract.ts";
import { capOutput, repairPrompt } from "../src/format/feedback.ts";
import { matchesGlob } from "../src/glob.ts";
import { tempDir, write } from "./helpers.ts";

describe("repair decisions", () => {
  test("nothing changed and nothing open: skip the gate", () => {
    assert.deepEqual(beforeGate(initialRepairState(), 0), { action: "skip" });
  });

  test("a repair round that changed nothing stops the loop", () => {
    assert.deepEqual(beforeGate({ attempts: 1 }, 0), { action: "stop", reason: "no-progress" });
  });

  test("changes always run the gate", () => {
    assert.deepEqual(beforeGate({ attempts: 2 }, 3), { action: "check" });
  });

  test("red: repair until the budget is spent, then stop and reset", () => {
    const options = { enabled: true, maxAttempts: 2 };
    const first = onRed(initialRepairState(), options);
    assert.equal(first.action, "repair");
    const second = onRed(first.next, options);
    assert.equal(second.action, "repair");
    assert.equal(second.action === "repair" && second.attempt, 2);
    const third = onRed(second.next, options);
    assert.deepEqual(third, { action: "stop", reason: "exhausted", next: { attempts: 0 } });
  });

  test("red with repair disabled stops immediately", () => {
    assert.equal(onRed(initialRepairState(), { enabled: false, maxAttempts: 3 }).action, "stop");
  });
});

describe("Coalescer", () => {
  test("requests during a run share one follow-up run with all their files", async () => {
    const calls: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const c = new Coalescer<number>();
    const exec = async (files: string[]) => {
      calls.push(files);
      if (calls.length === 1) await gate;
      return calls.length;
    };
    const a = c.run("a", exec);
    const b = c.run("b", exec);
    const d = c.run("d", exec);
    release();
    assert.equal(await a, 1);
    assert.equal(await b, 2);
    assert.equal(await d, 2);
    assert.deepEqual(calls, [["a"], ["b", "d"]]);
  });
});

describe("detectChecks", () => {
  test("package scripts win and placeholders are ignored", () => {
    const cwd = tempDir();
    write(cwd, "package.json", JSON.stringify({ scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "echo \"Error: no test specified\" && exit 1" } }));
    const found = detectChecks(cwd);
    assert.deepEqual(found.afterEdit.map((s) => s.cmd), ["npm run typecheck"]);
    assert.deepEqual(found.beforeDone.map((s) => s.name), ["typecheck", "lint"]);
    assert.equal(found.beforeDone[1].warnOnly, true);
  });

  test("the package manager follows the lockfile", () => {
    const cwd = tempDir();
    write(cwd, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    write(cwd, "pnpm-lock.yaml", "");
    assert.deepEqual(detectChecks(cwd).beforeDone.map((s) => s.cmd), ["pnpm test"]);
  });

  test("tsconfig + typescript without a script uses tsc", () => {
    const cwd = tempDir();
    write(cwd, "package.json", JSON.stringify({ devDependencies: { typescript: "^5" } }));
    write(cwd, "tsconfig.json", "{}");
    assert.equal(detectChecks(cwd).afterEdit[0].cmd, "npx --no-install tsc --noEmit");
  });

  test("an empty directory proposes nothing", () => {
    const found = detectChecks(tempDir());
    assert.deepEqual([found.afterEdit, found.beforeDone], [[], []]);
  });

  test("go and rust projects", () => {
    const cwd = tempDir();
    write(cwd, "go.mod", "module x");
    write(cwd, "Cargo.toml", "[package]");
    const names = detectChecks(cwd).beforeDone.map((s) => s.name);
    assert.deepEqual(names.sort(), ["cargo-test", "go-test"]);
  });
});

describe("config", () => {
  test("defaults are not mutated by resolving", () => {
    const resolved = resolveConfig({ repair: { maxAttempts: 7 } });
    assert.equal(resolved.repair.maxAttempts, 7);
    assert.equal(resolved.repair.enabled, true);
    assert.equal(DEFAULT_CONFIG.repair.maxAttempts, 3);
  });

  test("explicit checks replace detection", () => {
    const cwd = tempDir();
    write(cwd, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    const checks = resolveChecks(resolveConfig({ checks: { afterEdit: [], beforeDone: [{ name: "x", cmd: "make check" }] } }), cwd);
    assert.deepEqual(checks.beforeDone.map((s) => s.cmd), ["make check"]);
    assert.equal(checks.detected, false);
  });

  test("problems are named", () => {
    const config = resolveConfig({ checks: { beforeDone: [{ name: "t", cmd: "x", timeoutMs: 0 }] } });
    assert.match(configProblems(config)[0], /timeoutMs/);
  });

  test("the loader reads sentinel.config.ts and picks up edits", async () => {
    const cwd = tempDir();
    const loader = new ConfigLoader();
    assert.equal((await loader.load(cwd)).source, null);
    write(cwd, "sentinel.config.ts", "export default { repair: { maxAttempts: 1 } };");
    assert.equal((await loader.load(cwd)).config.repair.maxAttempts, 1);
    write(cwd, "sentinel.config.ts", "export default { repair: { maxAttempts: 5 } };");
    assert.equal((await loader.load(cwd)).config.repair.maxAttempts, 5);
  });

  test("a broken config is reported, not thrown", async () => {
    const cwd = tempDir();
    write(cwd, "sentinel.config.ts", "export default {{{");
    const loaded = await new ConfigLoader().load(cwd);
    assert.equal(loaded.problems.length, 1);
    assert.equal(loaded.config.enabled, true);
  });
});

describe("mindplace graph", () => {
  test("names the files that depend on a change", () => {
    const cwd = tempDir();
    assert.equal(hasGraph(cwd), false);
    write(
      cwd,
      "graph-out/graph.json",
      JSON.stringify({
        nodes: [
          { id: "a", sourceFile: "src/util.ts" },
          { id: "a.fn", sourceFile: "src/util.ts" },
          { id: "b", sourceFile: "src/api.ts" },
          { id: "c", sourceFile: "src/cli.ts" },
        ],
        edges: [
          { source: "a", target: "a.fn", relation: "contains" },
          { source: "b", target: "a", relation: "imports" },
          { source: "c", target: "a.fn", relation: "calls" },
        ],
      }),
    );
    assert.deepEqual(dependentsOf(cwd, [path.join(cwd, "src/util.ts")]), [{ file: "src/util.ts", dependents: ["src/api.ts", "src/cli.ts"] }]);
    assert.deepEqual(dependentsOf(cwd, [path.join(cwd, "src/util.ts"), path.join(cwd, "src/api.ts")])[0].dependents, ["src/cli.ts"]);
  });
});

describe("feedback", () => {
  const result = {
    name: "test",
    cmd: "npm test",
    passed: false,
    exitCode: 1,
    durationMs: 1200,
    output: "not ok 1 - sums\n  AssertionError: expected 3, got 2\n    at src/sum.test.ts:4:10",
    warnOnly: false,
    timedOut: false,
    kind: "test-failure" as const,
  };

  test("the repair prompt names the step, the attempt, the trace and the dependents", () => {
    const text = repairPrompt({
      cwd: "/p",
      result,
      changed: ["/p/src/sum.ts"],
      attempt: 2,
      maxAttempts: 3,
      maxTraceLines: 10,
      dependents: [{ file: "src/sum.ts", dependents: ["src/report.ts"] }],
    });
    assert.match(text, /"test" failed \(failing test, exit 1/);
    assert.match(text, /Repair attempt 2\/3/);
    assert.match(text, /AssertionError/);
    assert.match(text, /src\/sum\.ts → src\/report\.ts/);
    assert.match(text, /do not weaken or delete the failing check/);
    assert.doesNotMatch(text, /last attempt/);
  });

  test("output over budget is capped and spilled", () => {
    const dir = tempDir();
    const text = capOutput("x".repeat(10_000), 100, dir, "test");
    assert.ok(text.length <= 400);
    assert.match(text, /full text: /);
  });

  test("contract mentions the gate and mindplace only when a graph exists", () => {
    const steps = [{ name: "typecheck", cmd: "tsc" }, { name: "lint", cmd: "eslint", warnOnly: true }];
    const withGraph = contractText({ beforeDone: steps, maxAttempts: 3, repair: true, graph: true });
    assert.match(withGraph, /sentinel runs `typecheck`\. If one fails/);
    assert.doesNotMatch(withGraph, /`lint`/);
    assert.match(withGraph, /mindplace_explain/);
    assert.doesNotMatch(contractText({ beforeDone: steps, maxAttempts: 3, repair: true, graph: false }), /mindplace/);
  });
});

test("globs", () => {
  assert.equal(matchesGlob("**/*.ts", "a.ts"), true);
  assert.equal(matchesGlob("**/*.ts", "src/x/a.ts"), true);
  assert.equal(matchesGlob("dist/**", "dist/a/b.js"), true);
  assert.equal(matchesGlob("*.ts", "src/a.ts"), false);
});
