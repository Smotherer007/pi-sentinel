import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SentinelVerifyTool } from "../src/tools/sentinel-verify.ts";
import { SentinelRollbackTool } from "../src/tools/sentinel-rollback.ts";
import { SentinelStatusTool } from "../src/tools/sentinel-status.ts";
import { PipelineRunner } from "../src/clients/pipeline-runner.ts";
import { GitClient } from "../src/clients/git-client.ts";

describe("smoke", () => {
  test("imports resolve", () => {
    assert.ok(PipelineRunner, "PipelineRunner should be importable");
    assert.ok(GitClient, "GitClient should be importable");
    assert.equal(SentinelVerifyTool.name, "sentinel_verify");
    assert.equal(SentinelRollbackTool.name, "sentinel_rollback");
    assert.equal(SentinelStatusTool.name, "sentinel_status");
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
