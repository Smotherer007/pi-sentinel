/**
 * SentinelRuntime — the stores a sentinel session owns, as one plain value.
 *
 * All of sentinel's per-session state is in here: the configuration in force
 * and the runtime state it is scoped to, the turn's pre-state snapshots, the
 * checkpoint currently being captured for the turn, and the failure-signature
 * counters that notice a repair loop. Each was a module-level singleton, which
 * made their lifetime the process rather than the session — two sessions in one
 * process shared them, wrote history into whichever state file the other had
 * loaded last, and a rollback could restore a file the other session captured.
 * Tests had to reset the globals between cases.
 *
 * They are now one value, created once per extension instance and handed to the
 * tools that need it. That is the point of modelling session state as data: it
 * becomes a parameter, so its lifetime is visible where it is used instead of
 * being a property of the module graph.
 *
 * Deliberately *not* in here: the caches keyed by project path
 * (`clients/cache.ts`, `clients/mindplace.ts`, `clients/git-client.ts`). They are
 * pure functions of the working tree — a graph parsed from `graph-out/graph.json`
 * at a given mtime, a repository root for a directory, a verification result
 * keyed by the content hashes of its inputs. A hit is correct by construction for
 * the path that produced it, so sharing them across sessions is desirable rather
 * than dangerous, and their only real cost is that tests drop them explicitly
 * (`_clearCache`, `_clearRepoRootCache`, `_resetCacheForTesting`).
 */

import { ConfigStore } from "./config.ts";
import { SnapshotStore } from "./clients/snapshot.ts";
import { CheckpointStore } from "./clients/checkpoints.ts";
import { FailureEscalationTracker } from "./clients/escalation.ts";

/** The per-session stores. One runtime belongs to one extension instance. */
export interface SentinelRuntime {
  /** The session's configuration and its runtime state (history, metrics). */
  readonly config: ConfigStore;
  /** In-memory pre-state capture for the current turn (P0/P1). */
  readonly snapshots: SnapshotStore;
  /** Durable turn checkpoints (P1). */
  readonly checkpoints: CheckpointStore;
  /** Repeated-failure counters for the open repair cycle (P6). */
  readonly escalations: FailureEscalationTracker;
}

/** A runtime with every store empty — a fresh session, or a test case. */
export function createRuntime(): SentinelRuntime {
  return {
    config: new ConfigStore(),
    snapshots: new SnapshotStore(),
    checkpoints: new CheckpointStore(),
    escalations: new FailureEscalationTracker(),
  };
}
