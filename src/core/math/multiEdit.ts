import { apply, invert, mat, type Matrix2D, mul } from "./Matrix2D";
import { cloneTf, fromMatrix, toMatrix, type Transform } from "./Transform";
import { DEG_RAD } from "./angle";

/**
 * One stage edit, re-applied to many keyframes: Edit Multiple Frames.
 *
 * The tool (or the Properties panel) says what the node at the playhead should
 * become. `deriveEdit` turns that before/after pair into the change itself,
 * expressed in the PARENT's space, and `applyFrameEdit` applies the same change
 * to any other keyframe. Every instance between the markers therefore moves as
 * if they were one object — the virtual group: a move shifts them all by the
 * same vector, a rotation swings them all about the same point.
 *
 * The three kinds exist so the common cases never decompose a matrix. A move
 * only adds to x/y. A rotation adds θ to BOTH skews, like `rotateAbout`, so
 * shear survives exactly and multi-turn angles keep accumulating (see the
 * Transform model in CLAUDE.md). Only scale and skew go through
 * `fromMatrix`, with each key's own values supplying sign continuity.
 */
export type FrameEdit =
  | { kind: "none" }
  | { kind: "translate"; dx: number; dy: number }
  /** `d` carries the positions: rotation by `theta` plus the offset that
   *  takes the playhead key's origin where the tool put it. */
  | { kind: "rotate"; theta: number; d: Matrix2D }
  | { kind: "affine"; d: Matrix2D };

const EPS = 1e-9;

const near = (a: number, b: number) => Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));

export function deriveEdit(before: Transform, after: Transform): FrameEdit {
  const sameScale = near(before.scaleX, after.scaleX) && near(before.scaleY, after.scaleY);
  const dSkX = after.skewX - before.skewX;
  const dSkY = after.skewY - before.skewY;

  if (sameScale && near(dSkX, 0) && near(dSkY, 0)) {
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    return near(dx, 0) && near(dy, 0) ? { kind: "none" } : { kind: "translate", dx, dy };
  }

  if (sameScale && near(dSkX, dSkY)) {
    const rad = dSkY * DEG_RAD;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    // Rotate every origin by θ, then shift so the playhead key's origin lands
    // exactly where the tool put it: t' = R·t + (t1 − R·t0).
    const tx = after.x - (cos * before.x - sin * before.y);
    const ty = after.y - (sin * before.x + cos * before.y);
    return { kind: "rotate", theta: dSkY, d: { a: cos, b: sin, c: -sin, d: cos, tx, ty } };
  }

  const m0 = toMatrix(mat(), before);
  const m1 = toMatrix(mat(), after);
  const inv = mat();
  if (!invert(inv, m0)) return { kind: "none" };
  return { kind: "affine", d: mul(mat(), m1, inv) };
}

export function applyFrameEdit(t: Transform, edit: FrameEdit): Transform {
  const out = cloneTf(t);
  switch (edit.kind) {
    case "none":
      return out;
    case "translate":
      out.x = t.x + edit.dx;
      out.y = t.y + edit.dy;
      return out;
    case "rotate": {
      const p = apply({ x: 0, y: 0 }, edit.d, t.x, t.y);
      out.x = p.x;
      out.y = p.y;
      out.skewX = t.skewX + edit.theta;
      out.skewY = t.skewY + edit.theta;
      return out;
    }
    case "affine":
      return fromMatrix(out, mul(mat(), edit.d, toMatrix(mat(), t)), t);
  }
}
