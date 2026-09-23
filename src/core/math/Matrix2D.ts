/**
 * 2D affine matrix in the same layout DragonBones (and Flash) use.
 *
 *   | a  c  tx |
 *   | b  d  ty |
 *   | 0  0   1 |
 *
 * Every operation takes an explicit `out` so hot paths (rendering, hit
 * testing, gizmo drags) allocate nothing.
 */
export interface Matrix2D {
  a: number; b: number; c: number; d: number; tx: number; ty: number;
}

export function mat(): Matrix2D {
  return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
}

export function matOf(a: number, b: number, c: number, d: number, tx: number, ty: number): Matrix2D {
  return { a, b, c, d, tx, ty };
}

export function identity(out: Matrix2D): Matrix2D {
  out.a = 1; out.b = 0; out.c = 0; out.d = 1; out.tx = 0; out.ty = 0;
  return out;
}

export function copy(out: Matrix2D, m: Matrix2D): Matrix2D {
  out.a = m.a; out.b = m.b; out.c = m.c; out.d = m.d; out.tx = m.tx; out.ty = m.ty;
  return out;
}

export function clone(m: Matrix2D): Matrix2D {
  return { a: m.a, b: m.b, c: m.c, d: m.d, tx: m.tx, ty: m.ty };
}

/**
 * out = l * r  — apply `r` first, then `l`.
 * For a scene graph: `mul(out, parentWorld, childLocal)`.
 * Safe when `out` aliases `l` or `r`.
 */
export function mul(out: Matrix2D, l: Matrix2D, r: Matrix2D): Matrix2D {
  const a = l.a * r.a + l.c * r.b;
  const b = l.b * r.a + l.d * r.b;
  const c = l.a * r.c + l.c * r.d;
  const d = l.b * r.c + l.d * r.d;
  const tx = l.a * r.tx + l.c * r.ty + l.tx;
  const ty = l.b * r.tx + l.d * r.ty + l.ty;
  out.a = a; out.b = b; out.c = c; out.d = d; out.tx = tx; out.ty = ty;
  return out;
}

export function determinant(m: Matrix2D): number {
  return m.a * m.d - m.b * m.c;
}

/** Returns false (leaving `out` untouched) when `m` is singular. */
export function invert(out: Matrix2D, m: Matrix2D): boolean {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0 || !Number.isFinite(det)) return false;
  const k = 1 / det;
  const a = m.d * k;
  const b = -m.b * k;
  const c = -m.c * k;
  const d = m.a * k;
  const tx = (m.c * m.ty - m.d * m.tx) * k;
  const ty = (m.b * m.tx - m.a * m.ty) * k;
  out.a = a; out.b = b; out.c = c; out.d = d; out.tx = tx; out.ty = ty;
  return true;
}

export interface Pt { x: number; y: number; }

/** Full transform, translation included. */
export function apply(out: Pt, m: Matrix2D, x: number, y: number): Pt {
  out.x = m.a * x + m.c * y + m.tx;
  out.y = m.b * x + m.d * y + m.ty;
  return out;
}

/** Linear part only — for directions and deltas. */
export function applyVec(out: Pt, m: Matrix2D, x: number, y: number): Pt {
  out.x = m.a * x + m.c * y;
  out.y = m.b * x + m.d * y;
  return out;
}

/** Inverse-transform a point without materialising the inverse matrix. */
export function applyInverse(out: Pt, m: Matrix2D, x: number, y: number): boolean {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0 || !Number.isFinite(det)) return false;
  const k = 1 / det;
  const px = x - m.tx;
  const py = y - m.ty;
  out.x = (m.d * px - m.c * py) * k;
  out.y = (m.a * py - m.b * px) * k;
  return true;
}

export function translate(out: Matrix2D, x: number, y: number): Matrix2D {
  out.a = 1; out.b = 0; out.c = 0; out.d = 1; out.tx = x; out.ty = y;
  return out;
}

/** Rotation by `rad`, counter-clockwise in a y-down space. */
export function rotation(out: Matrix2D, rad: number): Matrix2D {
  const s = Math.sin(rad), c = Math.cos(rad);
  out.a = c; out.b = s; out.c = -s; out.d = c; out.tx = 0; out.ty = 0;
  return out;
}

export function equalsEps(l: Matrix2D, r: Matrix2D, eps = 1e-6): boolean {
  return Math.abs(l.a - r.a) <= eps && Math.abs(l.b - r.b) <= eps &&
         Math.abs(l.c - r.c) <= eps && Math.abs(l.d - r.d) <= eps &&
         Math.abs(l.tx - r.tx) <= eps && Math.abs(l.ty - r.ty) <= eps;
}

/** For `ctx.setTransform(...)`. */
export function toCanvas(m: Matrix2D): [number, number, number, number, number, number] {
  return [m.a, m.b, m.c, m.d, m.tx, m.ty];
}
