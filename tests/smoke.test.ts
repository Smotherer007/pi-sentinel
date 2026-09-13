import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SentinelVerifyTool } from "../src/tools/sentinel-verify.ts";
import { SentinelRollbackTool } from "../src/tools/sentinel-rollback.ts";
import { SentinelRewindTool } from "../src/tools/sentinel-rewind.ts";
import { SentinelStatusTool } from "../src/tools/sentinel-status.ts";
import { PipelineRunner } from "../src/clients/pipeline-runner.ts";
import { GitClient } from "../src/clients/git-client.ts";
import { CheckpointStore, checkpoints } from "../src/clients/checkpoints.ts";
import { stateHashOf, hashFile } from "../src/clients/evidence.ts";
import { changedPaths } from "../src/clients/workspace.ts";
import { applyOutputCap, preview } from "../src/clients/spill.ts";
import { buildFailureFeedback } from "../src/formatting/feedback.ts";
import { revisionContractText } from "../src/prompt/contract.ts";
import { impactOf, hasGraph } from "../src/clients/mindplace.ts";
import { snapshotFile, restoreFileSnapshot } from "../src/clients/snapshot.ts";

describe("smoke", () => {
  test("imports resolve", () => {
    assert.ok(PipelineRunner, "PipelineRunner should be importable");
    assert.ok(GitClient, "GitClient should be importable");
    assert.equal(SentinelVerifyTool.name, "sentinel_verify");
    assert.equal(SentinelRollbackTool.name, "sentinel_rollback");
    assert.equal(SentinelRewindTool.name, "sentinel_rewind");
    assert.equal(SentinelStatusTool.name, "sentinel_status");
  });

  test("every capability module is importable", () => {
    assert.equal(typeof CheckpointStore, "function");
    assert.ok(checkpoints, "shared checkpoint instance");
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
    for (const tool of [SentinelVerifyTool, SentinelRollbackTool, SentinelRewindTool, SentinelStatusTool]) {
      assert.ok(tool.description.length > 20, `${tool.name} needs a usable description`);
      assert.ok(tool.parameters, `${tool.name} needs a parameter schema`);
    }
  });

  test("PipelineRunner constructs", () => {
    const runner = new PipelineRunner();
    assert.ok(runner);
  });

  test("GitClient.rollback handles non-repo gracefully", () => {
    const result = GitClient.rollback("/tmp");
    assert.equal(result.success, false);
    assert.ok(result.message.includes("not a git repository") || result.message.includes("rollback"));
  });
});
