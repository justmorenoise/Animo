import { apply, type Matrix2D } from "./Matrix2D";

export interface Point { x: number; y: number; }
export interface Rect { x: number; y: number; w: number; h: number; }

export function pt(x = 0, y = 0): Point { return { x, y }; }
export function rect(x = 0, y = 0, w = 0, h = 0): Rect { return { x, y, w, h }; }

export const EMPTY_RECT: Readonly<Rect> = Object.freeze({ x: 0, y: 0, w: 0, h: 0 });

export function rectRight(r: Rect): number { return r.x + r.w; }
export function rectBottom(r: Rect): number { return r.y + r.h; }
export function rectCenter(r: Rect): Point { return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export function rectIntersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function rectUnion(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function rectInflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

/** Normalise a rect built from two drag corners. */
export function rectFromPoints(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    x: Math.min(x0, x1), y: Math.min(y0, y1),
    w: Math.abs(x1 - x0), h: Math.abs(y1 - y0),
  };
}

/** Axis-aligned bounds of a rect after an affine transform. */
export function transformRect(m: Matrix2D, r: Rect): Rect {
  const p = pt();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const xs = [r.x, r.x + r.w];
  const ys = [r.y, r.y + r.h];
  for (const x of xs) {
    for (const y of ys) {
      apply(p, m, x, y);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The four corners of a rect after a transform, in TL, TR, BR, BL order. */
export function transformCorners(m: Matrix2D, r: Rect): [Point, Point, Point, Point] {
  return [
    apply(pt(), m, r.x, r.y),
    apply(pt(), m, r.x + r.w, r.y),
    apply(pt(), m, r.x + r.w, r.y + r.h),
    apply(pt(), m, r.x, r.y + r.h),
  ];
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

/** Winding test — used for marquee selection against rotated bounds. */
export function polygonContains(poly: readonly Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!, pj = poly[j]!;
    if ((pi.y > y) !== (pj.y > y) &&
        x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) {
      inside = !inside;
    }
  }
  return inside;
}
