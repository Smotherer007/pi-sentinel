import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { VerificationQueue } from "../src/clients/queue.ts";
import { FailureEscalationTracker, shouldEscalate } from "../src/clients/escalation.ts";

/** A run function that records every batch and can be held open. */
function recorder<R>(result: (key: string, payloads: number[]) => R) {
  const calls: Array<{ key: string; payloads: number[] }> = [];
  const run = async (key: string, payloads: number[]) => {
    calls.push({ key, payloads });
    return result(key, payloads);
  };
  return { calls, run };
}

describe("VerificationQueue without debounce", () => {
  test("runs every request immediately", async () => {
    const { calls, run } = recorder((_key, payloads) => payloads.length);
    const queue = new VerificationQueue<string, number, number>(run, 0);

    assert.equal(await queue.enqueue("a", 1), 1);
    assert.equal(await queue.enqueue("a", 2), 1);
    assert.equal(calls.length, 2);
    assert.equal(queue.pendingCount(), 0);
  });
});

describe("VerificationQueue with debounce", () => {
  test("coalesces requests that arrive inside the window", async () => {
    const { calls, run } = recorder((_key, payloads) => payloads.join(","));
    const queue = new VerificationQueue<string, number, string>(run, 30);

    const first = queue.enqueue("a", 1);
    const second = queue.enqueue("a", 2);
    const third = queue.enqueue("a", 3);

    assert.equal(queue.pendingCount(), 1, "one batch is waiting");
    assert.equal(await first, "1,2,3");
    assert.equal(await second, "1,2,3");
    assert.equal(await third, "1,2,3");
    assert.equal(calls.length, 1, "a single run answers all three requests");
    assert.equal(queue.pendingCount(), 0);
  });

  test("does not batch different keys together", async () => {
    const { calls, run } = recorder((key, payloads) => `${key}:${payloads.length}`);
    const queue = new VerificationQueue<string, number, string>(run, 20);

    const [a, b] = await Promise.all([queue.enqueue("a", 1), queue.enqueue("b", 2)]);
    assert.equal(a, "a:1");
    assert.equal(b, "b:1");
    assert.equal(calls.length, 2);
  });

  test("the window is fixed, not extended by later arrivals", async () => {
    const { run } = recorder((_key, payloads) => payloads.length);
    const queue = new VerificationQueue<string, number, number>(run, 40);

    const started = Date.now();
    const first = queue.enqueue("a", 1);
    setTimeout(() => void queue.enqueue("a", 2), 20);
    await first;
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 200, `batch took ${elapsed}ms`);
  });

  test("runNow bypasses the window and takes waiting requests with it", async () => {
    const { calls, run } = recorder((_key, payloads) => payloads.join(","));
    const queue = new VerificationQueue<string, number, string>(run, 5000);

    const waiting = queue.enqueue("a", 1);
    const immediate = await queue.runNow("a", [99]);

    assert.equal(immediate, "1,99", "the waiting request is folded into the explicit run");
    assert.equal(await waiting, "1,99", "the waiting caller gets the same result");
    assert.equal(calls.length, 1);
    assert.equal(queue.pendingCount(), 0);
  });

  test("runNow on a key with nothing waiting runs alone", async () => {
    const { calls, run } = recorder((_key, payloads) => payloads.length);
    const queue = new VerificationQueue<string, number, number>(run, 5000);

    assert.equal(await queue.runNow("a", [7]), 1);
    assert.equal(calls.length, 1);
  });

  test("rejects every waiter when the run throws", async () => {
    const queue = new VerificationQueue<string, number, number>(async () => {
      throw new Error("boom");
    }, 10);

    const first = queue.enqueue("a", 1);
    const second = queue.enqueue("a", 2);
    await assert.rejects(first, /boom/);
    await assert.rejects(second, /boom/);
  });

  test("a changed window takes effect immediately", async () => {
    const { calls, run } = recorder((_key, payloads) => payloads.length);
    const queue = new VerificationQueue<string, number, number>(run, 5000);
    assert.equal(queue.debouncing, true);

    queue.setDebounce(0);
    assert.equal(queue.debouncing, false);
    assert.equal(await queue.enqueue("a", 1), 1);
    assert.equal(calls.length, 1);
  });

  test("cancel drops pending batches without running them", async () => {
    const { calls, run } = recorder((_key, payloads) => payloads.length);
    const queue = new VerificationQueue<string, number, number>(run, 10);
    void queue.enqueue("a", 1);
    queue.cancel();
    assert.equal(queue.pendingCount(), 0);
    await new Promise((done) => setTimeout(done, 30));
    assert.equal(calls.length, 0);
  });
});

describe("FailureEscalationTracker", () => {
  test("counts per signature", () => {
    const tracker = new FailureEscalationTracker();
    assert.equal(tracker.record("a"), 1);
    assert.equal(tracker.record("a"), 2);
    assert.equal(tracker.record("b"), 1);
    assert.equal(tracker.count("a"), 2);
    assert.equal(tracker.size(), 2);
  });

  test("reset forgets everything (a green run converged)", () => {
    const tracker = new FailureEscalationTracker();
    tracker.record("a");
    tracker.reset();
    assert.equal(tracker.count("a"), 0);
    assert.equal(tracker.size(), 0);
  });

  test("snapshot is sorted by count", () => {
    const tracker = new FailureEscalationTracker();
    tracker.record("a");
    tracker.record("b");
    tracker.record("b");
    const [first] = tracker.snapshot();
    assert.equal(first.signature, "b");
    assert.equal(first.count, 2);
  });
});

describe("shouldEscalate", () => {
  test("fires at the threshold", () => {
    assert.equal(shouldEscalate(2, 3), false);
    assert.equal(shouldEscalate(3, 3), true);
    assert.equal(shouldEscalate(4, 3), true);
  });

  test("a threshold of zero disables escalation", () => {
    assert.equal(shouldEscalate(99, 0), false);
  });
});

describe("VerificationQueue timer lifetime", () => {
  test("a pending window keeps the process alive until the batch has run", () => {
    // Regression: the window timer was `unref`'d, so a process whose only
    // pending work was the window exited before it fired and the caller's
    // promise never settled (CI saw it as "cancelledByParent": 22 tests).
    const moduleUrl = new URL("../src/clients/queue.ts", import.meta.url).href;
    const script = [
      `import { VerificationQueue } from ${JSON.stringify(moduleUrl)};`,
      "const queue = new VerificationQueue(async (_key, payloads) => payloads.length, 40);",
      'process.stdout.write("resolved:" + (await queue.enqueue("a", 1)));',
    ].join("\n");

    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { encoding: "utf-8", timeout: 20_000 },
    );

    assert.equal(out, "resolved:1", "the process must survive its own debounce window");
  });
});
