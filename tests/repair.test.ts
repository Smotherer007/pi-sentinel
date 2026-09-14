/**
 * Unit tests for the repair state machine and the background slot.
 *
 * These are the tests the extraction was for. Before, the stop conditions of
 * the repair loop could only be observed by driving the whole extension
 * against a fake host and reading the notification log; now they are a pure
 * function of (state, red turn), so each rule can be stated once, directly.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  autoFixOutcomeOf,
  bindingIsStale,
  decideRepair,
  deltaPathsOf,
  initialRepairState,
  readTraceBinding,
  scopeEscapeOf,
  traceIsStale,
  withPolicySignature,
  writeInScope,
} from "../src/clients/repair.ts";
import type { RepairInput } from "../src/clients/repair.ts";
import {
  EMPTY_BACKGROUND_SLOT,
  foldBackgroundRequest,
  mergeBackgroundRequests,
  takeBackgroundRequest,
} from "../src/clients/background.ts";
import type { BackgroundRequest } from "../src/clients/background.ts";

function input(overrides: Partial<RepairInput> = {}): RepairInput {
  return {
    recoverable: true,
    maxAttempts: 3,
    scopeGuard: "report",
    rollbackAfterExhaustion: false,
    step: "type-check",
    stateHash: "hash-1",
    paths: ["/p/a.ts"],
    ...overrides,
  };
}

describe("a fresh repair cycle", () => {
  test("spends nothing and opens no scope", () => {
    const state = initialRepairState();
    assert.equal(state.attempts, 0);
    assert.equal(state.injectedStateHash, null);
    assert.deepEqual(state.injectedPaths, []);
    assert.equal(state.startCheckpointId, null);
    assert.equal(state.scope, null);
    assert.equal(state.policySignature, null);
  });
});

describe("injecting an attempt", () => {
  test("charges one attempt and binds it to the code state", () => {
    const decision = decideRepair(initialRepairState(), input());

    assert.equal(decision.action, "inject");
    assert.deepEqual(decision.attempt, { attempt: 1, max: 3 });
    assert.equal(decision.state.attempts, 1);
    assert.equal(decision.state.injectedStateHash, "hash-1");
    assert.deepEqual(decision.state.injectedPaths, ["/p/a.ts"]);
    assert.equal(decision.reason, "type-check");
    assert.equal(decision.restoreCheckpointId, null);
  });

  test("remembers the checkpoint the cycle began at and never overwrites it", () => {
    // Exhaustion restores from the *first* turn of the cycle, so a later
    // attempt must not move that marker forward.
    const first = decideRepair(initialRepairState(), input({ checkpointId: "cp-1" }));
    const second = decideRepair(
      first.state,
      input({ stateHash: "hash-2", checkpointId: "cp-2" }),
    );

    assert.equal(first.state.startCheckpointId, "cp-1");
    assert.equal(second.state.startCheckpointId, "cp-1");
  });

  test("opens the scope from the files the first attempt was about, then never widens it", () => {
    const first = decideRepair(
      initialRepairState(),
      input({ paths: ["/p/a.ts", "/p/b.ts"] }),
    );
    const second = decideRepair(
      first.state,
      input({ stateHash: "hash-2", paths: ["/p/a.ts", "/p/c.ts"] }),
    );

    assert.deepEqual(first.state.scope, ["/p/a.ts", "/p/b.ts"]);
    assert.deepEqual(
      second.state.scope,
      ["/p/a.ts", "/p/b.ts"],
      "a widening attempt does not get to redefine the cycle",
    );
  });

  test("de-duplicates the scope, so it reads as a file list", () => {
    const decision = decideRepair(
      initialRepairState(),
      input({ paths: ["/p/a.ts", "/p/a.ts", "/p/b.ts"] }),
    );
    assert.deepEqual(decision.state.scope, ["/p/a.ts", "/p/b.ts"]);
  });

  test("keeps no scope while the guard is off", () => {
    const decision = decideRepair(initialRepairState(), input({ scopeGuard: "off" }));
    assert.equal(decision.state.scope, null);
  });
});

describe("the stop conditions", () => {
  test("an unchanged code state stops the loop instead of repeating it", () => {
    const first = decideRepair(initialRepairState(), input());
    const again = decideRepair(first.state, input());

    assert.equal(again.action, "stop-unchanged");
    assert.deepEqual(again.attempt, { attempt: 1, max: 3, stopped: true });
    assert.equal(again.reason, "identical code state");
    assert.equal(
      again.state.attempts,
      first.state.attempts,
      "a turn that said nothing new spends nothing",
    );
    assert.equal(
      again.state.stalledStateHash,
      first.state.injectedStateHash,
      "the stall is recorded rather than forgotten",
    );
  });

  test("a stalled cycle stays stalled", () => {
    // The regression this exists for: stopping used to clear the loop's memory,
    // so the next red turn found no hash to compare against and re-prompted —
    // stall, clear, re-prompt, stall. A live session turned `maxAttempts: 2`
    // into eight alternating cycles that way, and no unit test saw it because
    // none of them drove a *third* red turn over an unchanged tree.
    let state = initialRepairState();
    const actions: string[] = [];

    for (let turn = 0; turn < 6; turn += 1) {
      const decision = decideRepair(state, input());
      actions.push(decision.action);
      state = decision.state;
    }

    assert.deepEqual(
      actions,
      ["inject", "stop-unchanged", "none", "none", "none", "none"],
      "one attempt, one report, then silence",
    );
    assert.equal(
      actions.filter((a) => a === "inject").length,
      1,
      "the agent is woken exactly once for a state that never moves",
    );
  });

  test("a genuinely new state reopens the loop after a stall", () => {
    let state = decideRepair(initialRepairState(), input()).state;
    state = decideRepair(state, input()).state; // stalls here

    const moved = decideRepair(state, input({ stateHash: "moved" }));

    assert.equal(moved.action, "inject", "real progress is still worth an attempt");
    assert.equal(moved.state.stalledStateHash, null, "the old stall no longer describes anything");
    assert.equal(moved.state.attempts, 2, "and it is charged to the same cycle");
  });

  test("a stall is part of the cycle state, so a reset clears it", () => {
    let state = decideRepair(initialRepairState(), input()).state;
    state = decideRepair(state, input()).state;
    assert.notEqual(state.stalledStateHash, null);

    // Both production paths — a real user message and a green run — end a cycle
    // by rebuilding it from `initialRepairState`, which is where the stall
    // lives. That is the whole lift mechanism; the two paths themselves are
    // asserted end to end in `extension.test.ts` ("a green run clears a stall"),
    // because a unit test here could only assert a constant.
    assert.equal(initialRepairState().stalledStateHash, null);
    assert.equal(initialRepairState().injectedStateHash, null);
  });

  test("the budget bounds the loop", () => {
    let state = initialRepairState();
    const actions: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const decision = decideRepair(state, input({ stateHash: `hash-${i}` }));
      actions.push(decision.action);
      state = decision.state;
    }
    const spent = decideRepair(state, input({ stateHash: "hash-3" }));

    assert.deepEqual(actions, ["inject", "inject", "inject"]);
    assert.equal(spent.action, "exhausted");
    assert.equal(spent.attempt, undefined, "no continuation is offered once it is over");
    assert.equal(spent.reason, "recovery.maxAttempts=3");
  });

  test("a spent budget forgets where the cycle began", () => {
    const first = decideRepair(initialRepairState(), input({ checkpointId: "cp-1" }));
    const spent = decideRepair(
      first.state,
      input({ stateHash: "hash-2", maxAttempts: 1 }),
    );

    assert.equal(spent.action, "exhausted");
    assert.equal(spent.state.startCheckpointId, null);
  });

  test("rollbackAfterExhaustion asks the caller to restore the cycle's start", () => {
    const first = decideRepair(
      initialRepairState(),
      input({ checkpointId: "cp-1", maxAttempts: 2 }),
    );
    const spent = decideRepair(
      first.state,
      input({
        stateHash: "hash-2",
        maxAttempts: 1,
        rollbackAfterExhaustion: true,
      }),
    );

    assert.equal(spent.restoreCheckpointId, "cp-1");
    assert.equal(spent.state.startCheckpointId, null, "the marker is cleared either way");
  });

  test("without rollbackAfterExhaustion nothing is restored", () => {
    const first = decideRepair(initialRepairState(), input({ checkpointId: "cp-1" }));
    const spent = decideRepair(first.state, input({ stateHash: "hash-2", maxAttempts: 1 }));
    assert.equal(spent.restoreCheckpointId, null);
  });

  test("a failure that is not a repair target is reported, never repaired", () => {
    // A `warnOnly` step, a timeout, a missing binary: none of them say
    // anything about the code the agent wrote.
    const decision = decideRepair(initialRepairState(), input({ recoverable: false }));

    assert.equal(decision.action, "none");
    assert.equal(decision.attempt, undefined);
    assert.equal(decision.restoreCheckpointId, null);
    assert.equal(decision.state.attempts, 0);
    assert.equal(decision.state.injectedStateHash, null);
  });

  test("an unrecoverable failure does not spend a budget that is nearly gone", () => {
    let state = initialRepairState();
    for (let i = 0; i < 3; i += 1) {
      state = decideRepair(state, input({ stateHash: `hash-${i}` })).state;
    }
    const decision = decideRepair(state, input({ recoverable: false }));

    assert.equal(decision.action, "none", "not exhausted — the failure was never a target");
    assert.equal(decision.state.attempts, 3);
  });
});

describe("deltaPathsOf", () => {
  test("uses the files this turn changed", () => {
    assert.deepEqual(deltaPathsOf(initialRepairState(), ["/p/a.ts"]), ["/p/a.ts"]);
  });

  test("falls back to the previous attempt when the turn changed nothing", () => {
    // Without this the stop condition "the delta stopped changing" could never
    // fire: a no-op turn would hash the empty set and look like a new state.
    const state = decideRepair(initialRepairState(), input({ paths: ["/p/a.ts"] })).state;
    assert.deepEqual(deltaPathsOf(state, []), ["/p/a.ts"]);
  });

  test("stays empty when there is neither", () => {
    assert.deepEqual(deltaPathsOf(initialRepairState(), []), []);
  });
});

describe("scopeEscapeOf", () => {
  test("names the files a widening attempt touched", () => {
    const state = decideRepair(initialRepairState(), input({ paths: ["/p/a.ts"] })).state;
    assert.deepEqual(scopeEscapeOf(state, ["/p/a.ts", "/p/b.ts"], "report"), ["/p/b.ts"]);
  });

  test("says nothing while no cycle is open", () => {
    assert.deepEqual(scopeEscapeOf(initialRepairState(), ["/p/b.ts"], "report"), []);
  });

  test("says nothing while the guard is off", () => {
    const state = decideRepair(
      initialRepairState(),
      input({ paths: ["/p/a.ts"], scopeGuard: "report" }),
    ).state;
    assert.deepEqual(scopeEscapeOf(state, ["/p/b.ts"], "off"), []);
  });
});

describe("writeInScope", () => {
  const scoped = decideRepair(initialRepairState(), input({ paths: ["/p/a.ts"] })).state;

  test("block refuses a write outside the cycle", () => {
    assert.equal(writeInScope(scoped, "/p/b.ts", "block"), false);
  });

  test("block allows a write inside the cycle", () => {
    assert.equal(writeInScope(scoped, "/p/a.ts", "block"), true);
  });

  test("report and off let the write happen and name it afterwards", () => {
    assert.equal(writeInScope(scoped, "/p/b.ts", "report"), true);
    assert.equal(writeInScope(scoped, "/p/b.ts", "off"), true);
  });

  test("block allows anything while no cycle is open", () => {
    assert.equal(writeInScope(initialRepairState(), "/p/anything.ts", "block"), true);
  });
});

describe("traceIsStale", () => {
  test("a trace goes stale once its files change", () => {
    const state = decideRepair(initialRepairState(), input({ stateHash: "hash-1" })).state;
    assert.equal(traceIsStale(state, "hash-2"), true);
  });

  test("an unchanged tree leaves it current", () => {
    const state = decideRepair(initialRepairState(), input({ stateHash: "hash-1" })).state;
    assert.equal(traceIsStale(state, "hash-1"), false);
  });

  test("a state that never injected a trace is never stale", () => {
    assert.equal(traceIsStale(initialRepairState(), "anything"), false);
  });
});

describe("withPolicySignature", () => {
  test("remembers a violation and reopens it", () => {
    const remembered = withPolicySignature(initialRepairState(), "sig-1");
    assert.equal(remembered.policySignature, "sig-1");
    assert.equal(withPolicySignature(remembered, null).policySignature, null);
  });

  test("setting the same signature is a no-op, not a new object", () => {
    const remembered = withPolicySignature(initialRepairState(), "sig-1");
    assert.equal(withPolicySignature(remembered, "sig-1"), remembered);
  });
});

describe("autoFixOutcomeOf", () => {
  test("maps every action to its audit label", () => {
    assert.equal(autoFixOutcomeOf("inject"), "injected");
    assert.equal(autoFixOutcomeOf("stop-unchanged"), "stopped");
    assert.equal(autoFixOutcomeOf("exhausted"), "exhausted");
    assert.equal(autoFixOutcomeOf("none"), null, "a report is not an auto-fix decision");
  });
});

// ── Background slot (P5) ──────────────────────────────────────────────────

function request(overrides: Partial<BackgroundRequest> = {}): BackgroundRequest {
  return {
    cwd: "/p",
    ctx: { ui: {} as never },
    focusPaths: ["/p/a.ts"],
    changedPaths: ["/p/a.ts"],
    ...overrides,
  };
}

describe("the background slot", () => {
  test("the first request waits alone", () => {
    const slot = foldBackgroundRequest(EMPTY_BACKGROUND_SLOT, request());
    assert.deepEqual(slot.pending?.focusPaths, ["/p/a.ts"]);
  });

  test("a turn that arrives during a run is folded in, not dropped", () => {
    const slot = foldBackgroundRequest(
      foldBackgroundRequest(EMPTY_BACKGROUND_SLOT, request()),
      request({ focusPaths: ["/p/b.ts"], checkpointId: "cp-2" }),
    );
    assert.deepEqual(slot.pending?.focusPaths, ["/p/a.ts", "/p/b.ts"]);
  });

  test("taking the waiting request leaves an empty slot", () => {
    const filled = foldBackgroundRequest(EMPTY_BACKGROUND_SLOT, request());
    const taken = takeBackgroundRequest(filled);
    assert.deepEqual(taken.request?.focusPaths, ["/p/a.ts"]);
    assert.equal(taken.slot.pending, null);
  });

  test("taking from an empty slot yields nothing", () => {
    const taken = takeBackgroundRequest(EMPTY_BACKGROUND_SLOT);
    assert.equal(taken.request, null);
    assert.equal(taken.slot, EMPTY_BACKGROUND_SLOT);
  });

  test("the newer request wins for everything a restore would depend on", () => {
    // The older turn's checkpoint can no longer be restored to: the newer turn
    // has already written over its tree.
    const merged = mergeBackgroundRequests(
      request({ checkpointId: "cp-1", postHashes: new Map([["/p/a.ts", "old"]]) }),
      request({ checkpointId: "cp-2", postHashes: new Map([["/p/b.ts", "new"]]) }),
    );

    assert.equal(merged.checkpointId, "cp-2");
    assert.deepEqual(
      merged.postHashes,
      new Map([
        ["/p/a.ts", "old"],
        ["/p/b.ts", "new"],
      ]),
    );
  });

  test("the union of both scopes is what gets verified", () => {
    const merged = mergeBackgroundRequests(
      request({
        focusPaths: ["/p/a.ts", "/p/shared.ts"],
        changedPaths: ["/p/a.ts"],
        mutablePaths: ["/p/a.ts"],
      }),
      request({
        focusPaths: ["/p/b.ts", "/p/shared.ts"],
        changedPaths: ["/p/b.ts"],
        mutablePaths: ["/p/b.ts"],
      }),
    );

    assert.deepEqual(merged.focusPaths, ["/p/a.ts", "/p/shared.ts", "/p/b.ts"]);
    assert.deepEqual(merged.changedPaths, ["/p/a.ts", "/p/b.ts"]);
    assert.deepEqual(merged.mutablePaths, ["/p/a.ts", "/p/b.ts"]);
  });
});

describe("trace bindings: does a delivered payload still describe the tree?", () => {
  const hashOf = (paths: readonly string[]) => `hash(${[...paths].sort().join(",")})`;

  test("a message that carries its binding is read back exactly", () => {
    const binding = readTraceBinding({ stateHash: "abc", paths: ["/p/a.ts"], attempt: 1 });
    assert.deepEqual(binding, { stateHash: "abc", paths: ["/p/a.ts"] });
  });

  test("messages without a binding fall through to the caller's old behaviour", () => {
    assert.equal(readTraceBinding({ resolved: true }), null);
    assert.equal(readTraceBinding({ stateHash: "abc" }), null); // no paths
    assert.equal(readTraceBinding({ paths: ["/p/a.ts"] }), null); // no hash
    assert.equal(readTraceBinding({ stateHash: "abc", paths: [] }), null);
    assert.equal(readTraceBinding({ stateHash: "abc", paths: [42, null] }), null);
    assert.equal(readTraceBinding(undefined), null);
    assert.equal(readTraceBinding("nonsense"), null);
  });

  test("a moved state is stale, an unmoved one is not", () => {
    const binding = { stateHash: hashOf(["/p/a.ts"]), paths: ["/p/a.ts"] };
    assert.equal(bindingIsStale(binding, hashOf), false);
    // The file changed after the payload was composed: the payload describes a
    // tree that no longer exists, which is exactly what must be said out loud
    // at delivery time instead of presenting it as current.
    assert.equal(bindingIsStale({ ...binding, stateHash: "older" }, hashOf), true);
  });

  test("no binding means no claim either way", () => {
    assert.equal(bindingIsStale(null, hashOf), false);
  });

  test("a failing hash never turns into a stale claim", () => {
    const exploding = () => {
      throw new Error("unreadable");
    };
    assert.equal(bindingIsStale({ stateHash: "abc", paths: ["/p/a.ts"] }, exploding), false);
  });
});
