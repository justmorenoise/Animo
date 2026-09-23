/**
 * Editing operations on a custom ease curve, in the editor's form (see
 * `TweenSpec` in `easing.ts`): `[c1x,c1y, c2x,c2y, (ax,ay, c1x,c1y, c2x,c2y)*]`
 * with (0,0) and (1,1) implicit.
 *
 * The runtime finds the bezier parameter for a given x by bisection inside
 * one segment, which only answers correctly when x never turns back. So
 * every operation ends in `constrain`: anchors strictly increasing in x, and
 * inside each segment the control xs non-decreasing
 * (start ≤ c1 ≤ c2 ≤ end), which makes the Bernstein x polynomial monotone.
 */

export interface CurveAnchor {
  x: number; y: number;
  /** Handle towards the previous anchor (unused on the first). */
  inX: number; inY: number;
  /** Handle towards the next anchor (unused on the last). */
  outX: number; outY: number;
}

const MIN_GAP = 0.01;
const Y_LIMIT = 3;

export function anchorsOf(curve: readonly number[]): CurveAnchor[] {
  const segs = (curve.length - 4) / 6;
  const out: CurveAnchor[] = [{ x: 0, y: 0, inX: 0, inY: 0, outX: curve[0]!, outY: curve[1]! }];
  let i = 2;
  for (let s = 0; s < segs; s++) {
    out.push({
      inX: curve[i]!, inY: curve[i + 1]!,
      x: curve[i + 2]!, y: curve[i + 3]!,
      outX: curve[i + 4]!, outY: curve[i + 5]!,
    });
    i += 6;
  }
  out.push({ x: 1, y: 1, inX: curve[i]!, inY: curve[i + 1]!, outX: 1, outY: 1 });
  return out;
}

export function fromAnchors(anchors: readonly CurveAnchor[]): number[] {
  const out: number[] = [anchors[0]!.outX, anchors[0]!.outY];
  for (let i = 1; i < anchors.length - 1; i++) {
    const a = anchors[i]!;
    out.push(a.inX, a.inY, a.x, a.y, a.outX, a.outY);
  }
  const last = anchors[anchors.length - 1]!;
  out.push(last.inX, last.inY);
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function constrain(input: readonly CurveAnchor[]): CurveAnchor[] {
  const a = input.map((p) => ({ ...p }));
  const n = a.length;
  a[0]!.x = 0; a[0]!.y = 0;
  a[n - 1]!.x = 1; a[n - 1]!.y = 1;
  for (let i = 1; i < n - 1; i++) {
    const lo = a[i - 1]!.x + MIN_GAP;
    const hi = 1 - MIN_GAP * (n - 1 - i);
    a[i]!.x = clamp(a[i]!.x, lo, Math.max(lo, hi));
    a[i]!.y = clamp(a[i]!.y, -Y_LIMIT, Y_LIMIT);
  }
  for (let i = 0; i < n; i++) {
    const p = a[i]!;
    p.inY = clamp(p.inY, -Y_LIMIT, Y_LIMIT);
    p.outY = clamp(p.outY, -Y_LIMIT, Y_LIMIT);
  }
  for (let i = 0; i < n - 1; i++) {
    const s = a[i]!, e = a[i + 1]!;
    s.outX = clamp(s.outX, s.x, e.x);
    e.inX = clamp(e.inX, s.x, e.x);
    if (s.outX > e.inX) s.outX = e.inX = (s.outX + e.inX) / 2;
  }
  return a;
}

function bez(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const l = 1 - t;
  return l * l * l * p0 + 3 * l * l * t * p1 + 3 * l * t * t * p2 + t * t * t * p3;
}

/** Index of the segment (start anchor) containing x. */
function segmentAt(anchors: readonly CurveAnchor[], x: number): number {
  for (let i = 0; i < anchors.length - 1; i++) {
    if (x <= anchors[i + 1]!.x) return i;
  }
  return anchors.length - 2;
}

function paramAt(s: CurveAnchor, e: CurveAnchor, x: number): number {
  let lo = 0, hi = 1;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (bez(s.x, s.outX, e.inX, e.x, mid) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The curve's y at x — the ideal value, not the runtime's sample. */
export function curveValueAt(curve: readonly number[], x: number): number {
  const a = anchorsOf(curve);
  const i = segmentAt(a, x);
  const s = a[i]!, e = a[i + 1]!;
  return bez(s.y, s.outY, e.inY, e.y, paramAt(s, e, x));
}

/**
 * Split the segment under x at the curve point there (de Casteljau), so the
 * shape is unchanged and the new anchor starts smooth. Returns the new
 * anchor's index, or -1 when x is too close to an existing anchor.
 */
export function insertAnchor(curve: readonly number[], x: number): { curve: number[]; index: number } {
  const a = anchorsOf(curve);
  const i = segmentAt(a, x);
  const s = a[i]!, e = a[i + 1]!;
  if (x - s.x < MIN_GAP || e.x - x < MIN_GAP) return { curve: [...curve], index: -1 };
  const t = paramAt(s, e, x);
  const lerp = (p: number, q: number) => p + (q - p) * t;

  const ax = lerp(s.x, s.outX), ay = lerp(s.y, s.outY);
  const bx = lerp(s.outX, e.inX), by = lerp(s.outY, e.inY);
  const cx = lerp(e.inX, e.x), cy = lerp(e.inY, e.y);
  const dx = lerp(ax, bx), dy = lerp(ay, by);
  const ex = lerp(bx, cx), ey = lerp(by, cy);
  const px = lerp(dx, ex), py = lerp(dy, ey);

  const next = a.map((p) => ({ ...p }));
  next[i]!.outX = ax; next[i]!.outY = ay;
  next[i + 1]!.inX = cx; next[i + 1]!.inY = cy;
  next.splice(i + 1, 0, { x: px, y: py, inX: dx, inY: dy, outX: ex, outY: ey });
  return { curve: fromAnchors(constrain(next)), index: i + 1 };
}

/** Interior anchors only: the endpoints are fixed by the format. */
export function removeAnchor(curve: readonly number[], index: number): number[] {
  const a = anchorsOf(curve);
  if (index <= 0 || index >= a.length - 1) return [...curve];
  a.splice(index, 1);
  return fromAnchors(constrain(a));
}

export function moveAnchor(curve: readonly number[], index: number, x: number, y: number): number[] {
  const a = anchorsOf(curve);
  if (index <= 0 || index >= a.length - 1) return [...curve];
  const p = a[index]!;
  const lo = a[index - 1]!.x + MIN_GAP;
  const hi = a[index + 1]!.x - MIN_GAP;
  const nx = clamp(x, lo, Math.max(lo, hi));
  const ny = clamp(y, -Y_LIMIT, Y_LIMIT);
  const dx = nx - p.x, dy = ny - p.y;
  a[index] = { x: nx, y: ny, inX: p.inX + dx, inY: p.inY + dy, outX: p.outX + dx, outY: p.outY + dy };
  return fromAnchors(constrain(a));
}

/**
 * Move one handle. With `mirror` the opposite handle turns to stay
 * collinear, keeping its own length (or taking this one's, if it had none):
 * a smooth anchor stays smooth.
 */
export function moveHandle(
  curve: readonly number[], index: number, side: "in" | "out", x: number, y: number, mirror: boolean,
): number[] {
  const a = anchorsOf(curve);
  const p = a[index]!;
  if (side === "in") { p.inX = x; p.inY = y; }
  else { p.outX = x; p.outY = y; }

  const interior = index > 0 && index < a.length - 1;
  if (mirror && interior) {
    const hx = side === "in" ? p.inX : p.outX;
    const hy = side === "in" ? p.inY : p.outY;
    const ox = side === "in" ? p.outX : p.inX;
    const oy = side === "in" ? p.outY : p.inY;
    const len = Math.hypot(hx - p.x, hy - p.y);
    const oLen = Math.hypot(ox - p.x, oy - p.y) || len;
    if (len > 1e-9) {
      const mx = p.x - ((hx - p.x) / len) * oLen;
      const my = p.y - ((hy - p.y) / len) * oLen;
      if (side === "in") { p.outX = mx; p.outY = my; }
      else { p.inX = mx; p.inY = my; }
    }
  }
  return fromAnchors(constrain(a));
}

/** Alt-drag on an anchor: pull both handles out, symmetric about it. */
export function pullHandles(curve: readonly number[], index: number, x: number, y: number): number[] {
  const a = anchorsOf(curve);
  const p = a[index]!;
  p.outX = x; p.outY = y;
  p.inX = 2 * p.x - x; p.inY = 2 * p.y - y;
  return fromAnchors(constrain(a));
}

/** Collapse both handles onto the anchor: a corner. */
export function toCorner(curve: readonly number[], index: number): number[] {
  const a = anchorsOf(curve);
  const p = a[index]!;
  p.inX = p.outX = p.x;
  p.inY = p.outY = p.y;
  return fromAnchors(constrain(a));
}
