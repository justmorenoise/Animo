import type { Matrix2D } from "./Matrix2D";

/**
 * Inverse kinematics, ported from the runtime's own `IKConstraint`.
 *
 * Transcribed from `dragonBones.IKConstraint._computeA/_computeB` in the
 * vendored build the preview actually runs — including the parts that look
 * like quirks, because they are the behaviour the exported file will get:
 *
 * - a chain that cannot reach straightens toward the target, and *which* way
 *   it straightens depends on which segment is longer;
 * - `bendPositive` is flipped when the chain's grandparent is mirrored
 *   (negative determinant), so a flipped character bends the same way on
 *   screen;
 * - `weight` interpolates the ROTATIONS, not the positions;
 * - the second segment's length comes from the effector bone's `length`
 *   field, so a bone with no length makes the solve degenerate.
 *
 * Everything here is in world space and radians, which is the space the
 * runtime solves in. Angles follow the runtime's parameterisation:
 * `rotation` is skewY, `skew` is skewX − skewY.
 */

export interface IkWorld {
  x: number;
  y: number;
  rotation: number;
  skew: number;
  scaleX: number;
  scaleY: number;
}

export interface IkPoint { x: number; y: number }

/** Wrap into (−π, π], exactly as `Transform.normalizeRadian` does. */
export function normalizeRadian(radian: number): number {
  let r = (radian + Math.PI) % (Math.PI * 2);
  r += r > 0 ? -Math.PI : Math.PI;
  return r;
}

/**
 * Decompose a world matrix into the runtime's transform.
 *
 * Per column with `atan2`, as everywhere else in this codebase — the runtime's
 * own `fromMatrix` uses `atan` with sign fix-ups and is fragile near ±90°,
 * and it is not on the path that feeds the solver there anyway.
 */
export function matrixToWorld(out: IkWorld, m: Matrix2D): IkWorld {
  out.x = m.tx;
  out.y = m.ty;
  out.rotation = Math.atan2(m.b, m.a);
  out.skew = Math.atan2(-m.c, m.d) - out.rotation;
  out.scaleX = Math.hypot(m.a, m.b);
  out.scaleY = Math.hypot(m.c, m.d);
  return out;
}

/** The inverse, matching `Transform.toMatrix`. */
export function worldToMatrix(out: Matrix2D, w: IkWorld): Matrix2D {
  const skewX = w.skew + w.rotation;
  out.a = Math.cos(w.rotation) * w.scaleX;
  out.b = Math.sin(w.rotation) * w.scaleX;
  out.c = -Math.sin(skewX) * w.scaleY;
  out.d = Math.cos(skewX) * w.scaleY;
  out.tx = w.x;
  out.ty = w.y;
  return out;
}

/**
 * One bone: point it at the target. Mutates `root.rotation`.
 */
export function solveOneBone(root: IkWorld, target: IkPoint, weight = 1): void {
  let ikRadian = Math.atan2(target.y - root.y, target.x - root.x);
  if (root.scaleX < 0) ikRadian += Math.PI;
  root.rotation += normalizeRadian(ikRadian - root.rotation) * weight;
}

/**
 * Two bones: law of cosines on the triangle root → joint → target.
 *
 * `bone` is the effector (the lower bone); `boneMatrix` is its world matrix
 * BEFORE the solve, which is where the second segment's direction comes from.
 * Both `root` and `bone` are mutated.
 */
export function solveTwoBones(
  root: IkWorld,
  bone: IkWorld,
  boneMatrix: Matrix2D,
  boneLength: number,
  target: IkPoint,
  bendPositive: boolean,
  /** True when the chain's grandparent has a mirrored (negative) basis. */
  parentMirrored: boolean,
  weight = 1,
): void {
  // Second segment, measured through the effector's own basis so a scaled
  // parent scales the chain with it.
  const lowerX = boneMatrix.a * boneLength;
  const lowerY = boneMatrix.b * boneLength;
  const lowerLenSq = lowerX * lowerX + lowerY * lowerY;
  const lowerLen = Math.sqrt(lowerLenSq);

  // First segment: root joint to the effector's joint.
  let dx = bone.x - root.x;
  let dy = bone.y - root.y;
  const upperLenSq = dx * dx + dy * dy;
  const upperLen = Math.sqrt(upperLenSq);
  const rawBoneRotation = bone.rotation;
  const rawRootRotation = root.rotation;
  const currentRadian = Math.atan2(dy, dx);

  // Root joint to target.
  dx = target.x - root.x;
  dy = target.y - root.y;
  const targetLenSq = dx * dx + dy * dy;
  const targetLen = Math.sqrt(targetLenSq);

  let solvedRadian = 0;
  if (
    lowerLen + upperLen <= targetLen ||
    targetLen + lowerLen <= upperLen ||
    targetLen + upperLen <= lowerLen
  ) {
    // No triangle: reach straight at the target, or fold away from it.
    solvedRadian = Math.atan2(target.y - root.y, target.x - root.x);
    if (lowerLen + upperLen <= targetLen) {
      // Out of reach: straighten.
    } else if (upperLen < lowerLen) {
      solvedRadian += Math.PI;
    }
  } else {
    // Circle intersection: the joint sits at distance `upperLen` from the
    // root and `lowerLen` from the target.
    const h = (upperLenSq - lowerLenSq + targetLenSq) / (2 * targetLenSq);
    const r = Math.sqrt(upperLenSq - h * h * targetLenSq) / targetLen;
    const hx = root.x + dx * h;
    const hy = root.y + dy * h;
    const rx = -dy * r;
    const ry = dx * r;
    if (parentMirrored !== bendPositive) {
      bone.x = hx - rx;
      bone.y = hy - ry;
    } else {
      bone.x = hx + rx;
      bone.y = hy + ry;
    }
    solvedRadian = Math.atan2(bone.y - root.y, bone.x - root.x);
  }

  const deltaRadian = normalizeRadian(solvedRadian - currentRadian);
  root.rotation = rawRootRotation + deltaRadian * weight;

  // The joint is placed from the (possibly weighted) root rotation, so a
  // partial weight leaves the chain part-way rather than snapping.
  const jointRadian = currentRadian + deltaRadian * weight;
  bone.x = root.x + Math.cos(jointRadian) * upperLen;
  bone.y = root.y + Math.sin(jointRadian) * upperLen;

  let tipRadian = Math.atan2(target.y - bone.y, target.x - bone.x);
  if (bone.scaleX < 0) tipRadian += Math.PI;
  bone.rotation = root.rotation + rawBoneRotation - rawRootRotation
    + normalizeRadian(tipRadian - deltaRadian - rawBoneRotation) * weight;
}
