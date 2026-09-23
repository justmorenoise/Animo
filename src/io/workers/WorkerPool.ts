/**
 * A few workers running one kind of task, one task per worker at a time.
 *
 * The worker side answers every message with `{ ok: true, value }` or
 * `{ ok: false, error }`, after any number of `{ progress }` (see
 * `serveWorker`). A task that fails that way rejects with a plain Error; a worker that dies (its script failed to load,
 * it threw outside the handler) rejects with `WorkerCrashed`, so a caller can
 * fall back to doing the work on the main thread.
 */

export interface PoolWorker {
  postMessage(message: unknown, options?: { transfer?: Transferable[] }): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  terminate(): void;
}

export class WorkerCrashed extends Error {}

type Reply<T> = { ok: true; value: T } | { ok: false; error: string } | { progress: number };

interface Task {
  message: unknown;
  transfer: Transferable[];
  onProgress?(fraction: number): void;
  resolve(v: unknown): void;
  reject(e: Error): void;
}

export class WorkerPool<Req, Res> {
  private idle: PoolWorker[] = [];
  private count = 0;
  private queue: Task[] = [];

  constructor(private readonly make: () => PoolWorker, private readonly size: number) {}

  run(message: Req, transfer: Transferable[] = [], onProgress?: (fraction: number) => void): Promise<Res> {
    return new Promise<Res>((resolve, reject) => {
      this.queue.push({ message, transfer, onProgress, resolve: resolve as (v: unknown) => void, reject });
      this.pump();
    });
  }

  /** Workers stay alive between tasks; this ends them and fails what is queued. */
  dispose(): void {
    for (const w of this.idle) w.terminate();
    this.idle = [];
    for (const t of this.queue.splice(0)) t.reject(new WorkerCrashed("worker pool disposed"));
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let worker = this.idle.pop();
      if (!worker) {
        if (this.count >= this.size) return;
        try {
          worker = this.make();
        } catch (err) {
          for (const t of this.queue.splice(0)) t.reject(new WorkerCrashed(String(err)));
          return;
        }
        this.count++;
      }
      this.start(worker, this.queue.shift()!);
    }
  }

  private start(worker: PoolWorker, task: Task): void {
    const done = () => { worker.onmessage = null; worker.onerror = null; };
    worker.onmessage = (ev) => {
      const reply = ev.data as Reply<unknown>;
      if ("progress" in reply) { task.onProgress?.(reply.progress); return; }
      done();
      this.idle.push(worker);
      if (reply.ok) task.resolve(reply.value);
      else task.reject(new Error(reply.error));
      this.pump();
    };
    worker.onerror = (ev) => {
      done();
      ev.preventDefault?.();
      worker.terminate();
      this.count--;
      task.reject(new WorkerCrashed(ev.message || "worker failed"));
      this.pump();
    };
    worker.postMessage(task.message, { transfer: task.transfer });
  }
}

/** The worker side: run `handle` on every message and post the reply. */
export function serveWorker<Req, Res>(
  handle: (req: Req, progress: (fraction: number) => void) => Res | Promise<Res>,
  transferOf: (res: Res) => Transferable[] = () => [],
): void {
  const scope = self as unknown as {
    onmessage: ((ev: MessageEvent) => void) | null;
    postMessage(message: unknown, options?: { transfer?: Transferable[] }): void;
  };
  scope.onmessage = async (ev) => {
    try {
      const value = await handle(ev.data as Req, (progress) => scope.postMessage({ progress }));
      scope.postMessage({ ok: true, value }, { transfer: transferOf(value) });
    } catch (err) {
      scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/** Whether module workers can be started here (not under vitest's Node). */
export function canUseWorkers(): boolean {
  return typeof Worker === "function";
}

/** One worker per spare core, at most `cap`. */
export function poolSize(cap: number): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(cap, cores - 1));
}
