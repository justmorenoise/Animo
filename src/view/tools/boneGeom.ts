import type { Pose, PoseEntry } from "@/core/doc/pose";
import type { NodeId } from "@/core/doc/ids";
import type { Point } from "@/core/math/geom";
import type { Matrix2D } from "@/core/math/Matrix2D";

/** Default drawn length for a bone that has none. Matches the overlay. */
export const DEFAULT_BONE_LENGTH = 40;

export interface BoneSegment { ax: number; ay: number; bx: number; by: number }

/**
 * A bone's segment in world space.
 *
 * The tip is the bone's own x axis scaled by its length — the same formula
 * the runtime uses in `_computeB`, so what you click is what solves.
 */
export function boneSegment(entry: PoseEntry): BoneSegment {
  const len = entry.node.boneLength ?? DEFAULT_BONE_LENGTH;
  const m = entry.world;
  return { ax: m.tx, ay: m.ty, bx: m.tx + m.a * len, by: m.ty + m.b * len };
}

export function distanceToSegment(p: Point, s: BoneSegment): number {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0
    ? Math.max(0, Math.min(1, ((p.x - s.ax) * dx + (p.y - s.ay) * dy) / lenSq))
    : 0;
  return Math.hypot(p.x - (s.ax + dx * t), p.y - (s.ay + dy * t));
}

/** The nearest bone within `tolerance` world units, or null. */
export function pickBone(
  pose: Pose, p: Point, tolerance: number,
  accept: (id: NodeId) => boolean = () => true,
): NodeId | null {
  let best: NodeId | null = null;
  let bestDistance = tolerance;
  for (const entry of pose.entries) {
    if (entry.node.kind !== "bone" || !accept(entry.nodeId)) continue;
    const d = distanceToSegment(p, boneSegment(entry));
    if (d <= bestDistance) { bestDistance = d; best = entry.nodeId; }
  }
  return best;
}

/** The nearest bone TIP within `tolerance`, for starting a child bone there. */
export function pickBoneTip(
  pose: Pose, p: Point, tolerance: number, pickable: (id: NodeId) => boolean = () => true,
): NodeId | null {
  let best: NodeId | null = null;
  let bestDistance = tolerance;
  for (const entry of pose.entries) {
    if (entry.node.kind !== "bone" || !pickable(entry.nodeId)) continue;
    const s = boneSegment(entry);
    const d = Math.hypot(p.x - s.bx, p.y - s.by);
    if (d <= bestDistance) { bestDistance = d; best = entry.nodeId; }
  }
  return best;
}

/**
 * A bone length measured on the stage, in the bone's own units. The tip is
 * drawn at `length` along the world x-axis of the bone, so a bone under a
 * parent scaled 2× shows a stored 50 as 100px: dividing by that axis's world
 * length is what makes the tip land under the pointer.
 */
export function localLength(worldLength: number, boneWorld: Matrix2D): number {
  const scale = Math.hypot(boneWorld.a, boneWorld.b);
  return scale > 1e-9 ? worldLength / scale : worldLength;
}

