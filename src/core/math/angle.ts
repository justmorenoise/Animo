/**
 * Angle helpers.
 *
 * INVARIANT, load-bearing for export correctness: angles stored in the
 * document are NEVER wrapped into (-180, 180]. A rotation of 810° must stay
 * 810°, because `rotateFrame.clockwise` (Flash's "Rotate CW x N") is derived
 * from how far an angle travelled, and wrapping destroys that information
 * irrecoverably. Wrap only for display and only at the moment of display.
 */

export const DEG_RAD = Math.PI / 180;
export const RAD_DEG = 180 / Math.PI;

/** Wrap into (-180, 180]. For display and for shortest-path deltas only. */
export function wrapTo180(deg: number): number {
  let v = (deg + 180) % 360;
  if (v <= 0) v += 360;
  return v - 180;
}

/** The shortest signed rotation taking `from` to `to`. */
export function shortestDelta(from: number, to: number): number {
  return wrapTo180(to - from);
}

/**
 * Whole extra turns embedded in `delta` beyond the shortest path — exactly
 * DragonBones' `rotateFrame.clockwise`.
 *
 *   +2  →  two extra clockwise turns
 *   -1  →  one extra counter-clockwise turn
 */
export function turnsOf(delta: number): number {
  return Math.round((delta - wrapTo180(delta)) / 360);
}

export function lerpAngle(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Kills `-0`, which would otherwise churn golden-file diffs. */
export function nz(v: number): number {
  return v === 0 ? 0 : v;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}
