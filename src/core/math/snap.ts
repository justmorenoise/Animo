/**
 * Snapping: given where a drag WANTS to put something, where it should
 * actually land.
 *
 * Pure and canvas-free, like `onion.ts` and `nodeFrame.ts`, because the
 * arithmetic is the whole feature — which candidate wins, how ties break, and
 * that a snap never moves anything further than the tolerance it was given.
 * Everything here is in SCENE space: the grid, the guides and the stage
 * rectangle are all scene concepts, so the viewport converts a tool's world
 * delta in and out rather than expressing four different frames here.
 */

export interface SnapLine {
  axis: "x" | "y";
  /** Scene coordinate of the line that was matched. */
  at: number;
}

export interface SnapTargets {
  /** Vertical lines: guides, object edges and centres, the stage. */
  xs: number[];
  ys: number[];
}

export interface SnapOptions {
  /** Grid step, or null when grid snapping is off. */
  grid: number | null;
  /** Round to whole scene units when nothing else took hold. */
  pixel: boolean;
  /** Maximum correction, in SCENE units. */
  tolerance: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  /** The lines actually matched, for the smart guides the overlay draws. */
  lines: SnapLine[];
}

export const NO_TARGETS: SnapTargets = { xs: [], ys: [] };

/**
 * Correct a proposed translation so one of the moving reference points lands
 * on a target.
 *
 * `refs` are the points that may snap — for a selection, the two edges and
 * the centre of its bounding box on each axis. Explicit targets (guides,
 * objects, the stage) beat the grid at equal distance, because a user who put
 * a guide somewhere meant that exact position; the grid is everywhere and
 * would otherwise always win the tie.
 */
export function snapMove(
  refXs: number[], refYs: number[],
  dx: number, dy: number,
  targets: SnapTargets,
  opts: SnapOptions,
): SnapResult {
  const x = snapAxis(refXs, dx, targets.xs, opts);
  const y = snapAxis(refYs, dy, targets.ys, opts);
  const lines: SnapLine[] = [];
  if (x.at !== null) lines.push({ axis: "x", at: x.at });
  if (y.at !== null) lines.push({ axis: "y", at: y.at });
  return { dx: x.d, dy: y.d, lines };
}

interface AxisResult { d: number; at: number | null }

function snapAxis(
  refs: number[], d: number, targets: number[], opts: SnapOptions,
): AxisResult {
  if (refs.length === 0 || opts.tolerance <= 0) return { d, at: null };

  let best: { adjust: number; at: number | null; rank: number } | null = null;
  const consider = (adjust: number, at: number | null, rank: number) => {
    if (!Number.isFinite(adjust) || Math.abs(adjust) > opts.tolerance) return;
    if (best) {
      const a = Math.abs(adjust), b = Math.abs(best.adjust);
      if (a > b + 1e-9) return;                      // further away
      if (a > b - 1e-9 && rank >= best.rank) return; // same distance, weaker source
    }
    best = { adjust, at, rank };
  };

  for (const r of refs) {
    const p = r + d;
    for (const t of targets) consider(t - p, t, 0);
    if (opts.grid && opts.grid > 0) {
      const g = Math.round(p / opts.grid) * opts.grid;
      consider(g - p, g, 1);
    }
    // The pixel grid draws no line: at any useful zoom every pixel is one.
  }

  // Whole pixels are a FALLBACK, not a competitor: a box already sitting on a
  // round coordinate has a zero-distance pixel "snap", which would beat every
  // guide and grid line near it and make the other options unreachable.
  if (!best && opts.pixel) {
    for (const r of refs) consider(Math.round(r + d) - (r + d), null, 2);
  }

  const hit = best as { adjust: number; at: number | null } | null;
  if (!hit) return { d, at: null };
  return { d: d + hit.adjust, at: hit.at };
}

/**
 * The one-dimensional case: a guide dropped from a ruler, which has no box
 * and therefore exactly one reference point.
 */
export function snapValue(
  v: number, targets: number[], opts: SnapOptions,
): number {
  return snapAxis([v], 0, targets, opts).d + v;
}
