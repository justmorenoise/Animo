import { describe, it, expect } from "vitest";
import { strToU8 } from "fflate";
import { type PoolWorker, WorkerCrashed, WorkerPool } from "@/io/workers/WorkerPool";
import { unzipFiles, zipFiles, zipLevelFor } from "@/io/zip";

describe("zipLevelFor", () => {
  it.each([
    ["assets/a.png", 0], ["page.WEBP", 0], ["x.jpg", 0], ["x.jpeg", 0], ["x.gif", 0],
    ["project.json", 6], ["README.md", 6], ["animo-pixi.js", 6], ["png", 6], ["a.png.json", 6],
  ])("%s → %i", (path, level) => {
    expect(zipLevelFor(path)).toBe(level);
  });
});

describe("zipFiles", () => {
  it("stores images, deflates the rest, and round-trips", async () => {
    const zeros = new Uint8Array(100_000);
    const zipped = await zipFiles({ "a.png": zeros, "b.json": zeros, "c.json": strToU8("{}") });
    // Stored: the zeros of a.png are all in there; b.json shrinks to nothing.
    expect(zipped.length).toBeGreaterThan(100_000);
    expect(zipped.length).toBeLessThan(101_000);
    const back = await unzipFiles(zipped);
    expect(back["a.png"]).toEqual(zeros);
    expect(back["b.json"]).toEqual(zeros);
    expect(new TextDecoder().decode(back["c.json"])).toBe("{}");
  });
});

/** A worker that answers in a microtask, or dies when told to. */
class FakeWorker implements PoolWorker {
  static made = 0;
  static running = 0;
  static peak = 0;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor() { FakeWorker.made++; }
  postMessage(msg: unknown): void {
    FakeWorker.running++;
    FakeWorker.peak = Math.max(FakeWorker.peak, FakeWorker.running);
    const m = msg as { n: number; crash?: boolean; fail?: boolean; steps?: number };
    setTimeout(() => {
      FakeWorker.running--;
      for (let i = 1; i <= (m.steps ?? 0); i++) this.onmessage?.({ data: { progress: i / 4 } } as MessageEvent);
      if (m.crash) this.onerror?.({ message: "boom", preventDefault() {} } as ErrorEvent);
      else if (m.fail) this.onmessage?.({ data: { ok: false, error: "bad input" } } as MessageEvent);
      else this.onmessage?.({ data: { ok: true, value: m.n * 2 } } as MessageEvent);
    }, 1);
  }
  terminate(): void { this.terminated = true; }
}

describe("WorkerPool", () => {
  it("runs every task, never more at once than its size, reusing workers", async () => {
    FakeWorker.made = FakeWorker.running = FakeWorker.peak = 0;
    const pool = new WorkerPool<{ n: number }, number>(() => new FakeWorker(), 2);
    const out = await Promise.all([1, 2, 3, 4, 5].map((n) => pool.run({ n })));
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(FakeWorker.peak).toBe(2);
    expect(FakeWorker.made).toBe(2);
  });

  it("rejects a failed task with an Error and a dead worker with WorkerCrashed, then goes on", async () => {
    FakeWorker.made = 0;
    const pool = new WorkerPool<{ n: number; crash?: boolean; fail?: boolean }, number>(() => new FakeWorker(), 1);
    const failed = pool.run({ n: 1, fail: true });
    const crashed = pool.run({ n: 2, crash: true });
    const after = pool.run({ n: 3 });
    await expect(failed).rejects.toThrow("bad input");
    await expect(failed).rejects.not.toBeInstanceOf(WorkerCrashed);
    await expect(crashed).rejects.toBeInstanceOf(WorkerCrashed);
    expect(await after).toBe(6);
    expect(FakeWorker.made).toBe(2);
  });

  it("fails the queue with WorkerCrashed when no worker can start", async () => {
    const pool = new WorkerPool<{ n: number }, number>(() => { throw new Error("no workers"); }, 2);
    await expect(pool.run({ n: 1 })).rejects.toBeInstanceOf(WorkerCrashed);
  });

  it("passes progress messages to the task's callback before the answer", async () => {
    const pool = new WorkerPool<{ n: number; steps: number }, number>(() => new FakeWorker(), 1);
    const seen: number[] = [];
    expect(await pool.run({ n: 5, steps: 4 }, [], (f) => seen.push(f))).toBe(10);
    expect(seen).toEqual([0.25, 0.5, 0.75, 1]);
  });
});
