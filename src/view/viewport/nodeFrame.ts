import { apply, invert, mat, type Matrix2D, mul } from "@/core/math/Matrix2D";
import { type Rect, rectFromPoints } from "@/core/math/geom";
import { entryBox, type FrameContext, type Pose, SETUP_CONTEXT } from "@/core/doc/pose";
import type { Project } from "@/core/doc/types";
import type { NodeId } from "@/core/doc/ids";

/**
 * What a bone actually moves, expressed in that bone's own frame.
 *
 * A bone, a group and an empty layer have no artwork of their own, so the
 * selection box the stage draws for an image — `localBox` — is null for them
 * and nothing at all appears when one is selected. That is the whole reason
 * `hips` can carry a full timeline while the stage stays silent about it.
 *
 * `drivenBox` answers the question the missing box was standing in for: which
 * artwork does this node carry? It unions every descendant's box, each one
 * re-expressed in the ROOT's local space (`inv(rootWorld) · descendantWorld`),
 * so the result is a rectangle that rotates, scales and shears with the bone
 * rather than an axis-aligned envelope that only loosely follows it — and it
 * stays tight when the camera itself is rotated, which it is inside an
 * edit-in-place chain.
 *
 * Pure and canvas-free, like `onion.ts`, so the arithmetic can be tested
 * against a real rig instead of eyeballed on the stage.
 */

/** How long the local axes are drawn, in the node's own units. */
export const AXIS_LENGTH = 34;

/** Depth guard: a corrupt parent chain must not hang the overlay. */
const MAX_DEPTH = 64;

/**
 * The bounds of every piece of artwork under `rootId`, in `rootId`'s local
 * space, or null when the node drives no artwork at all (a lone IK target).
 * The root's own artwork is included when it has any.
 */
export function drivenBox(
  project: Project, pose: Pose, rootId: NodeId, when: FrameContext = SETUP_CONTEXT,
): Rect | null {
  const root = pose.byNode.get(rootId);
  if (!root) return null;

  const toLocal = mat();
  if (!invert(toLocal, root.world)) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const relative = mat();
  const p = { x: 0, y: 0 };

  for (const e of pose.entries) {
    if (!isDescendant(pose, e.nodeId, rootId)) continue;
    const box = entryBox(project, e, when);
    if (!box) continue;

    // The descendant's own frame, seen from the root: one matrix for all four
    // corners, so a deep chain costs one inversion rather than four.
    mul(relative, toLocal, e.world);
    for (const [x, y] of [
      [box.x, box.y], [box.x + box.w, box.y],
      [box.x + box.w, box.y + box.h], [box.x, box.y + box.h],
    ] as const) {
      apply(p, relative, x, y);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return Number.isFinite(minX) ? rectFromPoints(minX, minY, maxX, maxY) : null;
}

/** `id` is `ancestorId` or sits under it. */
export function isDescendant(pose: Pose, id: NodeId, ancestorId: NodeId): boolean {
  let cursor: NodeId | null | undefined = id;
  for (let guard = 0; cursor && guard < MAX_DEPTH; guard++) {
    if (cursor === ancestorId) return true;
    cursor = pose.byNode.get(cursor)?.node.parentId;
  }
  return false;
}

/**
 * The tips of the node's local axes in world space: +x (the direction a bone
 * points) and +y. Both carry the node's scale and shear, which is what makes
 * a scale keyframe visible on a node that draws nothing.
 */
export function axisTips(
  world: Matrix2D, length = AXIS_LENGTH,
): { x: { x: number; y: number }; y: { x: number; y: number } } {
  return {
    x: { x: world.tx + world.a * length, y: world.ty + world.b * length },
    y: { x: world.tx + world.c * length, y: world.ty + world.d * length },
  };
}

/**
 * The axes of the space the node's POSITION is expressed in, drawn from the
 * node's own origin.
 *
 * `Node.bind.x/y` — the Properties panel's X and Y — are the translation of
 * the LOCAL matrix, and `world = parentWorld · local`, so nudging y by 10
 * moves the node along the PARENT's +y, not its own. On a bone chain the two
 * frames are usually rotated against each other, which is how "y + 10" ends up
 * moving something sideways on screen with nothing saying why.
 *
 * A root node has no parent, so its position is in scene coordinates: pass the
 * identity and the axes come out along the screen, which is exactly right.
 */
export function positionAxisTips(
  world: Matrix2D, parentWorld: Matrix2D, length = AXIS_LENGTH,
): { x: { x: number; y: number }; y: { x: number; y: number } } {
  return {
    x: { x: world.tx + parentWorld.a * length, y: world.ty + parentWorld.b * length },
    y: { x: world.tx + parentWorld.c * length, y: world.ty + parentWorld.d * length },
  };
}

/** The scene's own frame: what a node with no parent measures against. */
export const SCENE_FRAME: Matrix2D = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/**
 * Whether the parent frame is worth drawing next to the node.
 *
 * Two independent reasons, and missing either one leaves the misleading case
 * on screen:
 *
 *  - it differs from the NODE's own frame, so the solid axes are not the
 *    direction x/y move in (a root bone standing upright: its own +y points
 *    across the stage while its position y runs down it);
 *  - it differs from the SCENE, so x/y do not mean "right" and "down" either
 *    (`head` under a chest that points up: its own frame matches its parent's
 *    exactly, and y still moves it sideways).
 */
export function showsPositionAxes(world: Matrix2D, parentWorld: Matrix2D): boolean {
  return !framesAlign(world, parentWorld) || !framesAlign(parentWorld, SCENE_FRAME);
}

/**
 * Which way the parent frame's axes point on screen, as words — for the note
 * the Properties panel puts next to X and Y. Null when the frame is the
 * ordinary one, where x is right and y is down and there is nothing to say.
 */
export function frameDirections(
  parentWorld: Matrix2D,
): { x: Direction; y: Direction; rotation: number } | null {
  if (framesAlign(parentWorld, SCENE_FRAME)) return null;
  return {
    x: directionOf(parentWorld.a, parentWorld.b),
    y: directionOf(parentWorld.c, parentWorld.d),
    rotation: Math.atan2(parentWorld.b, parentWorld.a) * 180 / Math.PI,
  };
}

export type Direction = "right" | "down" | "left" | "up" | "diagonally";

/** The compass point a vector is closest to, or "diagonally" when it is not
 *  within 22.5 degrees of one — a rotated rig is rarely on the axis. */
function directionOf(x: number, y: number): Direction {
  const len = Math.hypot(x, y);
  if (len < 1e-9) return "diagonally";
  const angle = Math.atan2(y / len, x / len) * 180 / Math.PI;
  const table: Array<[number, Direction]> = [
    [0, "right"], [90, "down"], [180, "left"], [-180, "left"], [-90, "up"],
  ];
  for (const [deg, name] of table) if (Math.abs(angle - deg) <= 22.5) return name;
  return "diagonally";
}

/** Whether two frames point the same way, within `toleranceDeg`. */
export function framesAlign(a: Matrix2D, b: Matrix2D, toleranceDeg = 2): boolean {
  const angle = (m: Matrix2D) => Math.atan2(m.b, m.a);
  const delta = Math.abs(normalizeRadian(angle(a) - angle(b)));
  return delta * 180 / Math.PI <= toleranceDeg;
}

function normalizeRadian(radian: number): number {
  let r = (radian + Math.PI) % (Math.PI * 2);
  r += r > 0 ? -Math.PI : Math.PI;
  return r;
}
