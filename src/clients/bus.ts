/**
 * EventBus — what sentinel announces, and what it listens for.
 *
 * pi publishes a shared bus (`pi.events`) that extensions use to tell each
 * other what they did. Sentinel used none of it: it neither announced its own
 * verdicts nor listened for anyone else's writes. That leaves two mechanisms
 * blind in exactly the case they exist for. A formatter, linter autofix or any
 * other extension in the same session changes a file outside a tool call
 * sentinel sees; sentinel then finds it at turn end through `git status` (P3),
 * which does not exist without a repository, and it never learns *who* changed
 * the file — so the change cannot be attributed, and `revertOnRegression` can
 * revert another extension's formatting as if it were the agent's mistake.
 *
 * pi-lens publishes `pilens:files:touched` on this bus for exactly this
 * audience — "so other extensions in the same session can observe files
 * pi-lens writes autonomously, without reverse-engineering us" — versioned
 * `v: 1` and frozen-additive. This module is the receiving end, plus the two
 * events sentinel emits in return.
 *
 * Everything here is defensive by construction: the bus may not exist (an older
 * pi, a bare SDK session, the test harness), a subscriber must never be able to
 * break a publisher that is mid-turn, and a failed emit is not a sentinel
 * failure — so nothing in here throws into a hook.
 */

/** The part of pi's `EventBus` sentinel uses. */
export interface EventBusLike {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

/** pi-lens's event: files another extension wrote without a tool call. */
export const FILES_TOUCHED_CHANNEL = "pilens:files:touched";
/** Sentinel's event: a verification ran and this is its verdict. */
export const VERIFIED_CHANNEL = "sentinel:verified";
/** Sentinel's event: files were restored. */
export const ROLLBACK_CHANNEL = "sentinel:rollback";

/** Payload version for sentinel's own events, same convention as pi-lens's. */
export const PAYLOAD_VERSION = 1;

/** Bounded: one notice-worthy batch, not a workspace listing. */
export const MAX_TOUCHED_PATHS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushPath(out: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) return;
  out.push(trimmed);
}

/**
 * Extract the paths another extension reported writing.
 *
 * Tolerant on purpose: the channel is versioned but not owned by us, so this
 * reads the published v1 shape (`paths`, plus `fixes[].path`) and the obvious
 * variants (`files`, a single `path`/`file`, a bare string or array) rather than
 * failing on anything unfamiliar. An unreadable payload yields no paths, which
 * is the same outcome as no event at all.
 */
export function readTouched(payload: unknown): { paths: readonly string[]; reason: string } {
  const found: string[] = [];
  let reason = "";

  if (typeof payload === "string") {
    pushPath(found, payload);
  } else if (Array.isArray(payload)) {
    for (const entry of payload) pushPath(found, entry);
  } else if (isRecord(payload)) {
    if (typeof payload.reason === "string") reason = payload.reason;

    for (const key of ["paths", "files", "filePaths"]) {
      const value = payload[key];
      if (!Array.isArray(value)) continue;
      for (const entry of value) {
        if (typeof entry === "string") pushPath(found, entry);
        else if (isRecord(entry)) pushPath(found, entry.path ?? entry.file ?? entry.absPath);
      }
    }

    for (const key of ["path", "file"]) pushPath(found, payload[key]);

    const fixes = payload.fixes;
    if (Array.isArray(fixes)) {
      for (const fix of fixes) {
        if (isRecord(fix)) pushPath(found, fix.path ?? fix.file);
      }
    }
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of found) {
    if (seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
    if (unique.length >= MAX_TOUCHED_PATHS) break;
  }
  return { paths: unique, reason };
}

/**
 * Adopt pi's bus, if this host has one.
 *
 * Returns `null` rather than a stub when the bus is absent, so callers can
 * decide not to publish at all instead of emitting into nothing.
 */
export function adoptBus(pi: unknown): EventBusLike | null {
  if (!isRecord(pi)) return null;
  const events = pi.events;
  if (!isRecord(events)) return null;

  // Read through locals: `isRecord` narrows the property to `unknown`, and both
  // methods have to be callable before either can be adopted.
  const on = events.on as unknown;
  const emit = events.emit as unknown;
  if (typeof on !== "function" || typeof emit !== "function") return null;

  const callOn = on as (channel: string, handler: (data: unknown) => void) => unknown;
  const callEmit = emit as (channel: string, data: unknown) => unknown;
  return {
    // Called through the bus object: these may be prototypes or closures that
    // rely on their receiver.
    on: (channel, handler) => {
      const unsubscribe = callOn.call(events, channel, handler);
      // pi's bus returns an unsubscribe function. An implementation that does
      // not is still usable: there is simply nothing to call on the way out.
      return typeof unsubscribe === "function" ? (unsubscribe as () => void) : () => {};
    },
    emit: (channel, data) => {
      callEmit.call(events, channel, data);
    },
  };
}

/**
 * Listen for another extension's writes.
 *
 * The handler is wrapped: a subscriber that throws must not travel back into
 * the caller's write path, which is mid-turn and has nothing to do with us.
 */
export function subscribeTouched(
  bus: EventBusLike | null,
  handler: (paths: readonly string[], reason: string) => void,
): void {
  if (!bus) return;
  try {
    bus.on(FILES_TOUCHED_CHANNEL, (payload) => {
      try {
        const { paths, reason } = readTouched(payload);
        if (paths.length === 0) return;
        handler(paths, reason);
      } catch {
        /* another extension's event must never break this session */
      }
    });
  } catch {
    /* a bus that refuses subscription is a bus sentinel does not have */
  }
}

/**
 * Emit one event. Fire-and-forget by design: a bus failure is not a sentinel
 * failure, and none of the callers can do anything about it mid-turn.
 * Returns whether the emit was attempted, which is what the tests assert on.
 */
export function publish(bus: EventBusLike | null, channel: string, payload: unknown): boolean {
  if (!bus) return false;
  try {
    bus.emit(channel, payload);
    return true;
  } catch {
    return false;
  }
}

/** What a green (or red) verification reports to whoever is listening. */
export interface VerifiedEvent {
  readonly at: string;
  readonly trigger: string;
  readonly step?: string;
  readonly passed: boolean;
  readonly paths: readonly string[];
}

/** What a rollback reports to whoever is listening. */
export interface RollbackEvent {
  readonly at: string;
  readonly reason: string;
  readonly method: string;
  /** Whether every captured file came back. A partial rollback is not `ok`. */
  readonly ok: boolean;
  readonly partial: boolean;
  readonly conflicts: number;
}

export function publishVerified(bus: EventBusLike | null, event: VerifiedEvent): boolean {
  return publish(bus, VERIFIED_CHANNEL, { v: PAYLOAD_VERSION, source: "pi-sentinel", ...event });
}

export function publishRollback(bus: EventBusLike | null, event: RollbackEvent): boolean {
  return publish(bus, ROLLBACK_CHANNEL, { v: PAYLOAD_VERSION, source: "pi-sentinel", ...event });
}
