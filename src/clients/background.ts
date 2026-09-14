/**
 * BackgroundSlot — one turn-end verification waits behind another (P5).
 *
 * Turn-end checks run in the background so the turn does not wait for a slow
 * suite. That creates a second problem: the agent can finish the next turn
 * while the previous check is still running. The original answer was to skip
 * the newer turn's checks and tell the human, which is the worst of the
 * options — unverified code reaches the user with no trace at all, and the
 * human is told about it in a notification that scrolls away.
 *
 * So the newer turn is *folded forward* instead: its scope joins the run that
 * will cover it. At most one request waits, because a third turn's scope
 * simply unions into the same waiting request — the guarantee is "every turn
 * is verified", not "every turn gets its own run".
 *
 * That waiting request is the whole state, so it is modelled as one: a plain
 * value the caller replaces, plus pure transitions. The promise of the run in
 * flight is deliberately *not* in here — an effect handle belongs to the
 * caller, not to the data.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** One turn's background verification request. */
export interface BackgroundRequest {
  cwd: string;
  ctx: { ui: ExtensionUIContext };
  /** Files the run is about, widened by graph dependents (diagnostic focus). */
  focusPaths: string[];
  /** Files the turn actually changed — what evidence and the state hash bind to. */
  changedPaths: string[];
  /**
   * Pre-state checkpoint of the turn. A background run may only roll back
   * while this is still the newest checkpoint.
   */
  checkpointId?: string;
  /** Files the agent wrote this turn; the regression revert is scoped to them. */
  mutablePaths?: string[];
  /** Post-mutation hashes for `mutablePaths`. */
  postHashes?: Map<string, string | null>;
}

/** The request owed a verification, if any. */
export interface BackgroundSlot {
  readonly pending: BackgroundRequest | null;
}

/** A slot with nothing waiting. */
export const EMPTY_BACKGROUND_SLOT: BackgroundSlot = { pending: null };

/**
 * Fold a request that could not start immediately into the one already
 * waiting.
 *
 * The union of both scopes is verified. The *newer* request wins for
 * everything that is not a scope, because it is the one that still describes
 * the tree: the older turn's checkpoint can no longer be restored to, and its
 * post-mutation hashes have already been written over.
 */
export function foldBackgroundRequest(
  slot: BackgroundSlot,
  request: BackgroundRequest,
): BackgroundSlot {
  if (!slot.pending) return { pending: request };
  return { pending: mergeBackgroundRequests(slot.pending, request) };
}

/** Take the waiting request, leaving the slot empty. */
export function takeBackgroundRequest(slot: BackgroundSlot): {
  slot: BackgroundSlot;
  request: BackgroundRequest | null;
} {
  if (!slot.pending) return { slot, request: null };
  return { slot: EMPTY_BACKGROUND_SLOT, request: slot.pending };
}

/** Merge two requests into the one run that will cover both turns. */
export function mergeBackgroundRequests(
  waiting: BackgroundRequest,
  next: BackgroundRequest,
): BackgroundRequest {
  const postHashes = new Map(waiting.postHashes ?? []);
  for (const [path, hash] of next.postHashes ?? []) postHashes.set(path, hash);
  return {
    cwd: next.cwd,
    ctx: next.ctx,
    focusPaths: [...new Set([...waiting.focusPaths, ...next.focusPaths])],
    changedPaths: [...new Set([...waiting.changedPaths, ...next.changedPaths])],
    checkpointId: next.checkpointId,
    mutablePaths: [...new Set([...(waiting.mutablePaths ?? []), ...(next.mutablePaths ?? [])])],
    postHashes,
  };
}
