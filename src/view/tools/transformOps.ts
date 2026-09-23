import { apply, applyInverse, clone, invert, mat, matOf, type Matrix2D, mul } from "@/core/math/Matrix2D";
import { clampScale, cloneTf, fromMatrix, toMatrix, type Transform } from "@/core/math/Transform";
import { DEG_RAD, RAD_DEG } from "@/core/math/angle";
import type { Point, Rect } from "@/core/math/geom";
import type { NodeId } from "@/core/doc/ids";

/**
 * Per-node state captured once at pointer-down.
 *
 * Every operation below recomputes from THIS snapshot rather than
 * accumulating frame to frame. That single rule removes the whole class of
 * drift and instability bugs that plague incremental gizmos.
 */
export interface NodeSnapshot {
  id: NodeId;
  /**
   * The node's local transform when the drag began. In Setup mode that is
   * the bind pose; in Animate mode it is the pose at the playhead. Naming it
   * `bind` invited exactly the mistake of writing results back to the bind
   * pose while the user was animating.
   */
  local: Transform;
  /** World matrix at drag start. */
  world: Matrix2D;
  /** Parent's world matrix, identity when the node is a root. */
  parent: Matrix2D;
  /** Transform point at drag start, in untrimmed image pixels. */
  pivot: { x: number; y: number };
  /** The display that transform point belongs to (`SetPivot`'s `displays`). */
  display: number;
}

const IDENT = matOf(1, 0, 0, 1, 0, 0);

export function snapshotOf(
  id: NodeId,
  local: Transform,
  world: Matrix2D,
  parent?: Matrix2D,
  pivot?: { x: number; y: number },
  display = 0,
): NodeSnapshot {
  return {
    id,
    local: cloneTf(local),
    world: clone(world),
    parent: parent ? clone(parent) : clone(IDENT),
    pivot: pivot ? { ...pivot } : { x: 0, y: 0 },
    display,
  };
}

/**
 * The selected nodes a transform should write. A node whose ancestor is also
 * selected already moves with that ancestor, and writing it as well applied
 * every drag, nudge and rotation twice — ⌘A then a drag threw every child off
 * by the full distance. Selection order is kept.
 */
export function topmostSelected(
  ids: readonly NodeId[], parentOf: (id: NodeId) => NodeId | null | undefined,
): NodeId[] {
  const chosen = new Set(ids);
  return ids.filter((id) => {
    const seen = new Set<NodeId>([id]);
    for (let p = parentOf(id); p && !seen.has(p); p = parentOf(p)) {
      if (chosen.has(p)) return false;
      seen.add(p);
    }
    return true;
  });
}

/** Linear part only, translation dropped. */
function linear(m: Matrix2D): Matrix2D {
  return matOf(m.a, m.b, m.c, m.d, 0, 0);
}

/** A world-space point expressed in a node's parent space. */
function toParent(snap: NodeSnapshot, wx: number, wy: number): Point {
  const out = { x: 0, y: 0 };
  if (!applyInverse(out, snap.parent, wx, wy)) return { x: wx, y: wy };
  return out;
}

/** A world-space delta expressed in a node's parent space. */
function deltaToParent(snap: NodeSnapshot, dx: number, dy: number): Point {
  const out = { x: 0, y: 0 };
  if (!applyInverse(out, linear(snap.parent), dx, dy)) return { x: dx, y: dy };
  return out;
}

/* ── Move ────────────────────────────────────────────────────────────────*/

export function moveBy(snap: NodeSnapshot, dxWorld: number, dyWorld: number): Transform {
  const d = deltaToParent(snap, dxWorld, dyWorld);
  const t = cloneTf(snap.local);
  t.x = snap.local.x + d.x;
  t.y = snap.local.y + d.y;
  return t;
}

/* ── Rotate ──────────────────────────────────────────────────────────────
   Rotation adds theta to BOTH skew angles and leaves both scales alone,
   because the Flash parameterisation is closed under rotation. So this
   never round-trips through a decomposition: shear survives exactly, and a
   multi-turn drag keeps accumulating past 360 instead of wrapping — which
   matters later, because `rotateFrame.clockwise` is derived from how far an
   angle actually travelled.                                                */

export function rotateAbout(snap: NodeSnapshot, anchor: Point, thetaDeg: number): Transform {
  const rad = thetaDeg * DEG_RAD;
  const cos = Math.cos(rad), sin = Math.sin(rad);

  // New world origin: the old one, swung about the anchor.
  const ox = snap.world.tx - anchor.x;
  const oy = snap.world.ty - anchor.y;
  const wx = anchor.x + ox * cos - oy * sin;
  const wy = anchor.y + ox * sin + oy * cos;
  const p = toParent(snap, wx, wy);

  // A mirrored parent reverses the apparent direction of rotation.
  const det = snap.parent.a * snap.parent.d - snap.parent.b * snap.parent.c;
  const localTheta = det < 0 ? -thetaDeg : thetaDeg;

  const t = cloneTf(snap.local);
  t.x = p.x;
  t.y = p.y;
  t.skewX = snap.local.skewX + localTheta;
  t.skewY = snap.local.skewY + localTheta;
  return t;
}

/* ── Scale, single selection, along the object's own axes ────────────────*/

export interface LocalScaleArgs {
  snap: NodeSnapshot;
  /** The object's local drawing box at drag start. */
  box: Rect;
  /** Anchor and dragged handle, as 0..1 fractions of the box. */
  anchor: { fx: number; fy: number };
  handle: { fx: number; fy: number };
  /** Pointer in world space. */
  pointer: Point;
  uniform: boolean;
  /** Scale about the anchor (default) or about the box centre (Alt). */
  fromCenter: boolean;
}

export function scaleLocal(a: LocalScaleArgs): Transform {
  const { snap, box } = a;
  const anchorFrac = a.fromCenter ? { fx: 0.5, fy: 0.5 } : a.anchor;

  const A = { x: box.x + anchorFrac.fx * box.w, y: box.y + anchorFrac.fy * box.h };
  const H = { x: box.x + a.handle.fx * box.w, y: box.y + a.handle.fy * box.h };

  // Pointer in the STARTING local space.
  const q = { x: 0, y: 0 };
  if (!applyInverse(q, snap.world, a.pointer.x, a.pointer.y)) return cloneTf(snap.local);

  const spanX = H.x - A.x;
  const spanY = H.y - A.y;
  let sx = Math.abs(spanX) > 1e-6 ? (q.x - A.x) / spanX : 1;
  let sy = Math.abs(spanY) > 1e-6 ? (q.y - A.y) / spanY : 1;

  if (a.uniform) {
    const s = uniformFactor(sx, sy, Math.abs(spanX) > 1e-6, Math.abs(spanY) > 1e-6);
    if (Math.abs(spanX) > 1e-6) sx = Math.sign(sx || 1) * s;
    if (Math.abs(spanY) > 1e-6) sy = Math.sign(sy || 1) * s;
  }

  const t = cloneTf(snap.local);
  t.scaleX = clampScale(snap.local.scaleX * sx);
  t.scaleY = clampScale(snap.local.scaleY * sy);

  // Re-solve the translation so the anchor point does not move.
  const anchorWorld = apply({ x: 0, y: 0 }, snap.world, A.x, A.y);
  const anchorParent = toParent(snap, anchorWorld.x, anchorWorld.y);
  const lin = toMatrix(mat(), { ...t, x: 0, y: 0 });
  t.x = anchorParent.x - (lin.a * A.x + lin.c * A.y);
  t.y = anchorParent.y - (lin.b * A.x + lin.d * A.y);
  return t;
}

/**
 * The one factor a ⇧-scale applies: the larger change among the axes the
 * handle actually drags. An edge handle drags one axis, and the idle one
 * (always 1) used to win every shrink, so ⇧ on an edge could only grow.
 */
export function uniformFactor(sx: number, sy: number, dragsX: boolean, dragsY: boolean): number {
  if (dragsX && !dragsY) return Math.abs(sx);
  if (dragsY && !dragsX) return Math.abs(sy);
  return Math.max(Math.abs(sx), Math.abs(sy));
}

/* ── Skew, single selection ──────────────────────────────────────────────
   Built as a RIGHT-multiplication in local space, `A' = A0 * Shear(k)`.
   Applying the shear on the local side leaves one whole matrix column
   untouched, so exactly one scale/skew pair changes and it can be read back
   from a single column — exact and well-conditioned, with no decomposition
   of the full matrix.                                                      */

export function skewLocal(
  snap: NodeSnapshot,
  box: Rect,
  edge: "n" | "e" | "s" | "w",
  pointer: Point,
  startPointer: Point,
): Transform {
  const q = { x: 0, y: 0 }, q0 = { x: 0, y: 0 };
  if (!applyInverse(q, snap.world, pointer.x, pointer.y)) return cloneTf(snap.local);
  if (!applyInverse(q0, snap.world, startPointer.x, startPointer.y)) return cloneTf(snap.local);

  const m0 = toMatrix(mat(), { ...snap.local, x: 0, y: 0 });
  const t = cloneTf(snap.local);

  if (edge === "n" || edge === "s") {
    // Horizontal drag tilts the vertical sides -> local Y axis -> skewX.
    const span = Math.max(1e-6, box.h);
    const dir = edge === "n" ? -1 : 1;
    const k = (dir * (q.x - q0.x)) / span;
    const c = m0.a * k + m0.c;
    const d = m0.b * k + m0.d;
    // The column carries the scale's sign; read the angle with it divided
    // out, or a flipped object turns half a turn and un-flips.
    const sign = Math.sign(snap.local.scaleY || 1);
    t.scaleY = clampScale(sign * Math.hypot(c, d));
    t.skewX = nearestAngle(Math.atan2(-c * sign, d * sign) * RAD_DEG, snap.local.skewX);
  } else {
    // Vertical drag tilts the horizontal sides -> local X axis -> skewY.
    const span = Math.max(1e-6, box.w);
    const dir = edge === "w" ? -1 : 1;
    const k = (dir * (q.y - q0.y)) / span;
    const aa = m0.a + m0.c * k;
    const bb = m0.b + m0.d * k;
    const sign = Math.sign(snap.local.scaleX || 1);
    t.scaleX = clampScale(sign * Math.hypot(aa, bb));
    t.skewY = nearestAngle(Math.atan2(bb * sign, aa * sign) * RAD_DEG, snap.local.skewY);
  }

  // Keep the opposite edge pinned, as Flash does.
  const opp = oppositeFraction(edge);
  const A = { x: box.x + opp.fx * box.w, y: box.y + opp.fy * box.h };
  const anchorWorld = apply({ x: 0, y: 0 }, snap.world, A.x, A.y);
  const anchorParent = toParent(snap, anchorWorld.x, anchorWorld.y);
  const lin = toMatrix(mat(), { ...t, x: 0, y: 0 });
  t.x = anchorParent.x - (lin.a * A.x + lin.c * A.y);
  t.y = anchorParent.y - (lin.b * A.x + lin.d * A.y);
  return t;
}

function oppositeFraction(edge: "n" | "e" | "s" | "w"): { fx: number; fy: number } {
  return ({
    n: { fx: 0.5, fy: 1 }, s: { fx: 0.5, fy: 0 },
    e: { fx: 0, fy: 0.5 }, w: { fx: 1, fy: 0.5 },
  } as const)[edge];
}

/* ── World-space transform, for multi-selection ──────────────────────────
   `L' = P^-1 * M * P * L`. Nodes with different parents come out right with
   no extra logic, which is the payoff of doing the maths in matrices here
   rather than per-component.                                               */

export function applyWorldMatrix(snap: NodeSnapshot, m: Matrix2D): Transform {
  const newWorld = mul(mat(), m, snap.world);
  const invParent = mat();
  if (!invert(invParent, snap.parent)) return cloneTf(snap.local);
  const newLocal = mul(mat(), invParent, newWorld);
  // `snap.local` supplies sign continuity, so a handle crossing its anchor
  // flips the scale instead of popping the angle by 180 degrees.
  return fromMatrix(cloneTf(snap.local), newLocal, snap.local);
}

/** Scale about a world anchor, along world axes. */
export function worldScaleMatrix(anchor: Point, sx: number, sy: number): Matrix2D {
  return matOf(sx, 0, 0, sy, anchor.x - anchor.x * sx, anchor.y - anchor.y * sy);
}

/** The representative of `deg` (mod 360) nearest `near`. */
function nearestAngle(deg: number, near: number): number {
  let v = (deg - near + 180) % 360;
  if (v <= 0) v += 360;
  return near + v - 180;
}

/* ── Transform point ─────────────────────────────────────────────────────*/

/**
 * Move the transform point without moving the artwork.
 *
 * The pivot is the point of the image that sits on the bone origin, and the
 * renderer draws at `-pivot`. So shifting the pivot by `d` in image pixels
 * slides the artwork by `-linear(world) * d`; adding that same vector back to
 * the origin cancels it exactly, leaving only the point moved.
 *
 * Everything derives from the SNAPSHOT — never from the node's live values —
 * because during a drag the node's pivot and origin are both mid-update, and
 * mixing a fresh pivot with a stale world matrix makes the artwork crawl.
 */
export function movePivotKeepingArtwork(
  snap: NodeSnapshot,
  newPivot: { x: number; y: number },
): { pivot: { x: number; y: number }; bind: Transform } {
  const dx = newPivot.x - snap.pivot.x;
  const dy = newPivot.y - snap.pivot.y;
  const m = snap.world;
  const dWorldX = m.a * dx + m.c * dy;
  const dWorldY = m.b * dx + m.d * dy;
  return {
    pivot: { x: newPivot.x, y: newPivot.y },
    bind: moveBy(snap, dWorldX, dWorldY),
  };
}

/** The pointer, expressed in a node's untrimmed-image pixel space. */
export function pointerToImagePx(
  snap: NodeSnapshot,
  world: Point,
): { x: number; y: number } | null {
  const local = { x: 0, y: 0 };
  if (!applyInverse(local, snap.world, world.x, world.y)) return null;
  return { x: local.x + snap.pivot.x, y: local.y + snap.pivot.y };
}
