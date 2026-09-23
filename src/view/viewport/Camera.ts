import { apply, clone, invert, mat, matOf, type Matrix2D, mul } from "@/core/math/Matrix2D";
import type { Point, Rect } from "@/core/math/geom";

/**
 * World <-> screen mapping for the stage.
 *
 *   scene  = base * world          (identity unless editing a symbol in place)
 *   screen = scene * zoom + pan    (pan is in screen pixels)
 *
 * Screen coordinates are relative to the CONTENT area — the region inside
 * the rulers — so ruler thickness never leaks into the transform maths.
 *
 * `base` is what makes edit-in-place behave like Flash: descending into an
 * instance multiplies it by that instance's world matrix, so the contents
 * keep the position, size and deformation they had a moment earlier, without
 * the camera moving at all. Zoom and pan stay SCENE concepts — `zoomAt`,
 * `fit`, `centerOn` and `panBy` never look at `base`.
 */
export class Camera {
  zoom = 1;
  panX = 0;
  panY = 0;

  /** Current symbol space -> scene space. */
  base: Matrix2D = mat();

  /** Content area size in CSS pixels. */
  width = 0;
  height = 0;

  setBase(m: Matrix2D): void { this.base = clone(m); }

  /** How many screen pixels one unit of the CURRENT space measures. */
  get screenScale(): number {
    return this.zoom * Math.hypot(this.base.a, this.base.b);
  }

  toScreen(wx: number, wy: number, out: Point = { x: 0, y: 0 }): Point {
    const p = apply({ x: 0, y: 0 }, this.base, wx, wy);
    return this.sceneToScreen(p.x, p.y, out);
  }

  toWorld(sx: number, sy: number, out: Point = { x: 0, y: 0 }): Point {
    const s = this.screenToScene(sx, sy);
    const inv = mat();
    if (!invert(inv, this.base)) { out.x = s.x; out.y = s.y; return out; }
    return apply(out, inv, s.x, s.y);
  }

  /** Scene space -> screen, ignoring `base`: the stage rect, grid and rulers. */
  sceneToScreen(x: number, y: number, out: Point = { x: 0, y: 0 }): Point {
    out.x = x * this.zoom + this.panX;
    out.y = y * this.zoom + this.panY;
    return out;
  }

  screenToScene(sx: number, sy: number, out: Point = { x: 0, y: 0 }): Point {
    out.x = (sx - this.panX) / this.zoom;
    out.y = (sy - this.panY) / this.zoom;
    return out;
  }

  /** Scene space -> screen, as a matrix. */
  get sceneMatrix(): Matrix2D {
    return matOf(this.zoom, 0, 0, this.zoom, this.panX, this.panY);
  }

  get matrix(): Matrix2D {
    return mul(mat(), this.sceneMatrix, this.base);
  }

  /** Zoom while keeping the world point under (sx, sy) pinned. */
  zoomAt(sx: number, sy: number, factor: number, min = 0.02, max = 64): void {
    const next = Math.max(min, Math.min(max, this.zoom * factor));
    if (next === this.zoom) return;
    const w = this.screenToScene(sx, sy);
    this.zoom = next;
    this.panX = sx - w.x * next;
    this.panY = sy - w.y * next;
  }

  setZoom(zoom: number): void {
    this.zoomAt(this.width / 2, this.height / 2, zoom / this.zoom);
  }

  panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
  }

  /** Frame a world rect with padding, clamped to a sane zoom. */
  fit(r: Rect, padding = 40): void {
    if (r.w <= 0 || r.h <= 0 || this.width <= 0 || this.height <= 0) return;
    const zoom = Math.min(
      (this.width - padding * 2) / r.w,
      (this.height - padding * 2) / r.h,
    );
    this.zoom = Math.max(0.02, Math.min(64, zoom));
    this.panX = this.width / 2 - (r.x + r.w / 2) * this.zoom;
    this.panY = this.height / 2 - (r.y + r.h / 2) * this.zoom;
  }

  centerOn(x: number, y: number): void {
    this.panX = this.width / 2 - x * this.zoom;
    this.panY = this.height / 2 - y * this.zoom;
  }
}
