/**
 * Unit tests for the doctor's classification.
 *
 * The report is pure over its facts, so every branch is testable without a
 * session, a repo or a clock. The two cases that matter most are the ones whose
 * absence cost real time in this project: a retired ctx (which makes every
 * branch that reports or resolves a result return early) and an outstanding
 * failure sitting next to a newer green run.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MIN_NODE,
  SLOW_TIMEOUT_MS,
  buildDoctorReport,
  formatDoctorReport,
} from "../src/formatting/doctor.ts";
import type { DoctorCheck, DoctorFacts } from "../src/formatting/doctor.ts";

const NOW = Date.parse("2026-09-14T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function facts(overrides: Partial<DoctorFacts> = {}): DoctorFacts {
  const base: DoctorFacts = {
    cwd: "/work/project",
    scopeKey: "project-abc123",
    nodeVersion: "26.5.0",
    session: {
      startedAtMs: NOW - 5 * 60_000,
      ctxRetired: false,
      backgroundRunning: false,
      backgroundPending: false,
      failureOutstanding: false,
      repairAttempts: 0,
      maxAttempts: 3,
      turnSnapshotFiles: 0,
    },
    config: {
      enabled: true,
      recoveryEnabled: true,
      autoRollback: false,
      revertOnRegression: false,
      bashEnabled: true,
      bashMode: "block",
      protectedPaths: 4,
      learnMutationTools: true,
      learnedTools: [],
      onFileMutation: [{ name: "type-check", timeoutMs: 60_000, files: 2, cacheable: true }],
      onTurnEnd: [{ name: "unit-tests", timeoutMs: 120_000, files: 0, cacheable: false }],
      missingCommands: [],
    },
    storage: {
      stateDir: ".pi/sentinel-state/project-abc123",
      writable: true,
      checkpointCount: 7,
      verifiedCount: 23,
      cacheEntries: 4,
    },
    git: { available: true, branch: "main", head: "e1c9812" },
    graph: { present: true, stale: false, builtAt: ago(60), nodes: 389, edges: 571 },
    runs: { lastRedAt: undefined, lastRedStep: undefined, lastGreenAt: undefined },
  };
  return { ...base, ...overrides };
}

function find(checks: readonly DoctorCheck[], fragment: string): DoctorCheck | undefined {
  return checks.find((check) => check.label.includes(fragment));
}

describe("doctor: a healthy project", () => {
  test("reports arms, safety and no failure", () => {
    const report = buildDoctorReport(facts(), NOW);
    assert.equal(report.failed, false);
    assert.equal(find(report.sentinel, "session ctx: live")?.level, "ok");
    assert.equal(find(report.sentinel, "hooks registered")?.level, "ok");
    assert.equal(find(report.sentinel, "git available")?.level, "ok");
    assert.equal(find(report.sentinel, "state directory writable")?.level, "ok");
    assert.equal(find(report.warnings, "code graph"), undefined);
    assert.equal(find(report.safety, "protected paths: 4")?.level, "ok");
    assert.equal(find(report.safety, "checkpoints: 7")?.level, "ok");
    assert.equal(find(report.safety, "verified files: 23")?.level, "ok");
  });

  test("the /sentinel test step has no files filter and is called out", () => {
    // unit-tests legitimately has none (it runs the whole suite at turn end) —
    // the warning is about *mutation* steps that run after every edit.
    const report = buildDoctorReport(facts(), NOW);
    assert.equal(find(report.warnings, "no files filter"), undefined);
  });
});

describe("doctor: the two checks that cost real time in this project", () => {
  test("a retired ctx is a failure, not a footnote", () => {
    const base = facts();
    const report = buildDoctorReport(
      { ...base, session: { ...base.session, ctxRetired: true } },
      NOW,
    );
    const check = find(report.sentinel, "session ctx: RETIRED");
    assert.equal(check?.level, "fail");
    assert.match(check!.detail ?? "", /Reload/);
    assert.equal(report.failed, true);
  });

  test("a red run newer than the newest green is an open failure", () => {
    const report = buildDoctorReport(
      {
        ...facts(),
        runs: { lastRedAt: ago(3), lastRedStep: "unit-tests", lastGreenAt: ago(40) },
        session: { ...facts().session, failureOutstanding: true, repairAttempts: 2 },
      },
      NOW,
    );
    const check = find(report.sentinel, "failure outstanding");
    assert.equal(check?.level, "warn");
    assert.match(check!.detail ?? "", /unit-tests/);
    assert.match(check!.detail ?? "", /repair 2\/3/);
  });

  test("a green run newer than the red says the code is fine and only the transcript is stale", () => {
    const report = buildDoctorReport(
      {
        ...facts(),
        runs: { lastRedAt: ago(60), lastRedStep: "unit-tests", lastGreenAt: ago(2) },
        session: { ...facts().session, failureOutstanding: true },
      },
      NOW,
    );
    const check = find(report.sentinel, "stale failure trace");
    assert.equal(check?.level, "warn");
    assert.match(check!.detail ?? "", /older than the newest green run/);
    // Not an "open failure": nothing is broken, the transcript is behind.
    assert.equal(find(report.sentinel, "failure outstanding"), undefined);
  });

  test("an answered failure is reported as answered", () => {
    const report = buildDoctorReport(
      { ...facts(), runs: { lastRedAt: ago(60), lastRedStep: "unit-tests", lastGreenAt: ago(2) } },
      NOW,
    );
    assert.equal(find(report.sentinel, "newest failure answered")?.level, "ok");
  });
});

describe("doctor: what is broken now", () => {
  test("an unsupported node version", () => {
    const report = buildDoctorReport(facts({ nodeVersion: "22.17.0" }), NOW);
    assert.equal(find(report.sentinel, "too old")?.level, "fail");
    assert.equal(report.failed, true);

    const floored = buildDoctorReport(facts({ nodeVersion: `${MIN_NODE.major}.${MIN_NODE.minor}.0` }), NOW);
    assert.equal(find(floored.sentinel, "supported")?.level, "ok");
  });

  test("a step whose program is not on PATH fails, because it can only fail", () => {
    const base = facts();
    const report = buildDoctorReport(
      {
        ...base,
        config: { ...base.config, missingCommands: ["mise", "biome"] },
      },
      NOW,
    );
    const check = find(report.sentinel, "not on PATH");
    assert.equal(check?.level, "fail");
    assert.match(check!.detail ?? "", /mise, biome/);
  });

  test("an unwritable state directory", () => {
    const base = facts();
    const report = buildDoctorReport(
      { ...base, storage: { ...base.storage, writable: false } },
      NOW,
    );
    assert.equal(find(report.sentinel, "not writable")?.level, "fail");
  });

  test("sentinel switched off", () => {
    const base = facts();
    const report = buildDoctorReport({ ...base, config: { ...base.config, enabled: false } }, NOW);
    assert.equal(find(report.sentinel, "sentinel disabled")?.level, "fail");
  });

  test("no pipeline steps at all is a warning, not a failure", () => {
    const base = facts();
    const report = buildDoctorReport(
      { ...base, config: { ...base.config, onFileMutation: [], onTurnEnd: [] } },
      NOW,
    );
    assert.equal(find(report.sentinel, "no pipeline steps")?.level, "warn");
    assert.equal(report.failed, false);
  });
});

describe("doctor: warnings", () => {
  test("a stale code graph carries its age", () => {
    const report = buildDoctorReport(
      { ...facts(), graph: { present: true, stale: true, builtAt: ago(12 * 24 * 60), nodes: 389, edges: 571 } },
      NOW,
    );
    const check = find(report.warnings, "code graph is 12 day(s) old");
    assert.equal(check?.level, "warn");
  });

  test("a graph made stale by an edit is not described as '0 days old'", () => {
    const report = buildDoctorReport(
      { ...facts(), graph: { present: true, stale: true, builtAt: ago(3), nodes: 389, edges: 571 } },
      NOW,
    );
    const check = find(report.warnings, "code graph is stale");
    assert.equal(check?.level, "warn");
    assert.equal(find(report.warnings, "0 day(s) old"), undefined);
  });

  test("a mutation step with no files filter runs after every edit", () => {
    const base = facts();
    const report = buildDoctorReport(
      {
        ...base,
        config: {
          ...base.config,
          onFileMutation: [{ name: "lint-all", timeoutMs: 30_000, files: 0, cacheable: false }],
        },
      },
      NOW,
    );
    assert.equal(find(report.warnings, '"lint-all" has no files filter')?.level, "warn");
  });

  test("a timeout past the recommended ceiling hides a hang", () => {
    const base = facts();
    const report = buildDoctorReport(
      {
        ...base,
        config: {
          ...base.config,
          onTurnEnd: [{ name: "e2e", timeoutMs: SLOW_TIMEOUT_MS + 1, files: 0, cacheable: true }],
        },
      },
      NOW,
    );
    assert.equal(find(report.warnings, "timeout exceeds")?.level, "warn");
  });

  test("a background run in flight is named, with the folded turn", () => {
    const base = facts();
    const report = buildDoctorReport(
      { ...base, session: { ...base.session, backgroundRunning: true, backgroundPending: true } },
      NOW,
    );
    const check = find(report.warnings, "background check in flight");
    assert.equal(check?.level, "warn");
    assert.match(check!.detail ?? "", /folded/);
  });
});

describe("doctor: safety", () => {
  test("captured files mean a rollback is ready", () => {
    const base = facts();
    const report = buildDoctorReport(
      { ...base, session: { ...base.session, turnSnapshotFiles: 3 } },
      NOW,
    );
    assert.equal(find(report.safety, "rollback READY (3 file(s)")?.level, "ok");
  });

  test("with autoRollback off the cost of a bad turn is stated", () => {
    const report = buildDoctorReport(facts(), NOW);
    assert.equal(find(report.safety, "rollback off")?.level, "warn");
  });

  test("learned writers are shown, because learning is sentinel's own decision", () => {
    const base = facts();
    const learned = buildDoctorReport(
      { ...base, config: { ...base.config, learnedTools: ["replace", "insert"] } },
      NOW,
    );
    const check = find(learned.safety, "learned writers: 2");
    assert.equal(check?.level, "ok");
    assert.match(check!.detail ?? "", /replace, insert/);
    assert.match(check!.detail ?? "", /only refuses through the policy/);

    const none = buildDoctorReport(base, NOW);
    assert.ok(find(none.safety, "learned writers: none yet"));

    const off = buildDoctorReport(
      { ...base, config: { ...base.config, learnMutationTools: false } },
      NOW,
    );
    assert.ok(find(off.safety, "tool learning off"));
  });
});

describe("doctor: rendering", () => {
  test("sections, marks and heading survive into the text", () => {
    const base = facts();
    const report = buildDoctorReport(
      { ...base, session: { ...base.session, ctxRetired: true } },
      NOW,
    );
    const text = formatDoctorReport(report, base);
    assert.match(text, /^\[sentinel\] doctor — something is broken/m);
    assert.match(text, /\nSentinel\n──────────────/);
    assert.match(text, /\nWarnings\n/);
    assert.match(text, /\nSafety\n/);
    assert.match(text, /✗ session ctx: RETIRED/);
    assert.match(text, new RegExp(`node ${base.nodeVersion.replace(/\./g, "\\.")}`));
  });

  test("a healthy report says so", () => {
    const base = facts();
    assert.match(formatDoctorReport(buildDoctorReport(base, NOW), base), /armed and consistent/);
  });
});
