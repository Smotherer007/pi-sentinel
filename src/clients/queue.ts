/**
 * VerificationQueue — coalesce verifications that arrive together.
 *
 * An agent that emits four `edit` calls in one assistant message produces
 * four `tool_result` hooks at almost the same moment. Running a full
 * type-check for each of them is pure waste: the four edits land within a few
 * milliseconds, and the check would answer the same question four times.
 *
 * This queue collects requests that arrive inside one short window and runs
 * them as a single verification whose scope is the union of the requests.
 *
 * Two rules keep it safe:
 *   - the window is *fixed* (it is not extended by later arrivals), so the
 *     latency a caller can experience is bounded by the window;
 *   - an explicit request (`runNow`, used by `/sentinel verify` and the
 *     `sentinel_verify` tool) runs immediately and takes any waiting requests
 *     with it, instead of queueing behind them.
 *
 * The queue is transport-agnostic (key + payload + a run function), so it is
 * unit-testable without the extension host.
 */

interface Waiting<P, R> {
  payloads: P[];
  promise: Promise<R>;
  resolve: (value: R) => void;
  reject: (reason: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class VerificationQueue<K, P, R> {
  private run: (key: K, payloads: P[]) => Promise<R>;
  private debounce: number;
  private waiting = new Map<K, Waiting<P, R>>();

  constructor(run: (key: K, payloads: P[]) => Promise<R>, debounceMs: number) {
    this.run = run;
    this.debounce = Math.max(0, debounceMs);
  }

  /** Current batching window in milliseconds. */
  get debounceMs(): number {
    return this.debounce;
  }

  /** Update the window — configuration can change mid-session. */
  setDebounce(debounceMs: number): void {
    this.debounce = Math.max(0, debounceMs);
  }

  /** True when requests are currently being batched. */
  get debouncing(): boolean {
    return this.debounce > 0;
  }

  /** How many keys have a pending batch (used by status/tests). */
  pendingCount(): number {
    return this.waiting.size;
  }

  /**
   * Request a verification. Within the debounce window the request joins the
   * batch for `key` and resolves with the batch's single result.
   */
  enqueue(key: K, payload: P): Promise<R> {
    if (this.debounce <= 0) return this.runNow(key, [payload]);

    const existing = this.waiting.get(key);
    if (existing) {
      existing.payloads.push(payload);
      return existing.promise;
    }

    let resolve!: (value: R) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<R>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const entry: Waiting<P, R> = { payloads: [payload], promise, resolve, reject };
    // Deliberately *not* unref'd. This timer is the only thing that will ever
    // resolve the promise, so dropping it when the event loop drains would
    // leave every caller waiting forever — the batch must keep the process
    // alive until it has run.
    entry.timer = setTimeout(() => {
      void this.flush(key);
    }, this.debounce);

    this.waiting.set(key, entry);
    return promise;
  }

  /**
   * Run immediately, folding in (and cancelling) any batch that was waiting
   * for `key`. Used by explicit verify commands.
   */
  runNow(key: K, payloads: P[]): Promise<R> {
    const waiting = this.waiting.get(key);
    if (waiting) {
      this.waiting.delete(key);
      if (waiting.timer) clearTimeout(waiting.timer);
    }

    const merged = waiting ? [...waiting.payloads, ...payloads] : [...payloads];
    const promise = this.run(key, merged);
    if (waiting) promise.then(waiting.resolve, waiting.reject);
    return promise;
  }

  /** Drop every pending batch (test/shutdown helper). */
  cancel(): void {
    for (const entry of this.waiting.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.waiting.clear();
  }

  private async flush(key: K): Promise<void> {
    const entry = this.waiting.get(key);
    if (!entry) return;
    this.waiting.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    try {
      entry.resolve(await this.run(key, entry.payloads));
    } catch (error) {
      entry.reject(error);
    }
  }
}
