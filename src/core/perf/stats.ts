/** Summary of a set of timings, in milliseconds. */
export interface TimingSummary {
  count: number;
  total: number;
  mean: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  last: number;
}

/**
 * The value below which `p` (0..1) of the sorted samples fall, by linear
 * interpolation between neighbours. NaN for no samples.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const at = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** Samples in the order they were taken; `last` is the final one. Null for none. */
export function summarize(samples: readonly number[]): TimingSummary | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((a, b) => a + b, 0);
  return {
    count: samples.length,
    total,
    mean: total / samples.length,
    min: sorted[0]!,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1]!,
    last: samples[samples.length - 1]!,
  };
}

/** A budget: a label must stay under `ms` at its `stat`. */
export interface Budget {
  label: string;
  ms: number;
  stat: "median" | "p95" | "max";
}

export interface BudgetResult {
  label: string;
  budget: number;
  stat: Budget["stat"];
  actual: number | null;
  ok: boolean;
}

/** Check summaries against budgets. A label with no samples is not a pass:
 *  a budget nobody measured proves nothing. */
export function checkBudgets(
  summaries: ReadonlyMap<string, TimingSummary>, budgets: readonly Budget[],
): BudgetResult[] {
  return budgets.map((b) => {
    const s = summaries.get(b.label);
    const actual = s ? s[b.stat] : null;
    return { label: b.label, budget: b.ms, stat: b.stat, actual, ok: actual !== null && actual <= b.ms };
  });
}
