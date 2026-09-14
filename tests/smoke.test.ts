import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createRuntime } from "../src/runtime.ts";
import { createSentinelVerifyTool } from "../src/tools/sentinel-verify.ts";
import { createSentinelRollbackTool } from "../src/tools/sentinel-rollback.ts";
import { createSentinelRewindTool } from "../src/tools/sentinel-rewind.ts";
import { createSentinelStatusTool } from "../src/tools/sentinel-status.ts";
import { PipelineRunner } from "../src/clients/pipeline-runner.ts";
import { GitClient } from "../src/clients/git-client.ts";
import { CheckpointStore } from "../src/clients/checkpoints.ts";
import { SnapshotStore } from "../src/clients/snapshot.ts";
import { FailureEscalationTracker } from "../src/clients/escalation.ts";
import { stateHashOf, hashFile } from "../src/clients/evidence.ts";
import { changedPaths } from "../src/clients/workspace.ts";
import { applyOutputCap, preview } from "../src/clients/spill.ts";
import { buildFailureFeedback } from "../src/formatting/feedback.ts";
import { revisionContractText } from "../src/prompt/contract.ts";
import { impactOf, hasGraph } from "../src/clients/mindplace.ts";
import { snapshotFile, restoreFileSnapshot } from "../src/clients/snapshot.ts";

describe("smoke", () => {
  const runtime = createRuntime();

  test("imports resolve", () => {
    assert.ok(PipelineRunner, "PipelineRunner should be importable");
    assert.ok(GitClient, "GitClient should be importable");
    assert.equal(createSentinelVerifyTool(runtime).name, "sentinel_verify");
    assert.equal(createSentinelRollbackTool(runtime).name, "sentinel_rollback");
    assert.equal(createSentinelRewindTool(runtime).name, "sentinel_rewind");
    assert.equal(createSentinelStatusTool(runtime).name, "sentinel_status");
  });

  test("every capability module is importable", () => {
    assert.equal(typeof CheckpointStore, "function");
    assert.equal(typeof SnapshotStore, "function");
    assert.equal(typeof FailureEscalationTracker, "function");
    assert.equal(runtime.checkpoints.isCapturing, false, "a fresh runtime captures nothing");
    assert.equal(typeof stateHashOf, "function");
    assert.equal(typeof hashFile, "function");
    assert.equal(typeof changedPaths, "function");
    assert.equal(typeof applyOutputCap, "function");
    assert.equal(typeof preview, "function");
    assert.equal(typeof buildFailureFeedback, "function");
    assert.equal(typeof revisionContractText, "function");
    assert.equal(typeof impactOf, "function");
    assert.equal(typeof hasGraph, "function");
    assert.equal(typeof snapshotFile, "function");
    assert.equal(typeof restoreFileSnapshot, "function");
  });

  test("every tool declares a description and schema", () => {
    const tools = [
      createSentinelVerifyTool(runtime),
      createSentinelRollbackTool(runtime),
      createSentinelRewindTool(runtime),
      createSentinelStatusTool(runtime),
    ];
    for (const tool of tools) {
      assert.ok(tool.description.length > 20, `${tool.name} needs a usable description`);
      assert.ok(tool.parameters, `${tool.name} needs a parameter schema`);
    }
  });

  test("PipelineRunner constructs", () => {
    const runner = new PipelineRunner(runtime.config);
    assert.ok(runner);
  });

  test("GitClient.rollback handles non-repo gracefully", () => {
    const result = GitClient.rollback("/tmp");
    assert.equal(result.success, false);
    assert.ok(result.message.includes("not a git repository") || result.message.includes("rollback"));
  });
});
