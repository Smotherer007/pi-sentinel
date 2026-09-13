import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import {
  MAX_DIFF_CELLS,
  countLineDiff,
  evaluatePolicy,
  formatPolicyReport,
  relativePath,
  sensitiveKind,
  splitLines,
} from "../src/clients/policy.ts";
import type { PolicyChange } from "../src/clients/policy.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { PolicyConfig } from "../src/types.ts";

const CWD = "/home/u/proj";

const policy = (overrides: Partial<PolicyConfig> = {}): PolicyConfig => ({
  ...DEFAULT_CONFIG.policy,
  ...overrides,
});

/** Build the absolute-path view index.ts hands to `evaluatePolicy`. */
function change(
  rel: string,
  before: string | null,
  after: string | null,
  beforeKnown = true,
): PolicyChange {
  return { path: path.join(CWD, rel), before, beforeKnown, after };
}

describe("splitLines", () => {
  test("drops the single trailing newline artefact", () => {
    assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
    assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
  });

  test("empty and absent content have no lines", () => {
    assert.deepEqual(splitLines(""), []);
    assert.deepEqual(splitLines(null), []);
  });

  test("keeps blank lines inside the file", () => {
    assert.deepEqual(splitLines("a\n\nb\n"), ["a", "", "b"]);
  });
});

describe("countLineDiff", () => {
  test("identical content is no change", () => {
    assert.deepEqual(countLineDiff(["a", "b"], ["a", "b"]), { added: 0, removed: 0 });
  });

  test("a pure addition", () => {
    assert.deepEqual(countLineDiff(["a"], ["a", "b"]), { added: 1, removed: 0 });
  });

  test("a pure deletion", () => {
    assert.deepEqual(countLineDiff(["a", "b"], ["a"]), { added: 0, removed: 1 });
  });

  test("a modified line counts once in both directions", () => {
    assert.deepEqual(countLineDiff(["a", "b", "c"], ["a", "x", "c"]), { added: 1, removed: 1 });
  });

  test("an empty side is a whole-file change", () => {
    assert.deepEqual(countLineDiff([], ["a", "b"]), { added: 2, removed: 0 });
    assert.deepEqual(countLineDiff(["a", "b"], []), { added: 0, removed: 2 });
  });

  test("past the DP budget it over-reports rather than under-reports", () => {
    // A policy whose job is to stop large changes must never under-count one.
    const n = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 10;
    const before = Array.from({ length: n }, (_, i) => `before-${i}`);
    const after = Array.from({ length: n }, (_, i) => `after-${i}`);
    assert.deepEqual(countLineDiff(before, after), { added: n, removed: n });
  });
});

describe("sensitiveKind", () => {
  test("recognises CI workflows at any depth", () => {
    assert.equal(sensitiveKind(".github/workflows/ci.yml", policy()), "workflow");
    assert.equal(sensitiveKind("nested/.github/workflows/release.yml", policy()), "workflow");
    assert.equal(sensitiveKind("src/.github/workflow.ts", policy()), null);
  });

  test("recognises dependency manifests and lockfiles by basename", () => {
    assert.equal(sensitiveKind("package.json", policy()), "package");
    assert.equal(sensitiveKind("packages/app/package.json", policy()), "package");
    assert.equal(sensitiveKind("package-lock.json", policy()), "lockfile");
    assert.equal(sensitiveKind("pnpm-lock.yaml", policy()), "lockfile");
    assert.equal(sensitiveKind("sub/dir/go.sum", policy()), "lockfile");
  });

  test("an ordinary source file is not sensitive", () => {
    assert.equal(sensitiveKind("src/index.ts", policy()), null);
  });

  test("custom globs are matched project-relative, not against the absolute path", () => {
    // Regression: matching the absolute path made every anchored pattern miss.
    const conf = policy({ sensitivePaths: ["secrets/**", "**/*.pem"] });
    assert.equal(sensitiveKind("secrets/prod.env", conf), "custom");
    assert.equal(sensitiveKind("certs/server.pem", conf), "custom");
    assert.equal(sensitiveKind("src/app.ts", conf), null);
  });
});

describe("relativePath", () => {
  test("returns a project-relative path inside the project", () => {
    assert.equal(relativePath(CWD, path.join(CWD, "src/a.ts")), "src/a.ts");
  });

  test("falls back to the normalised absolute path outside the project", () => {
    assert.equal(relativePath(CWD, "/elsewhere/b.ts"), "/elsewhere/b.ts");
  });
});

describe("evaluatePolicy", () => {
  test("a small, ordinary change passes", () => {
    const report = evaluatePolicy([change("src/a.ts", "x\n", "x\ny\n")], policy(), CWD);
    assert.equal(report.passed, true);
    assert.deepEqual(report.violations, []);
    assert.equal(report.stats.changedFiles, 1);
    assert.equal(report.stats.modifiedFiles, 1);
    assert.equal(report.stats.addedLines, 1);
  });

  test("no changes means no stats and no violations", () => {
    const report = evaluatePolicy([change("src/a.ts", "x\n", "x\n")], policy(), CWD);
    assert.equal(report.passed, true);
    assert.equal(report.stats.changedFiles, 0);
    assert.equal(report.stats.addedLines, 0);
  });

  test("counts added, modified and deleted files separately", () => {
    const report = evaluatePolicy(
      [
        change("src/new.ts", null, "a\n"),
        change("src/old.ts", "a\n", null),
        change("src/edit.ts", "a\n", "b\n"),
      ],
      policy(),
      CWD,
    );
    assert.equal(report.stats.changedFiles, 3);
    assert.equal(report.stats.addedFiles, 1);
    assert.equal(report.stats.deletedFiles, 1);
    assert.equal(report.stats.modifiedFiles, 1);
  });

  test("maxChangedFiles fires above the limit and 0 means unlimited", () => {
    const changes = [change("a.ts", "1\n", "2\n"), change("b.ts", "1\n", "2\n")];

    const limited = evaluatePolicy(changes, policy({ maxChangedFiles: 1 }), CWD);
    assert.equal(limited.passed, false);
    assert.equal(limited.violations[0].rule, "maxChangedFiles");
    assert.match(limited.violations[0].message, /2 files were changed/);

    assert.equal(evaluatePolicy(changes, policy({ maxChangedFiles: 0 }), CWD).passed, true);
  });

  test("maxAddedLines fires above the limit and 0 means unlimited", () => {
    const big = change("a.ts", "", "1\n2\n3\n");

    const limited = evaluatePolicy([big], policy({ maxAddedLines: 2 }), CWD);
    assert.equal(limited.passed, false);
    assert.equal(limited.violations[0].rule, "maxAddedLines");
    assert.match(limited.violations[0].message, /3 lines were added/);

    assert.equal(evaluatePolicy([big], policy({ maxAddedLines: 0 }), CWD).passed, true);
  });

  test("a disallowed workflow is one violation naming the file", () => {
    const report = evaluatePolicy(
      [change(".github/workflows/ci.yml", "a\n", "b\n")],
      policy({ allowWorkflowChanges: false }),
      CWD,
    );
    assert.equal(report.passed, false);
    assert.equal(report.violations.length, 1);
    assert.equal(report.violations[0].rule, "allowWorkflowChanges");
    assert.deepEqual(report.violations[0].paths, [".github/workflows/ci.yml"]);
    assert.equal(report.stats.sensitive[0].kind, "workflow");
  });

  test("package and lockfile changes can be denied independently", () => {
    const conf = policy({ allowPackageChanges: false, allowLockfileChanges: true });
    const report = evaluatePolicy(
      [change("package.json", "a\n", "b\n"), change("package-lock.json", "a\n", "b\n")],
      conf,
      CWD,
    );
    assert.equal(report.violations.length, 1);
    assert.equal(report.violations[0].rule, "allowPackageChanges");
    // Allowed sensitive files are still reported in the stats.
    assert.equal(report.stats.sensitive.length, 2);
  });

  test("allowed sensitive changes never violate even with the rule on", () => {
    const report = evaluatePolicy(
      [change("package.json", "a\n", "b\n")],
      policy({ allowPackageChanges: true }),
      CWD,
    );
    assert.equal(report.passed, true);
    assert.equal(report.stats.sensitive[0].kind, "package");
  });

  test("a custom sensitive path is always forbidden", () => {
    const conf = policy({ sensitivePaths: ["secrets/**"] });
    const report = evaluatePolicy([change("secrets/prod.env", "a\n", "b\n")], conf, CWD);
    assert.equal(report.passed, false);
    assert.equal(report.violations[0].rule, "sensitivePaths");
    assert.deepEqual(report.violations[0].paths, ["secrets/prod.env"]);
  });

  test("an unobserved pre-state still counts as a change", () => {
    // A bash-only edit reports no pre-state; dropping it would let a shell
    // deletion slip past the policy.
    const report = evaluatePolicy(
      [change("package.json", null, null, false)],
      policy({ allowPackageChanges: false }),
      CWD,
    );
    assert.equal(report.stats.changedFiles, 1);
    assert.equal(report.passed, false);
    assert.equal(report.violations[0].rule, "allowPackageChanges");
  });

  test("binary content is counted as a file but not as lines", () => {
    const report = evaluatePolicy([change("logo.png", "a\0b", "a\0c")], policy(), CWD);
    assert.equal(report.stats.changedFiles, 1);
    assert.equal(report.stats.addedLines, 0);
    assert.equal(report.stats.removedLines, 0);
  });
});

describe("formatPolicyReport", () => {
  test("names the counts, every violation and the way out", () => {
    const report = evaluatePolicy(
      [change("package.json", "a\n", "b\n")],
      policy({ allowPackageChanges: false }),
      CWD,
    );
    const text = formatPolicyReport(report, CWD);
    assert.match(text, /Change policy violation/);
    assert.match(text, /files changed: 1/);
    assert.ok(text.includes("package.json"));
    assert.match(text, /sentinel_rollback/);
    assert.ok(text.includes(CWD));
  });
});
