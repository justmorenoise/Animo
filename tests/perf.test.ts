import { describe, expect, it } from "vitest";
import { checkBudgets, percentile, summarize } from "@/core/perf/stats";
import { PerfLog } from "@/app/perf";

describe("percentile", () => {
  it.each([
    [[1, 2, 3, 4, 5], 0, 1],
    [[1, 2, 3, 4, 5], 1, 5],
    [[1, 2, 3, 4, 5], 0.5, 3],
    [[1, 2, 3, 4], 0.5, 2.5],
    [[10, 20], 0.25, 12.5],
    [[7], 0.95, 7],
  ])("%j at %d -> %d", (sorted, p, expected) => {
    expect(percentile(sorted, p)).toBeCloseTo(expected, 9);
  });

  it("is NaN for nothing, and clamps p", () => {
    expect(percentile([], 0.5)).toBeNaN();
    expect(percentile([1, 2, 3], -1)).toBe(1);
    expect(percentile([1, 2, 3], 9)).toBe(3);
  });
});

describe("summarize", () => {
  it("is null for no samples", () => {
    expect(summarize([])).toBeNull();
  });

  it("computes the usual figures and keeps the last in order taken", () => {
    const s = summarize([30, 10, 20, 40])!;
    expect(s).toMatchObject({ count: 4, total: 100, mean: 25, min: 10, max: 40, last: 40 });
    expect(s.median).toBe(25);
    expect(s.p95).toBeCloseTo(38.5, 9);
    expect(summarize([5, 1])!.last).toBe(1);
  });

  it("does not reorder the samples it was given", () => {
    const input = [3, 1, 2];
    summarize(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("checkBudgets", () => {
  const summaries = new Map([["fast", summarize([1, 2, 3])!], ["slow", summarize([100, 200])!]]);

  it("passes under the budget and fails over it", () => {
    const [fast, slow] = checkBudgets(summaries, [
      { label: "fast", ms: 5, stat: "max" },
      { label: "slow", ms: 150, stat: "max" },
    ]);
    expect(fast).toMatchObject({ ok: true, actual: 3 });
    expect(slow).toMatchObject({ ok: false, actual: 200 });
  });

  it("uses the statistic asked for", () => {
    const [byMedian] = checkBudgets(summaries, [{ label: "slow", ms: 150, stat: "median" }]);
    expect(byMedian!.ok).toBe(true);
  });

  it("does not pass a budget nobody measured", () => {
    const [r] = checkBudgets(summaries, [{ label: "missing", ms: 1e9, stat: "max" }]);
    expect(r).toMatchObject({ ok: false, actual: null });
  });
});

describe("PerfLog", () => {
  function clock() {
    let t = 0;
    return { now: () => t, tick: (ms: number) => { t += ms; } };
  }

  it("times a synchronous step", () => {
    const c = clock();
    const log = new PerfLog(10, c.now);
    expect(log.measure("work", () => { c.tick(7); return "done"; })).toBe("done");
    expect(log.summary("work")).toMatchObject({ count: 1, last: 7 });
  });

  it("keeps the timing of a step that throws", () => {
    const c = clock();
    const log = new PerfLog(10, c.now);
    expect(() => log.measure("bad", () => { c.tick(3); throw new Error("x"); })).toThrow("x");
    expect(log.summary("bad")!.last).toBe(3);
  });

  it("times an asynchronous step to the settled promise, also on rejection", async () => {
    const c = clock();
    const log = new PerfLog(10, c.now);
    await log.measureAsync("a", async () => { c.tick(5); });
    await expect(log.measureAsync("a", async () => { c.tick(9); throw new Error("no"); })).rejects.toThrow("no");
    expect(log.summary("a")).toMatchObject({ count: 2, total: 14 });
  });

  it("drops the oldest samples past its limit", () => {
    const log = new PerfLog(3);
    for (const ms of [1, 2, 3, 4, 5]) log.record("x", ms);
    expect(log.summary("x")).toMatchObject({ count: 3, min: 3, max: 5, last: 5 });
  });

  it("clears one label or all", () => {
    const log = new PerfLog();
    log.record("a", 1); log.record("b", 2);
    log.clear("a");
    expect(log.summary("a")).toBeNull();
    expect(log.summary("b")).not.toBeNull();
    log.clear();
    expect(log.summaries().size).toBe(0);
  });

  it("reports slowest total first, rounded", () => {
    const log = new PerfLog();
    log.record("small", 1.234);
    log.record("big", 50.55);
    log.record("big", 60);
    const rows = log.report();
    expect(rows.map((r) => r.label)).toEqual(["big", "small"]);
    expect(rows[1]).toMatchObject({ mean: 1.2, count: 1 });
  });
});
