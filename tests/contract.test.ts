import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { revisionContractText, CONTRACT_MARKER } from "../src/prompt/contract.ts";
import { defineConfig } from "../src/config.ts";

describe("revisionContractText", () => {
  test("is active by default", () => {
    const text = revisionContractText(defineConfig({}));
    assert.ok(text.includes(CONTRACT_MARKER));
  });

  test("states the retry budget from the configuration", () => {
    const text = revisionContractText(defineConfig({ maxAutoRetries: 7 }));
    assert.ok(text.includes("At most 7 repair attempts"));
  });

  test("tells the agent not to revise code that already passes", () => {
    const text = revisionContractText(defineConfig({}));
    assert.ok(text.includes("A green check is evidence"));
  });

  test("forbids claiming a check without running it", () => {
    const text = revisionContractText(defineConfig({}));
    assert.ok(text.includes("Never state that a check passes"));
  });

  test("includes the regression rule when evidence tracking is on", () => {
    const on = revisionContractText(defineConfig({ trackVerifiedState: true }));
    const off = revisionContractText(defineConfig({ trackVerifiedState: false }));
    assert.ok(on.includes("regressed from a verified state"));
    assert.equal(off.includes("regressed from a verified state"), false);
  });

  test("warns about the restore when autoRollback is on", () => {
    const text = revisionContractText(defineConfig({ autoRollback: true }));
    assert.ok(text.includes("autoRollback is on"));
  });

  test("mentions the code graph only when impact focus is on", () => {
    assert.ok(revisionContractText(defineConfig({ impactAwareFocus: true })).includes("dependents"));
    assert.equal(
      revisionContractText(defineConfig({ impactAwareFocus: false })).includes("dependents"),
      false,
    );
  });

  test("returns nothing when disabled", () => {
    assert.equal(revisionContractText(defineConfig({ revisionContract: false })), "");
  });
});
