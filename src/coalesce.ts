/**
 * Coalesce concurrent requests into as few runs as possible.
 *
 * pi executes the tool calls of one assistant message in parallel, so three
 * edits would otherwise start three type-checks at once. Requests that arrive
 * while a run is in flight are batched into exactly one follow-up run, which
 * sees all of their files.
 */

export class Coalescer<T> {
  private running: Promise<T> | null = null;
  private queued: { files: Set<string>; promise: Promise<T> } | null = null;

  run(file: string, execute: (files: string[]) => Promise<T>): Promise<T> {
    if (!this.running) return this.start([file], execute);
    if (this.queued) {
      this.queued.files.add(file);
      return this.queued.promise;
    }
    const files = new Set([file]);
    const promise = this.running
      .catch(() => undefined)
      .then(() => {
        this.queued = null;
        return this.start([...files], execute);
      });
    this.queued = { files, promise };
    return promise;
  }

  private start(files: string[], execute: (files: string[]) => Promise<T>): Promise<T> {
    const run = execute(files).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }
}
