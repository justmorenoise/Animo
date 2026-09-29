import { summarize, type TimingSummary } from "@/core/perf/stats";

/**
 * Timings of the operations that can hold the page up, kept in memory and
 * read from the console (`animo.perf.report()`). The recorder is always on:
 * two `performance.now()` calls around a step that takes milliseconds cost
 * nothing measurable, and a slowdown nobody can see is one nobody fixes.
 */
export class PerfLog {
  /** Per label, most recent last; older samples are dropped past `keep`. */
  private samples = new Map<string, number[]>();

  constructor(private readonly keep = 200, private readonly now: () => number = () => performance.now()) {}

  record(label: string, ms: number): void {
    let list = this.samples.get(label);
    if (!list) this.samples.set(label, (list = []));
    list.push(ms);
    if (list.length > this.keep) list.splice(0, list.length - this.keep);
  }

  /** Time a synchronous step. The timing is kept even if it throws. */
  measure<T>(label: string, fn: () => T): T {
    const start = this.now();
    try {
      return fn();
    } finally {
      this.record(label, this.now() - start);
    }
  }

  /** Time an asynchronous step, from the call to the settled promise. */
  async measureAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = this.now();
    try {
      return await fn();
    } finally {
      this.record(label, this.now() - start);
    }
  }

  summary(label: string): TimingSummary | null {
    return summarize(this.samples.get(label) ?? []);
  }

  summaries(): Map<string, TimingSummary> {
    const out = new Map<string, TimingSummary>();
    for (const [label, list] of this.samples) {
      const s = summarize(list);
      if (s) out.set(label, s);
    }
    return out;
  }

  clear(label?: string): void {
    if (label) this.samples.delete(label); else this.samples.clear();
  }

  /** A table for the console, slowest total first. */
  report(): Array<Record<string, number | string>> {
    return [...this.summaries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([label, s]) => ({
        label, count: s.count, mean: round(s.mean), median: round(s.median),
        p95: round(s.p95), max: round(s.max), last: round(s.last),
      }));
  }
}

const round = (n: number) => Math.round(n * 10) / 10;

/** The one log the app writes to. */
export const perf = new PerfLog();
