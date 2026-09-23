/**
 * Builds `tests/fixtures/projects/stickman.animo` — a bone + IK rig with two
 * animations, front-view "dance" and side-view "run".
 *
 * Run it with:  npx vite-node scripts/buildStickman.ts
 *
 * Why a script rather than a hand-authored file: the rig is defined here in
 * WORLD space (a joint position, an angle and a length per bone, which is how
 * a skeleton is actually thought about) and the local bind transforms are
 * derived by multiplying through the inverse parent — the same derivation
 * `IkTool` does when it drops a target. Editing a limb is then a number in one
 * table, not a matrix recomputed by hand in eleven places.
 *
 * Two rules the poses obey, both of them reach limits rather than taste:
 *
 *  - Feet are IK targets in SCENE space, so lifting the hips STRETCHES the
 *    stance leg. The hips therefore only ever dip below the bind pose; a bob
 *    upwards would pull the chain past `thigh + shin` and the solver would
 *    straighten the leg, leaving the foot behind its target.
 *  - Hands are IK targets that carry the hips' own offset, so a raised body
 *    never drags the hand out of the arm's reach.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { mat, mul, invert, type Matrix2D } from "@/core/math/Matrix2D";
import { tf, fromMatrix, matrixOf, type Transform } from "@/core/math/Transform";
import { TWEEN_LINEAR, type TweenSpec } from "@/core/math/easing";
import {
  createProject, createImageItem, createNode, createLayer, createAnimation,
} from "@/core/doc/defaults";
import { isSymbol, type Project, type SymbolItem, type Node, type Keyframe, type Track, type ColorTransform } from "@/core/doc/types";
import { newAssetId, newIkId, type AssetId, type NodeId, type ItemId } from "@/core/doc/ids";
import { normalizeLayerOrder } from "@/core/doc/layerTree";
import { serializeProject } from "@/io/project/ProjectFile";
import type { AssetStore } from "@/app/AssetStore";
import { buildParts, type Part } from "./stickmanArt";

/* ── Skeleton, in scene coordinates ───────────────────────────────────────
   y grows downwards. The hip joint is the origin of the figure; every other
   number here is a real position on the stage, so the rig can be read off the
   drawing rather than off a chain of local frames.                         */

const HIP_X = 400;
const HIP_Y = 400;

interface BoneSpec {
  name: string;
  parent: string | null;
  /** World joint the bone starts at. */
  x: number;
  y: number;
  /** World direction in degrees; 0 is +x, -90 is straight up. */
  ang: number;
  len: number;
}

const BONES: BoneSpec[] = [
  { name: "hips",  parent: null,    x: HIP_X,     y: HIP_Y,     ang: -90, len: 58 },
  { name: "chest", parent: "hips",  x: HIP_X,     y: HIP_Y - 58, ang: -90, len: 52 },
  { name: "head",  parent: "chest", x: HIP_X,     y: HIP_Y - 110, ang: -90, len: 46 },

  // Arms hang from the shoulders with the elbows bent outwards, mirrored, so
  // the front view reads symmetrically. Which side an elbow ends up on once
  // the IK runs is `bendPositive`, not this.
  { name: "arm_far_up",    parent: "chest",      x: 384,   y: 300,   ang: 110, len: 56 },
  { name: "arm_far_fore",  parent: "arm_far_up", x: 364.85, y: 352.62, ang: 70,  len: 52 },
  { name: "arm_near_up",   parent: "chest",       x: 416,   y: 300,   ang: 70,  len: 56 },
  { name: "arm_near_fore", parent: "arm_near_up", x: 435.15, y: 352.62, ang: 110, len: 52 },

  // Legs are NOT mirrored: both knees bend forwards (+x), which is what the
  // side-view run needs and what the front-view dance never shows.
  { name: "leg_far_thigh",  parent: "hips",           x: 387,    y: 404,    ang: 75,  len: 72 },
  { name: "leg_far_shin",   parent: "leg_far_thigh",  x: 405.63, y: 473.55, ang: 105, len: 68 },
  { name: "leg_near_thigh", parent: "hips",           x: 413,    y: 404,    ang: 75,  len: 72 },
  { name: "leg_near_shin",  parent: "leg_near_thigh", x: 431.63, y: 473.55, ang: 105, len: 68 },
];

/** Chain tips, computed the way `boneSegment` does: origin + axis * length. */
function tipOf(spec: BoneSpec): { x: number; y: number } {
  const r = (spec.ang * Math.PI) / 180;
  return { x: spec.x + Math.cos(r) * spec.len, y: spec.y + Math.sin(r) * spec.len };
}

const HAND_FAR = tipOf(BONES[4]!);    // arm_far_fore
const HAND_NEAR = tipOf(BONES[6]!);   // arm_near_fore
const FOOT_FAR = tipOf(BONES[8]!);    // leg_far_shin
const FOOT_NEAR = tipOf(BONES[10]!);  // leg_near_shin

/**
 * IK targets are parented to the SCENE, not to the chain's grandparent the
 * way `IkTool` drops them. Both are legal — the only rule is that a target
 * must not be a descendant of the chain it drives — and scene space is what
 * a planted foot means: the ground does not move when the hips do.
 */
const TARGETS = [
  { name: "foot_far_target",  at: FOOT_FAR },
  { name: "foot_near_target", at: FOOT_NEAR },
  { name: "hand_far_target",  at: HAND_FAR },
  { name: "hand_near_target", at: HAND_NEAR },
];

const IK = [
  // Knees forward, elbows back — the sides a human bends on. Which boolean
  // means which is not guessable: it depends on the chain's own frame, so
  // these were read off the solved pose, not assumed.
  { bone: "leg_far_shin",   target: "foot_far_target",  bendPositive: true },
  { bone: "leg_near_shin",  target: "foot_near_target", bendPositive: true },
  { bone: "arm_far_fore",   target: "hand_far_target",  bendPositive: false },
  { bone: "arm_near_fore",  target: "hand_near_target", bendPositive: false },
];

/** Which art hangs off which bone. Order inside a parent is z-order: the
 *  layer list is a depth-first walk and a parent draws in FRONT of its
 *  children, so the near side of the body has to come first. */
const IMAGES: Array<{ name: string; part: string; bone: string }> = [
  { name: "thigh_near",  part: "thigh",     bone: "leg_near_thigh" },
  { name: "shin_near",   part: "shin",      bone: "leg_near_shin" },
  { name: "pelvis",      part: "pelvis",    bone: "hips" },
  { name: "arm_near_1",  part: "upper_arm", bone: "arm_near_up" },
  { name: "arm_near_2",  part: "forearm",   bone: "arm_near_fore" },
  { name: "head_art",    part: "head",      bone: "head" },
  { name: "torso",       part: "torso",     bone: "chest" },
  { name: "arm_far_1",   part: "upper_arm", bone: "arm_far_up" },
  { name: "arm_far_2",   part: "forearm",   bone: "arm_far_fore" },
  { name: "thigh_far",   part: "thigh",     bone: "leg_far_thigh" },
  { name: "shin_far",    part: "shin",      bone: "leg_far_shin" },
];

/** Sibling order per parent, front to back. Anything not listed keeps the
 *  order it was added in. */
const SIBLING_ORDER: Record<string, string[]> = {
  hips: ["leg_near_thigh", "pelvis", "chest", "leg_far_thigh"],
  chest: ["arm_near_up", "head", "torso", "arm_far_up"],
  leg_near_thigh: ["thigh_near", "leg_near_shin"],
  leg_far_thigh: ["thigh_far", "leg_far_shin"],
  arm_near_up: ["arm_near_1", "arm_near_fore"],
  arm_far_up: ["arm_far_1", "arm_far_fore"],
};

/* ── Build ────────────────────────────────────────────────────────────────*/

const parts = new Map<string, Part>(buildParts().map((p) => [p.name, p]));

const project = createProject("Stickman IK");
project.frameRate = 24;
project.stage = { width: 800, height: 600, background: "#eef1f6" };

const rootItem = project.items[project.rootSymbolId];
if (!isSymbol(rootItem)) throw new Error("no root symbol");
// Typed, not just narrowed: the closures below outlive the narrowing.
const root: SymbolItem = rootItem;
root.name = "stickman";

/* Library: one ImageItem per part, shared by both sides. */
const assetBlobs = new Map<AssetId, Blob>();
const itemOf = new Map<string, ItemId>();
for (const part of parts.values()) {
  const assetId = newAssetId();
  assetBlobs.set(assetId, new Blob([part.png as unknown as BlobPart], { type: "image/png" }));
  const item = createImageItem(part.name, assetId, part.width, part.height);
  project.items[item.id] = item;
  project.itemOrder.push(item.id);
  itemOf.set(part.name, item.id);
}

/* Bones. World -> local by dividing out the parent, exactly as IkTool does. */
const worldOf = new Map<string, Matrix2D>();
const nodeOf = new Map<string, Node>();

function addNode(node: Node, name: string): void {
  root.nodes[node.id] = node;
  nodeOf.set(name, node);
  root.layers.push(createLayer(node.id, node.name, root.layers.length));
}

function localOf(world: Matrix2D, parentName: string | null): Transform {
  const parent = parentName ? worldOf.get(parentName) : undefined;
  if (!parent) return fromMatrix(tf(), world);
  const inverse = mat();
  if (!invert(inverse, parent)) throw new Error(`singular parent ${parentName}`);
  return fromMatrix(tf(), mul(mat(), inverse, world));
}

for (const spec of BONES) {
  const world = matrixOf(tf(spec.x, spec.y, spec.ang, spec.ang));
  worldOf.set(spec.name, world);
  const node = createNode("bone", spec.name, {
    parentId: spec.parent ? nodeOf.get(spec.parent)!.id : null,
  });
  node.bind = localOf(world, spec.parent);
  node.boneLength = spec.len;
  addNode(node, spec.name);
}

for (const target of TARGETS) {
  const node = createNode("bone", target.name, { parentId: null });
  node.bind = tf(target.at.x, target.at.y);
  node.boneLength = 18;
  worldOf.set(target.name, matrixOf(node.bind));
  addNode(node, target.name);
}

/* Art. An image node sits on its bone with an identity transform, so the
   pivot — the joint, in image pixels — is the only alignment there is. */
for (const image of IMAGES) {
  const part = parts.get(image.part)!;
  const node = createNode("image", image.name, {
    parentId: nodeOf.get(image.bone)!.id,
    itemId: itemOf.get(image.part)!,
  });
  node.pivot = { ...part.pivot };
  addNode(node, image.name);
}

/* IK. `chain: 1` because every effector here has a bone parent to root the
   two-bone solve — the runtime's own rule, mirrored in `pose.applyIk`. */
for (const k of IK) {
  root.ik.push({
    id: newIkId(),
    name: `${k.bone}_ik`,
    boneId: nodeOf.get(k.bone)!.id,
    targetId: nodeOf.get(k.target)!.id,
    chain: 1,
    bendPositive: k.bendPositive,
    weight: 1,
  });
}

/* Layer order. `normalizeLayerOrder` will rewrite the array into a depth-first
   walk keeping SIBLING order, so the ordering that has to be right here is the
   one inside each parent — which is z-order, since a parent draws in front of
   its children. */
orderSiblings(root);
normalizeLayerOrder(root);

function orderSiblings(sym: SymbolItem): void {
  const rank = new Map<NodeId, number>();
  for (const [parent, order] of Object.entries(SIBLING_ORDER)) {
    if (!nodeOf.has(parent)) throw new Error(`unknown parent in SIBLING_ORDER: ${parent}`);
    order.forEach((name, i) => {
      const node = nodeOf.get(name);
      if (!node) throw new Error(`unknown node in SIBLING_ORDER.${parent}: ${name}`);
      rank.set(node.id, i);
    });
  }

  // Group by parent in insertion order, sort each group on its own — sorting
  // the flat array with a comparator that only orders siblings would not be a
  // consistent ordering, and V8 is free to make a mess of it.
  const groups = new Map<NodeId | null, typeof sym.layers>();
  for (const layer of sym.layers) {
    const parentId = sym.nodes[layer.nodeId]!.parentId;
    const list = groups.get(parentId);
    if (list) list.push(layer);
    else groups.set(parentId, [layer]);
  }
  for (const list of groups.values()) {
    list.forEach((l, i) => rank.has(l.nodeId) || rank.set(l.nodeId, 100 + i));
    list.sort((a, b) => rank.get(a.nodeId)! - rank.get(b.nodeId)!);
  }
  sym.layers = [...groups.values()].flat();
}

/* ── Animation helpers ────────────────────────────────────────────────────*/

interface Delta { dx?: number; dy?: number; rot?: number }

/** Absolute local keyframe from the node's bind pose plus an offset. Editor
 *  keyframes are absolute; the exporter is what subtracts the bind. */
function keyAt(name: string, frame: number, d: Delta, tween: TweenSpec = TWEEN_LINEAR): Keyframe {
  const bind = nodeOf.get(name)!.bind;
  return {
    frame,
    transform: tf(
      bind.x + (d.dx ?? 0), bind.y + (d.dy ?? 0),
      bind.skewX + (d.rot ?? 0), bind.skewY + (d.rot ?? 0),
      bind.scaleX, bind.scaleY,
    ),
    displayIndex: 0,
    tween,
  };
}

function track(name: string, end: number, keys: Keyframe[]): [NodeId, Track] {
  return [nodeOf.get(name)!.id, { nodeId: nodeOf.get(name)!.id, keys, endFrame: end }];
}

/** Samples `at(frame)` every `step` frames, inclusive of both ends. */
function sampled(
  name: string, length: number, step: number, at: (f: number) => Delta,
  tween: TweenSpec = TWEEN_LINEAR,
): [NodeId, Track] {
  const keys: Keyframe[] = [];
  for (let f = 0; f <= length; f += step) keys.push(keyAt(name, f, at(f), tween));
  return track(name, length, keys);
}

const TAU = Math.PI * 2;

/** A flat colour multiplier, for pushing the far side of the body back. */
function shade(pct: number): ColorTransform {
  return { aM: 100, rM: pct, gM: pct, bM: pct, aO: 0, rO: 0, gO: 0, bO: 0 };
}

function colorOnly(name: string, end: number, color: ColorTransform): [NodeId, Track] {
  const bind = nodeOf.get(name)!.bind;
  return track(name, end, [{
    frame: 0, transform: { ...bind }, color, displayIndex: 0, tween: TWEEN_LINEAR,
  }]);
}

/* ── "dance": front view, 32-frame loop ───────────────────────────────────
   Hips sway and DIP (never rise — see the header), the chest counter-rotates,
   and the hands take turns going up while the opposite foot lifts.        */

const DANCE = 32;

function dance(): Record<NodeId, Track> {
  const hipsAt = (f: number) => {
    const t = (TAU * f) / DANCE;
    return { dx: 14 * Math.sin(t), dy: 8 - 8 * Math.cos(2 * t), rot: 4 * Math.sin(t) };
  };

  const entries: Array<[NodeId, Track]> = [
    sampled("hips", DANCE, 4, hipsAt),
    sampled("chest", DANCE, 4, (f) => ({ rot: -7 * Math.sin((TAU * f) / DANCE) })),
    sampled("head", DANCE, 8, (f) => ({ rot: 6 * Math.sin((TAU * f) / DANCE + 0.8) }),
      { kind: "ease", value: 1 }),

    // Feet stay on the ground and take turns lifting; they follow the sway
    // only partly, which is what puts the weight on one leg.
    sampled("foot_near_target", DANCE, 4, (f) => {
      const t = (TAU * f) / DANCE;
      return { dx: 8 * Math.sin(t), dy: -14 * Math.max(0, Math.sin(t)) };
    }),
    sampled("foot_far_target", DANCE, 4, (f) => {
      const t = (TAU * f) / DANCE;
      return { dx: 8 * Math.sin(t), dy: -14 * Math.max(0, -Math.sin(t)) };
    }),

    // Hands carry the hips' offset, so the shoulder never walks away from the
    // target and stretches the arm straight.
    sampled("hand_near_target", DANCE, 4, (f) => {
      const t = (TAU * f) / DANCE;
      const up = 0.5 + 0.5 * Math.sin(t);
      const hips = hipsAt(f);
      return { dx: hips.dx + 58 * up, dy: hips.dy - 176 * up };
    }),
    sampled("hand_far_target", DANCE, 4, (f) => {
      const t = (TAU * f) / DANCE;
      const up = 0.5 - 0.5 * Math.sin(t);
      const hips = hipsAt(f);
      return { dx: hips.dx - 58 * up, dy: hips.dy - 176 * up };
    }),
  ];
  return Object.fromEntries(entries) as Record<NodeId, Track>;
}

/* ── "run": side view, 16-frame loop ──────────────────────────────────────
   One foot on the ground at a time, the body dipping at mid-stance, the arms
   swinging against the legs, and the far limbs shaded back.               */

const RUN = 16;
const STRIDE = 36;
const LIFT = 62;

/** Where a foot is at cycle position `p`: stance for the first half, a swing
 *  arc for the second. Continuous at p = 0 and p = 1, so the loop closes. */
function footAt(p: number): Delta {
  const q = p - Math.floor(p);
  if (q < 0.5) return { dx: STRIDE - 4 * STRIDE * q, dy: 0 };
  const s = (q - 0.5) * 2;
  return { dx: -STRIDE + 2 * STRIDE * s, dy: -LIFT * Math.sin(Math.PI * s) };
}

function run(): Record<NodeId, Track> {
  // Two stances per cycle, so the body dips twice: lowest at mid-stance,
  // back to the bind height at each contact. Never above it.
  // Never above the bind pose, and never level with it either: a runner's
  // knees stay bent, and the 4px of permanent dip is what buys the stride
  // room the planted foot would otherwise run out of.
  const hipsAt = (f: number) => ({ dy: 10 - 6 * Math.cos((TAU * f) / 8), rot: 4 });

  const handAt = (f: number, phase: number) => {
    const h = f / RUN + phase;
    const hips = hipsAt(f);
    return {
      dx: 30 * Math.sin(TAU * h),
      dy: hips.dy - 45 + 15 * Math.cos(TAU * h),
    };
  };

  const entries: Array<[NodeId, Track]> = [
    sampled("hips", RUN, 2, hipsAt),
    sampled("chest", RUN, 8, () => ({ rot: 8 })),          // a constant forward lean
    sampled("head", RUN, 8, () => ({ rot: -5 })),

    sampled("foot_near_target", RUN, 2, (f) => footAt(f / RUN)),
    sampled("foot_far_target", RUN, 2, (f) => footAt(f / RUN + 0.5)),

    // The arm swings against the leg on the same side: half a cycle apart.
    sampled("hand_near_target", RUN, 2, (f) => handAt(f, 0.5)),
    sampled("hand_far_target", RUN, 2, (f) => handAt(f, 0)),

    // Side view: push the far arm and leg back with a flat multiplier. Only
    // the multipliers survive `PixiSlot._updateColor`, so no offsets here.
    colorOnly("arm_far_1", RUN, shade(62)),
    colorOnly("arm_far_2", RUN, shade(62)),
    colorOnly("thigh_far", RUN, shade(62)),
    colorOnly("shin_far", RUN, shade(62)),
  ];
  return Object.fromEntries(entries) as Record<NodeId, Track>;
}

/* Animations. A key sits ON the last frame and repeats frame 0, the way a
   Flash loop is authored, so `duration` covers the whole cycle. */
const danceAnim = createAnimation("dance", DANCE + 1);
danceAnim.tracks = dance();
const runAnim = createAnimation("run", RUN + 1);
runAnim.tracks = run();
root.animations = [danceAnim, runAnim];

/* ── Write ────────────────────────────────────────────────────────────────*/

const assets = {
  get: (id: AssetId) => {
    const blob = assetBlobs.get(id);
    return blob ? { id, name: String(id), blob, width: 0, height: 0 } : undefined;
  },
} as unknown as AssetStore;

const out = fileURLToPath(new URL("../tests/fixtures/projects/stickman.animo", import.meta.url));
const blob = await serializeProject(project as Project, assets);
writeFileSync(out, new Uint8Array(await blob.arrayBuffer()));

console.log(`wrote ${out}`);
console.log(`  ${Object.keys(root.nodes).length} nodes, ${root.layers.length} layers, ` +
  `${root.ik.length} IK constraints, ${root.animations.length} animations`);
