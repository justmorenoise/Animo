import { describe, it, expect } from "vitest";
import { snapMove, snapValue, type SnapTargets } from "@/core/math/snap";

/**
 * Snapping was a dead flag: `ui.snap` was toggled by the View menu and the
 * stage bar and read by nobody, so turning it on changed nothing at all.
 * These are the rules the drag now follows.
 */

const NONE: SnapTargets = { xs: [], ys: [] };
const opts = (over: Partial<Parameters<typeof snapMove>[5]> = {}) => ({
  grid: null, pixel: false, tolerance: 8, ...over,
});

describe("snapMove", () => {
  it("leaves a delta alone when nothing is near", () => {
    const r = snapMove([0, 50, 100], [0, 25, 50], 3.4, -2.1, NONE, opts({ grid: 20 }));
    // 3.4 from 0 would land at 3.4; the nearest grid line is 0, 3.4 away.
    expect(r.dx).toBeCloseTo(0, 9);

    const far = snapMove([0], [0], 3.4, -2.1, NONE, opts({ tolerance: 1 }));
    expect(far.dx).toBeCloseTo(3.4, 9);
    expect(far.dy).toBeCloseTo(-2.1, 9);
    expect(far.lines).toEqual([]);
  });

  it("snaps to the grid within tolerance and reports the line", () => {
    const r = snapMove([0], [0], 18, 0, NONE, opts({ grid: 20 }));
    expect(r.dx).toBeCloseTo(20, 9);
    expect(r.lines).toContainEqual({ axis: "x", at: 20 });
  });

  it("never moves further than the tolerance", () => {
    const r = snapMove([0], [0], 10, 0, NONE, opts({ grid: 20, tolerance: 4 }));
    expect(r.dx).toBeCloseTo(10, 9);   // 10 away from both 0 and 20
  });

  it("picks the reference point closest to a target, not the first", () => {
    // The box is 0..100; its right edge is the one near the guide at 203.
    const r = snapMove([0, 50, 100], [0], 100, 0, { xs: [203], ys: [] }, opts());
    expect(r.dx).toBeCloseTo(103, 9);
  });

  it("prefers an explicit target over the grid at equal distance", () => {
    // Moving by 18 puts the point at 18: the grid line at 20 and the guide at
    // 16 are both 2 away. A guide was placed on purpose; the grid is everywhere.
    const r = snapMove([0], [0], 18, 0, { xs: [16], ys: [] }, opts({ grid: 20 }));
    expect(r.dx).toBeCloseTo(16, 9);
    expect(r.lines).toContainEqual({ axis: "x", at: 16 });
  });

  it("snaps the two axes independently", () => {
    const r = snapMove([0], [0], 18, 3, { xs: [], ys: [40] }, opts({ grid: 20 }));
    expect(r.dx).toBeCloseTo(20, 9);
    expect(r.dy).toBeCloseTo(0, 9);    // 40 is out of reach; the grid line 0 is 3 away
    expect(r.lines).toEqual([{ axis: "x", at: 20 }, { axis: "y", at: 0 }]);
  });

  it("rounds to whole units with pixel snapping, and draws no line for it", () => {
    const r = snapMove([0.4], [0], 0, 0, NONE, opts({ pixel: true }));
    expect(r.dx).toBeCloseTo(-0.4, 9);
    expect(r.lines).toEqual([]);
  });

  it("treats whole pixels as a fallback, never as a competitor", () => {
    // The box sits on a round coordinate, so its pixel "snap" costs nothing —
    // and would win every tie if it were an ordinary candidate, putting every
    // guide out of reach.
    const r = snapMove([0], [0], 0, 0, { xs: [3], ys: [] }, opts({ pixel: true }));
    expect(r.dx).toBeCloseTo(3, 9);
  });

  it("does nothing with no reference points or no tolerance", () => {
    expect(snapMove([], [], 5, 5, { xs: [0], ys: [0] }, opts()).dx).toBe(5);
    expect(snapMove([0], [0], 5, 5, { xs: [0], ys: [0] }, opts({ tolerance: 0 })).dx).toBe(5);
  });
});

describe("snapValue", () => {
  it("places a guide on the nearest target", () => {
    expect(snapValue(97, [100], { grid: null, pixel: true, tolerance: 8 })).toBeCloseTo(100, 9);
  });

  it("falls back to the grid, then to whole units", () => {
    expect(snapValue(97, [], { grid: 20, pixel: true, tolerance: 8 })).toBeCloseTo(100, 9);
    expect(snapValue(97, [], { grid: null, pixel: false, tolerance: 8 })).toBeCloseTo(97, 9);
    expect(snapValue(97.4, [], { grid: null, pixel: true, tolerance: 8 })).toBeCloseTo(97, 9);
  });
});
