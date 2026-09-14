import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyFailure,
  failureAdvice,
  failureHeadline,
  failureSignature,
  summarizeFailure,
} from "../src/formatting/classify.ts";

const base = { stepName: "check", cmd: "check", exitCode: 1, output: "" };

describe("a step the project cannot run is not a code failure", () => {
  // The case behind this: a plain Node 26 project with no `test` script and no
  // tsconfig. `npm test` exits 1 with "Missing script", which used to classify as
  // a *code* failure — so sentinel reported a red turn after every edit and spent
  // repair attempts on a diff nobody had broken. None of these outputs is
  // evidence about the code, so none of them may roll anything back or re-prompt
  // the agent.
  const cases: Array<[string, string]> = [
    ["npm", 'npm ERR! Missing script: "test"\nnpm ERR! To see a list of scripts, run:\n'],
    ["pnpm", " ERR_PNPM_NO_SCRIPT  Missing script: test\n"],
    ["yarn", 'error: Couldn\'t find a script named "test".\n'],
    ["vitest, no files", "No test files found, exiting with code 1\n"],
  ];

  for (const [name, output] of cases) {
    test(`${name} is an environment error`, () => {
      assert.equal(
        classifyFailure({ stepName: "unit-tests", cmd: "npm test", exitCode: 1, output }),
        "environment-error",
      );
    });
  }

  test("a real test failure is still a test failure", () => {
    // The probes must not swallow the thing they exist to report.
    assert.equal(
      classifyFailure({
        stepName: "unit-tests",
        cmd: "npm test",
        exitCode: 1,
        output: "FAIL src/a.test.ts\n  ● adds → expected 1 to be 2\n",
      }),
      "test-failure",
    );
  });
});

describe("classifyFailure", () => {
  test("a timeout wins over everything in the output", () => {
    const kind = classifyFailure({
      ...base,
      timedOut: true,
      output: "error TS2322: this would otherwise be a type error",
    });
    assert.equal(kind, "timeout");
  });

  test("exit code 124 is a timeout even without the flag", () => {
    assert.equal(classifyFailure({ ...base, exitCode: 124 }), "timeout");
  });

  test("detects a missing command", () => {    assert.equal(
      classifyFailure({ ...base, exitCode: 127, output: "sh: npx: command not found" }),
      "command-not-found",
    );
    assert.equal(
      classifyFailure({ ...base, output: "'tsc' is not recognized as an internal or external command" }),
      "command-not-found",
    );
  });

  test("detects environment failures", () => {
    assert.equal(
      classifyFailure({ ...base, output: "npm ERR! network request to registry failed" }),
      "environment-error",
    );
    assert.equal(classifyFailure({ ...base, output: "Error: EACCES: permission denied" }), "environment-error");
    assert.equal(
      classifyFailure({ ...base, output: "[sentinel] type-check: cwd \"../x\" escapes the project root" }),
      "environment-error",
    );
  });

  test("detects type errors", () => {
    assert.equal(
      classifyFailure({
        ...base,
        stepName: "type-check",
        output: "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      }),
      "type-error",
    );
  });

  test("detects build failures", () => {
    assert.equal(classifyFailure({ ...base, output: "error[E0432]: unresolved import `foo`" }), "build-failure");
    assert.equal(classifyFailure({ ...base, output: "** BUILD FAILED **" }), "build-failure");
    assert.equal(classifyFailure({ ...base, output: "error MSB3073: The command exited with code 1" }), "build-failure");
  });

  test("detects lint failures", () => {
    assert.equal(
      classifyFailure({ ...base, stepName: "linter", output: "✖ 4 problems (3 errors, 1 warning)" }),
      "lint-error",
    );
    assert.equal(classifyFailure({ ...base, output: "eslint found issues" }), "lint-error");
  });

  test("detects test failures", () => {
    assert.equal(classifyFailure({ ...base, output: "  ✖ adds two numbers" }), "test-failure");
    assert.equal(classifyFailure({ ...base, output: "AssertionError: 1 == 2" }), "test-failure");
    assert.equal(classifyFailure({ ...base, output: "Tests:       2 failed, 3 passed, 5 total" }), "test-failure");
  });

  test("falls back to the step name when the output is uninformative", () => {
    assert.equal(classifyFailure({ ...base, stepName: "unit-tests" }), "test-failure");
    assert.equal(classifyFailure({ ...base, stepName: "eslint --quiet" }), "lint-error");
    assert.equal(classifyFailure({ ...base, stepName: "cargo build" }), "build-failure");
  });

  test("says unknown rather than guessing", () => {
    assert.equal(classifyFailure(base), "unknown");
  });
});

describe("failureHeadline / failureAdvice / summarizeFailure", () => {
  test("labels every kind", () => {
    for (const kind of [
      "type-error",
      "lint-error",
      "test-failure",
      "build-failure",
      "timeout",
      "command-not-found",
      "environment-error",
      "unknown",
    ] as const) {
      assert.ok(failureHeadline(kind).length > 0);
    }
  });

  test("tells the agent not to rewrite code for infrastructure failures", () => {
    assert.ok(failureAdvice("timeout")?.includes("not a code error"));
    assert.ok(failureAdvice("command-not-found")?.includes("do not change application code"));
    assert.ok(failureAdvice("environment-error")?.includes("not the code"));
  });

  test("gives no extra advice for a plain type error (the generic advice suffices)", () => {
    assert.equal(failureAdvice("type-error"), null);
    assert.equal(failureAdvice("test-failure"), null);
  });

  test("summarises a timeout without needing output", () => {
    assert.ok(summarizeFailure("timeout", "").includes("timeout"));
  });

  test("summarises the first valuable line and truncates it", () => {
    const summary = summarizeFailure("type-error", "npm notice x\nerror TS2322: boom", 20);
    assert.ok(summary.startsWith("error TS2322"));
    assert.ok(summary.length <= 20);
  });
});

describe("failureSignature", () => {
  test("is stable for the same error", () => {
    const a = failureSignature("type-error", "error TS2322: boom");
    const b = failureSignature("type-error", "error TS2322: boom");
    assert.equal(a, b);
  });

  test("differs for a different error or kind", () => {
    assert.notEqual(
      failureSignature("type-error", "error TS2322: boom"),
      failureSignature("type-error", "error TS9999: other"),
    );
    assert.notEqual(
      failureSignature("type-error", "error TS2322: boom"),
      failureSignature("test-failure", "error TS2322: boom"),
    );
  });

  test("ignores surrounding noise", () => {
    const noisy = "npm notice Downloading\nerror TS2322: boom\nnpm notice done";
    assert.equal(failureSignature("type-error", noisy), failureSignature("type-error", "error TS2322: boom"));
  });
});
