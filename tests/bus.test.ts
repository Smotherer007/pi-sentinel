/**
 * Unit tests for the inter-extension bus.
 *
 * Two of these matter more than the rest: a subscriber that throws must not be
 * able to break the extension that emitted, and a bus that is absent, partial or
 * broken must leave every sentinel hook working. Neither is hypothetical — the
 * publisher is mid-turn and has nothing to do with us.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  FILES_TOUCHED_CHANNEL,
  ROLLBACK_CHANNEL,
  VERIFIED_CHANNEL,
  adoptBus,
  publish,
  publishRollback,
  publishVerified,
  readTouched,
  subscribeTouched,
} from "../src/clients/bus.ts";

interface FakeBus {
  bus: any;
  emitted: Array<{ channel: string; data: unknown }>;
  send(channel: string, data: unknown): void;
}

function makeBus(overrides: Record<string, unknown> = {}): FakeBus {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const bus = {
    on(channel: string, handler: (data: unknown) => void) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => {
        handlers.set(channel, (handlers.get(channel) ?? []).filter((h) => h !== handler));
      };
    },
    emit(channel: string, data: unknown) {
      emitted.push({ channel, data });
    },
    ...overrides,
  };
  return {
    bus,
    emitted,
    send(channel, data) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
  };
}

describe("bus: reading another extension's event", () => {
  test("reads the published pi-lens v1 payload", () => {
    const { paths, reason } = readTouched({
      v: 1,
      source: "pi-lens",
      reason: "autofix",
      cwd: "/work",
      paths: ["/work/a.ts", "/work/b.ts"],
      fixes: [{ path: "/work/c.ts", tool: "biome" }],
    });
    assert.deepEqual(paths, ["/work/a.ts", "/work/b.ts", "/work/c.ts"]);
    assert.equal(reason, "autofix");
  });

  test("tolerates the obvious variants", () => {
    assert.deepEqual(readTouched({ files: [{ path: "a.ts" }] }).paths, ["a.ts"]);
    assert.deepEqual(readTouched({ file: "a.ts" }).paths, ["a.ts"]);
    assert.deepEqual(readTouched("a.ts").paths, ["a.ts"]);
    assert.deepEqual(readTouched(["a.ts", "b.ts"]).paths, ["a.ts", "b.ts"]);
  });

  test("an unreadable payload is the same as no event", () => {
    assert.deepEqual(readTouched(undefined).paths, []);
    assert.deepEqual(readTouched({ paths: "not-an-array" }).paths, []);
    assert.deepEqual(readTouched({ paths: [42, null, {}] }).paths, []);
    assert.deepEqual(readTouched({ paths: ["  "] }).paths, []);
  });

  test("duplicates are collapsed", () => {
    assert.deepEqual(readTouched({ paths: ["a.ts", "a.ts", "b.ts"] }).paths, ["a.ts", "b.ts"]);
  });
});

describe("bus: adopting pi's bus", () => {
  test("absent or partial buses yield null, not a stub", () => {
    assert.equal(adoptBus(undefined), null);
    assert.equal(adoptBus({}), null);
    assert.equal(adoptBus({ events: {} }), null);
    assert.equal(adoptBus({ events: { on: () => {} } }), null);
    assert.equal(adoptBus({ events: { emit: () => {} } }), null);
  });

  test("a real bus is adopted and keeps its receiver", () => {
    const seen: string[] = [];
    // Prototype methods, so a lost `this` would throw rather than silently pass.
    class Bus {
      channels: string[] = [];
      on(channel: string, _handler: (data: unknown) => void) {
        this.channels.push(channel);
        return () => {};
      }
      emit(channel: string, _data: unknown) {
        this.channels.push(channel);
      }
    }
    const real = new Bus();
    const adopted = adoptBus({ events: real });
    assert.ok(adopted);
    adopted.on("x", () => {});
    adopted.emit("y", {});
    assert.deepEqual(real.channels, ["x", "y"]);
    assert.deepEqual(seen, []);
  });
});

describe("bus: subscribing and publishing never break the other side", () => {
  test("paths reach the handler", () => {
    const fake = makeBus();
    const got: Array<{ paths: readonly string[]; reason: string }> = [];
    subscribeTouched(adoptBus({ events: fake.bus }), (paths, reason) => got.push({ paths, reason }));

    fake.send(FILES_TOUCHED_CHANNEL, { paths: ["a.ts"], reason: "format" });
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].paths, ["a.ts"]);
    assert.equal(got[0].reason, "format");
  });

  test("a throwing subscriber is contained", () => {
    const fake = makeBus();
    subscribeTouched(adoptBus({ events: fake.bus }), () => {
      throw new Error("subscriber exploded");
    });
    assert.doesNotThrow(() => fake.send(FILES_TOUCHED_CHANNEL, { paths: ["a.ts"] }));
  });

  test("an event with no paths calls nothing", () => {
    const fake = makeBus();
    let calls = 0;
    subscribeTouched(adoptBus({ events: fake.bus }), () => calls++);
    fake.send(FILES_TOUCHED_CHANNEL, { reason: "empty" });
    fake.send(FILES_TOUCHED_CHANNEL, { paths: [] });
    assert.equal(calls, 0);
  });

  test("a null bus subscribes to nothing and publishes nothing", () => {
    subscribeTouched(null, () => assert.fail("should not be called"));
    assert.equal(publish(null, "x", {}), false);
    assert.equal(publishVerified(null, { at: "now", trigger: "t", passed: true, paths: [] }), false);
  });

  test("a throwing bus is not a sentinel failure", () => {
    const exploding = {
      on() {
        throw new Error("no bus for you");
      },
      emit() {
        throw new Error("emit failed");
      },
    };
    assert.doesNotThrow(() => subscribeTouched(exploding as any, () => {}));
    assert.equal(publish(exploding as any, "x", {}), false);
  });
});

describe("bus: what sentinel emits", () => {
  test("verified and rollback events carry the documented envelope", () => {
    const fake = makeBus();
    const bus = adoptBus({ events: fake.bus })!;

    assert.equal(publishVerified(bus, { at: "2026-09-14T00:00:00Z", trigger: "onTurnEnd", passed: true, paths: ["a.ts"] }), true);
    assert.equal(publishRollback(bus, { at: "2026-09-14T00:00:01Z", reason: "type-check", method: "snapshot:turn", ok: true, partial: false, conflicts: 0 }), true);

    assert.deepEqual(fake.emitted, [
      {
        channel: VERIFIED_CHANNEL,
        data: { v: 1, source: "pi-sentinel", at: "2026-09-14T00:00:00Z", trigger: "onTurnEnd", passed: true, paths: ["a.ts"] },
      },
      {
        channel: ROLLBACK_CHANNEL,
        data: { v: 1, source: "pi-sentinel", at: "2026-09-14T00:00:01Z", reason: "type-check", method: "snapshot:turn", ok: true, partial: false, conflicts: 0 },
      },
    ]);
  });
});
