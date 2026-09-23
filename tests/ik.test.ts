import { describe, it, expect, beforeEach } from "vitest";
import { reseed, newIkId, type NodeId } from "@/core/doc/ids";
import { createProject, createNode, createLayer } from "@/core/doc/defaults";
import { isSymbol, type SymbolItem } from "@/core/doc/types";
import { evaluateSymbol, invalidateBounds } from "@/core/doc/pose";
import { exportSkeleton } from "@/core/export/exportSkeleton";
import {
  solveOneBone, solveTwoBones, normalizeRadian, matrixToWorld, worldToMatrix, type IkWorld,
} from "@/core/math/ik";
import { mat, matOf } from "@/core/math/Matrix2D";

beforeEach(() => { reseed(); invalidateBounds(); });

const world = (x: number, y: number, rotation = 0): IkWorld =>
  ({ x, y, rotation, skew: 0, scaleX: 1, scaleY: 1 });

/** Where the effector's tip lands, the way the runtime computes it. */
const tipOf = (bone: IkWorld, length: number) => ({
  x: bone.x + Math.cos(bone.rotation) * bone.scaleX * length,
  y: bone.y + Math.sin(bone.rotation) * bone.scaleX * length,
});

describe("IK solver", () => {
  it("reaches a target inside the chain's range", () => {
    // Upper bone root at the origin pointing right, joint at (100, 0),
    // lower bone 100 long. The target is comfortably inside 200.
    const root = world(0, 0, 0);
    const bone = world(100, 0, 0);
    const target = { x: 100, y: 120 };

    solveTwoBones(root, bone, matOf(1, 0, 0, 1, 100, 0), 100, target, true, false, 1);

    const tip = tipOf(bone, 100);
    expect(tip.x).toBeCloseTo(target.x, 6);
    expect(tip.y).toBeCloseTo(target.y, 6);
    // The joint stays exactly one upper-bone away from the root.
    expect(Math.hypot(bone.x - root.x, bone.y - root.y)).toBeCloseTo(100, 6);
  });

  it("straightens at an unreachable target instead of giving up", () => {
    const root = world(0, 0, 0);
    const bone = world(100, 0, 0);
    const target = { x: 0, y: 500 };

    solveTwoBones(root, bone, matOf(1, 0, 0, 1, 100, 0), 100, target, true, false, 1);

    // Both bones point straight at the target, tip 200 away along that line.
    expect(root.rotation).toBeCloseTo(Math.PI / 2, 6);
    expect(bone.x).toBeCloseTo(0, 6);
    expect(bone.y).toBeCloseTo(100, 6);
    const tip = tipOf(bone, 100);
    expect(tip.x).toBeCloseTo(0, 6);
    expect(tip.y).toBeCloseTo(200, 6);
  });

  it("bends the other way when bendPositive is off", () => {
    const target = { x: 100, y: 120 };
    const positive = { root: world(0, 0, 0), bone: world(100, 0, 0) };
    const negative = { root: world(0, 0, 0), bone: world(100, 0, 0) };

    solveTwoBones(positive.root, positive.bone, matOf(1, 0, 0, 1, 100, 0), 100, target, true, false, 1);
    solveTwoBones(negative.root, negative.bone, matOf(1, 0, 0, 1, 100, 0), 100, target, false, false, 1);

    // Same tip, elbow on opposite sides of the root-to-target line.
    expect(tipOf(positive.bone, 100).y).toBeCloseTo(tipOf(negative.bone, 100).y, 6);
    expect(positive.bone.x).not.toBeCloseTo(negative.bone.x, 3);
    const side = (b: IkWorld) => Math.sign(target.x * b.y - target.y * b.x);
    expect(side(positive.bone)).toBe(-side(negative.bone));
  });

  it("mirrors the bend when the chain's parent is mirrored", () => {
    const target = { x: 100, y: 120 };
    const plain = { root: world(0, 0, 0), bone: world(100, 0, 0) };
    const mirrored = { root: world(0, 0, 0), bone: world(100, 0, 0) };

    solveTwoBones(plain.root, plain.bone, matOf(1, 0, 0, 1, 100, 0), 100, target, true, false, 1);
    solveTwoBones(mirrored.root, mirrored.bone, matOf(1, 0, 0, 1, 100, 0), 100, target, true, true, 1);

    expect(plain.bone.x).not.toBeCloseTo(mirrored.bone.x, 3);
  });

  it("leaves the pose alone at weight 0 and blends in between", () => {
    const target = { x: 100, y: 120 };
    const none = { root: world(0, 0, 0), bone: world(100, 0, 0) };
    const half = { root: world(0, 0, 0), bone: world(100, 0, 0) };
    const full = { root: world(0, 0, 0), bone: world(100, 0, 0) };

    solveTwoBones(none.root, none.bone, matOf(1, 0, 0, 1, 100, 0), 100, target, true, false, 0);
    solveTwoBones(half.root, half.bone, matOf(1, 0, 0, 1, 100, 0), 100, target, true, false, 0.5);
    solveTwoBones(full.root, full.bone, matOf(1, 0, 0, 1, 100, 0), 100, target, true, false, 1);

    expect(none.root.rotation).toBeCloseTo(0, 9);
    expect(none.bone.x).toBeCloseTo(100, 9);
    expect(half.root.rotation).toBeCloseTo(full.root.rotation / 2, 9);
  });

  it("points a single bone at the target", () => {
    const root = world(10, 10, 0);
    solveOneBone(root, { x: 10, y: 110 }, 1);
    expect(root.rotation).toBeCloseTo(Math.PI / 2, 9);

    // A mirrored bone points its own way round, as the runtime does.
    const flipped: IkWorld = { ...world(0, 0, 0), scaleX: -1 };
    solveOneBone(flipped, { x: 100, y: 0 }, 1);
    expect(Math.abs(normalizeRadian(flipped.rotation - Math.PI))).toBeLessThan(1e-9);
  });

  it("round-trips a world matrix through the runtime's parameterisation", () => {
    const m = matOf(0.6, 0.8, -0.8 * 2, 0.6 * 2, 12, -34);
    const w = matrixToWorld(
      { x: 0, y: 0, rotation: 0, skew: 0, scaleX: 1, scaleY: 1 }, m,
    );
    const back = worldToMatrix(mat(), w);
    for (const k of ["a", "b", "c", "d", "tx", "ty"] as const) {
      expect(back[k]).toBeCloseTo(m[k], 9);
    }
  });
});

/* ── In a document ─────────────────────────────────────────────────────── */

function rig(chain: 0 | 1 = 1) {
  const project = createProject("Rig");
  const root = project.items[project.rootSymbolId];
  if (!isSymbol(root)) throw new Error("no root");

  const add = (name: string, x: number, y: number, parentId: NodeId | null, length: number) => {
    const n = createNode("bone", name, { x, y, parentId });
    n.boneLength = length;
    root.nodes[n.id] = n;
    root.layers.unshift(createLayer(n.id, name, root.layers.length));
    return n;
  };

  const upper = add("upper", 0, 0, null, 100);
  const lower = add("lower", 100, 0, upper.id, 100);
  const target = add("target", 200, 0, null, 20);

  root.ik.push({
    id: newIkId(), name: "arm_ik",
    boneId: lower.id, targetId: target.id,
    chain, bendPositive: true, weight: 1,
  });

  return { project, root, upper, lower, target };
}

const tipOfEntry = (world: { a: number; b: number; tx: number; ty: number }, len: number) =>
  ({ x: world.tx + world.a * len, y: world.ty + world.b * len });

describe("IK in a pose", () => {
  it("moves the chain so the effector's tip reaches the target", () => {
    const { root, target, lower } = rig(1);
    target.bind.x = 100;
    target.bind.y = 120;

    const pose = evaluateSymbol(root as SymbolItem, null, 0, "setup");
    const tip = tipOfEntry(pose.byNode.get(lower.id)!.world, 100);
    expect(tip.x).toBeCloseTo(100, 6);
    expect(tip.y).toBeCloseTo(120, 6);
  });

  it("carries the effector's children along", () => {
    const { root, target, lower } = rig(1);
    // A hand hanging off the end of the lower bone.
    const hand = createNode("bone", "hand", { x: 100, y: 0, parentId: lower.id });
    hand.boneLength = 10;
    (root as SymbolItem).nodes[hand.id] = hand;
    (root as SymbolItem).layers.unshift(createLayer(hand.id, "hand", 9));

    target.bind.x = 100;
    target.bind.y = 120;

    const pose = evaluateSymbol(root as SymbolItem, null, 0, "setup");
    const handWorld = pose.byNode.get(hand.id)!.world;
    // The hand sits exactly where the solved lower bone's tip is.
    const tip = tipOfEntry(pose.byNode.get(lower.id)!.world, 100);
    expect(handWorld.tx).toBeCloseTo(tip.x, 6);
    expect(handWorld.ty).toBeCloseTo(tip.y, 6);
  });

  it("never writes the solve back into the document", () => {
    const { root, target, upper, lower } = rig(1);
    target.bind.x = 40;
    target.bind.y = 90;
    evaluateSymbol(root as SymbolItem, null, 0, "setup");

    // The file still describes the rest pose; the runtime does the solving.
    expect(upper.bind.skewY).toBe(0);
    expect(lower.bind.x).toBe(100);
    expect(lower.bind.skewY).toBe(0);
  });

  it("solves one bone when the chain is 0", () => {
    const { root, target, upper, lower } = rig(0);
    // Straight below the lower bone's own root, which is at world (100, 0).
    target.bind.x = 100;
    target.bind.y = 200;

    const pose = evaluateSymbol(root as SymbolItem, null, 0, "setup");
    const lowerWorld = pose.byNode.get(lower.id)!.world;
    const upperWorld = pose.byNode.get(upper.id)!.world;

    expect(Math.atan2(lowerWorld.b, lowerWorld.a)).toBeCloseTo(Math.PI / 2, 6);
    // Only the constrained bone moves: the parent keeps its rest rotation.
    expect(Math.atan2(upperWorld.b, upperWorld.a)).toBeCloseTo(0, 9);
  });

  it("refuses a target that hangs off the chain it drives", () => {
    const circular = rig(1);
    // Parent the target to the very bone it is supposed to move.
    circular.target.parentId = circular.lower.id;
    const posed = evaluateSymbol(circular.root as SymbolItem, null, 0, "setup");
    expect(posed.byNode.get(circular.lower.id)!.world.b).toBeCloseTo(0, 9);

    // The same rig with the target outside the chain does solve, so the test
    // above is the guard working rather than the rig doing nothing.
    invalidateBounds();
    const sane = rig(1);
    sane.target.bind.x = 100;
    sane.target.bind.y = 120;
    const ok = evaluateSymbol(sane.root as SymbolItem, null, 0, "setup");
    expect(ok.byNode.get(sane.lower.id)!.world.b).not.toBeCloseTo(0, 3);
  });
});

describe("IK in the export", () => {
  it("writes ik[] the way the parser reads it", () => {
    const { project, root, lower, target } = rig(1);
    (root as SymbolItem).ik[0]!.weight = 0.5;
    (root as SymbolItem).ik[0]!.bendPositive = false;

    const { skeleton } = exportSkeleton(project);
    const armature = skeleton.armature.find((a) => a.name === "Scene 1")!;
    expect(armature.ik).toEqual([{
      name: "arm_ik", bone: "lower", target: "target",
      chain: 1, bendPositive: false, weight: 0.5,
    }]);

    // The effector's length is the second segment of the runtime's solve, so
    // it has to survive the trip.
    const bone = armature.bone.find((b) => b.name === "lower")!;
    expect(bone.length).toBe(100);
    expect(lower.boneLength).toBe(100);
    expect(target.name).toBe("target");
  });

  it("leaves out what the parser already defaults", () => {
    const { project, root } = rig(0);
    void root;
    const { skeleton } = exportSkeleton(project);
    const armature = skeleton.armature.find((a) => a.name === "Scene 1")!;
    // chain 0, bendPositive true and weight 1 are the parser's defaults.
    expect(armature.ik).toEqual([{ name: "arm_ik", bone: "lower", target: "target" }]);
  });
});
