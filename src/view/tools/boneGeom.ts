import type { Pose, PoseEntry } from "@/core/doc/pose";
import type { NodeId } from "@/core/doc/ids";
import type { Point } from "@/core/math/geom";

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
export function pickBoneTip(pose: Pose, p: Point, tolerance: number): NodeId | null {
  let best: NodeId | null = null;
  let bestDistance = tolerance;
  for (const entry of pose.entries) {
    if (entry.node.kind !== "bone") continue;
    const s = boneSegment(entry);
    const d = Math.hypot(p.x - s.bx, p.y - s.by);
    if (d <= bestDistance) { bestDistance = d; best = entry.nodeId; }
  }
  return best;
}
