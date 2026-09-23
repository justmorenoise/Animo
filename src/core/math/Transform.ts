import { matOf, type Matrix2D } from "./Matrix2D";
import { DEG_RAD, nz, RAD_DEG } from "./angle";

/**
 * The Flash / DragonBones transform: six independent parameters, angles in
 * DEGREES (the same unit the JSON and the properties panel use, so nothing
 * round-trips through radians and accumulates drift).
 *
 * DragonBones' own `Transform` stores `rotation` and `skew`, related to this
 * one by `rotation = skewY` and `skew = skewX - skewY`. Substituting those
 * into the runtime's `toMatrix` gives exactly `toMatrix` below — a pure
 * rotation is `skewX === skewY`, and shear is the difference between them.
 */
export interface Transform {
  x: number;
  y: number;
  skewX: number;
  skewY: number;
  scaleX: number;
  scaleY: number;
}

/** Scales are clamped to this magnitude: 0 makes the matrix singular, which
 *  breaks hit-testing and the next gizmo drag. */
export const MIN_SCALE = 1e-4;

export function tf(
  x = 0, y = 0, skewX = 0, skewY = 0, scaleX = 1, scaleY = 1,
): Transform {
  return { x, y, skewX, skewY, scaleX, scaleY };
}

export const IDENTITY: Readonly<Transform> = Object.freeze(tf());

export function cloneTf(t: Transform): Transform {
  return { x: t.x, y: t.y, skewX: t.skewX, skewY: t.skewY, scaleX: t.scaleX, scaleY: t.scaleY };
}

export function copyTf(out: Transform, t: Transform): Transform {
  out.x = t.x; out.y = t.y;
  out.skewX = t.skewX; out.skewY = t.skewY;
  out.scaleX = t.scaleX; out.scaleY = t.scaleY;
  return out;
}

export function equalsTf(a: Transform, b: Transform, eps = 1e-6): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps &&
         Math.abs(a.skewX - b.skewX) <= eps && Math.abs(a.skewY - b.skewY) <= eps &&
         Math.abs(a.scaleX - b.scaleX) <= eps && Math.abs(a.scaleY - b.scaleY) <= eps;
}

/**
 * Transform -> matrix. Byte-for-byte the runtime's composition:
 *   a =  cos(skewY) * scaleX      c = -sin(skewX) * scaleY
 *   b =  sin(skewY) * scaleX      d =  cos(skewX) * scaleY
 */
export function toMatrix(out: Matrix2D, t: Transform): Matrix2D {
  const rx = t.skewX * DEG_RAD;
  const ry = t.skewY * DEG_RAD;
  out.a = Math.cos(ry) * t.scaleX;
  out.b = Math.sin(ry) * t.scaleX;
  out.c = -Math.sin(rx) * t.scaleY;
  out.d = Math.cos(rx) * t.scaleY;
  out.tx = t.x;
  out.ty = t.y;
  return out;
}

export function matrixOf(t: Transform): Matrix2D {
  return toMatrix(matOf(1, 0, 0, 1, 0, 0), t);
}

/**
 * Matrix -> Transform, by independent column extraction.
 *
 * Column 0 (a, b) carries scaleX and skewY; column 1 (c, d) carries scaleY
 * and skewX. Six parameters, six degrees of freedom, so this is EXACT — no
 * candidate search, no `toFixed` comparisons, and well-conditioned right up
 * to +/-90 degrees.
 *
 * The only ambiguity is the two scale signs: (scaleX, skewY) and
 * (-scaleX, skewY + 180) describe the same column. `prev` resolves it by
 * continuity, which is what keeps a gizmo drag from popping by 180 degrees
 * as a handle crosses its anchor. Without `prev`, scales come back positive.
 */
export function fromMatrix(out: Transform, m: Matrix2D, prev?: Transform): Transform {
  let sx = Math.hypot(m.a, m.b);
  let sy = Math.hypot(m.c, m.d);
  let skewY = Math.atan2(m.b, m.a) * RAD_DEG;
  let skewX = Math.atan2(-m.c, m.d) * RAD_DEG;

  if (prev) {
    // Flipping a column means negating its scale and rotating its angle by
    // 180. Pick whichever of the two equivalent forms sits nearer `prev`.
    if (prev.scaleX < 0 && negCloser(skewY, prev.skewY)) { sx = -sx; skewY = fold180(skewY); }
    if (prev.scaleY < 0 && negCloser(skewX, prev.skewX)) { sy = -sy; skewX = fold180(skewX); }
    // Keep multi-turn angles from collapsing: re-express near the previous
    // value so an accumulated 720 degrees stays 720 rather than snapping to 0.
    skewY = nearest(skewY, prev.skewY);
    skewX = nearest(skewX, prev.skewX);
  }

  out.x = nz(m.tx);
  out.y = nz(m.ty);
  out.skewX = nz(skewX);
  out.skewY = nz(skewY);
  out.scaleX = nz(sx);
  out.scaleY = nz(sy);
  return out;
}

function fold180(deg: number): number {
  return deg > 0 ? deg - 180 : deg + 180;
}

/** True when the 180-degree-folded form lands closer to `target`. */
function negCloser(deg: number, target: number): boolean {
  const direct = Math.abs(wrapDiff(deg, target));
  const folded = Math.abs(wrapDiff(fold180(deg), target));
  return folded < direct;
}

function wrapDiff(a: number, b: number): number {
  let v = (a - b + 180) % 360;
  if (v <= 0) v += 360;
  return v - 180;
}

/** The representative of `deg` (mod 360) closest to `near`. */
function nearest(deg: number, near: number): number {
  return near + wrapDiff(deg, near);
}

/**
 * Rotate by `deltaDeg` about the transform's own origin.
 *
 * This is the identity that makes the Free Transform gizmo exact: because
 * pre-multiplying the linear part by R(theta) shifts BOTH skew angles by
 * theta and leaves BOTH scales untouched, the Flash parameterisation is
 * closed under rotation. So rotation never needs a decomposition round-trip,
 * shear survives it perfectly, and multi-turn angles accumulate honestly.
 */
export function rotateBy(out: Transform, t: Transform, deltaDeg: number): Transform {
  out.x = t.x; out.y = t.y;
  out.skewX = t.skewX + deltaDeg;
  out.skewY = t.skewY + deltaDeg;
  out.scaleX = t.scaleX; out.scaleY = t.scaleY;
  return out;
}

/**
 * Move a transform's origin by a delta expressed in ITS OWN local frame,
 * leaving the linear part alone.
 *
 * This is the pivot compensation: the artwork hangs off the origin at
 * -pivot, so moving the transform point by d has to move the origin by d
 * through the transform's own basis for the artwork to stay put. Doing it on
 * the transform rather than on world matrices keeps it exact when a parent is
 * scaled to nothing.
 */
export function translateLocal(out: Transform, t: Transform, dx: number, dy: number): Transform {
  const m = matrixOf(t);
  out.x = t.x + m.a * dx + m.c * dy;
  out.y = t.y + m.b * dx + m.d * dy;
  out.skewX = t.skewX;
  out.skewY = t.skewY;
  out.scaleX = t.scaleX;
  out.scaleY = t.scaleY;
  return out;
}

/** True rotation only when there is no shear. */
export function isPureRotation(t: Transform, eps = 1e-6): boolean {
  return Math.abs(t.skewX - t.skewY) <= eps;
}

/** Shear amount in degrees; 0 for a pure rotation. */
export function shearOf(t: Transform): number {
  return t.skewX - t.skewY;
}

export function clampScale(v: number): number {
  if (!Number.isFinite(v) || v === 0) return MIN_SCALE;
  return Math.abs(v) < MIN_SCALE ? Math.sign(v) * MIN_SCALE : v;
}

/**
 * Quantise for storage/serialisation. Applied on command commit, never
 * mid-drag, so golden files stay stable without the gizmo feeling sticky.
 */
export function quantize(t: Transform): Transform {
  return {
    x: nz(Math.round(t.x * 100) / 100),
    y: nz(Math.round(t.y * 100) / 100),
    skewX: nz(Math.round(t.skewX * 100) / 100),
    skewY: nz(Math.round(t.skewY * 100) / 100),
    scaleX: nz(Math.round(t.scaleX * 10000) / 10000),
    scaleY: nz(Math.round(t.scaleY * 10000) / 10000),
  };
}

/** Linear interpolation used by the editor's tween sampler. */
export function lerpTf(out: Transform, a: Transform, b: Transform, t: number): Transform {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.skewX = a.skewX + (b.skewX - a.skewX) * t;
  out.skewY = a.skewY + (b.skewY - a.skewY) * t;
  out.scaleX = a.scaleX + (b.scaleX - a.scaleX) * t;
  out.scaleY = a.scaleY + (b.scaleY - a.scaleY) * t;
  return out;
}
