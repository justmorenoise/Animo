import { describe, it, expect, beforeAll } from "vitest";
import { loadStickman, type Stickman } from "./fixtures/stickman";
import { ikChain, ikRelations, ikRoles, ikRoleOf, ikSummary } from "@/core/doc/ikGraph";
import type { NodeId } from "@/core/doc/ids";

/**
 * The relationship the layer tree cannot draw. A target is parented OUTSIDE
 * the chain it drives, so indentation says nothing about it: these are the
 * lookups the icons, the tooltips, the Properties panel and the stage links
 * all read, and they have to agree with the runtime's own chain rule.
 */

let f: Stickman;
const nameOf = (id: NodeId) => f.rig.nodes[id]!.name;

beforeAll(async () => { f = await loadStickman(); });

describe("ikChain", () => {
  it("is the effector and its parent for a two-bone solve", () => {
    for (const k of f.rig.ik) {
      const chain = ikChain(f.rig, k).map(nameOf);
      expect(chain, k.name).toHaveLength(2);
      expect(chain[1]).toBe(nameOf(k.boneId));
      expect(chain[0]).toBe(nameOf(f.rig.nodes[k.boneId]!.parentId!));
    }
  });

  it("falls back to one bone when there is no parent to root the solve", () => {
    // The runtime's rule is `chain > 0 && bone.parent !== null`, so a
    // constraint claiming two bones on a root gets ONE — reporting two here
    // would draw a chain the runtime never solves.
    const k = { ...f.rig.ik[0]!, boneId: f.node("hips") };
    expect(f.rig.nodes[k.boneId]!.parentId).toBeNull();
    expect(ikChain(f.rig, k)).toEqual([k.boneId]);
  });
});

describe("ikRelations", () => {
  it("names the target's side and the bones' side of the same constraint", () => {
    const k = f.rig.ik.find((c) => c.name.includes("foot_near"))
      ?? f.rig.ik[0]!;
    const target = ikRelations(f.rig, k.targetId);
    expect(target).toHaveLength(1);
    expect(target[0]!.role).toBe("target");
    expect(target[0]!.chain).toHaveLength(2);

    const effector = ikRelations(f.rig, k.boneId);
    expect(effector[0]!.role).toBe("effector");

    // The chain ROOT is never named by the constraint, and the solver moves
    // it: selecting it used to show no IK section at all.
    const rootId = f.rig.nodes[k.boneId]!.parentId!;
    const root = ikRelations(f.rig, rootId);
    expect(root).toHaveLength(1);
    expect(root[0]!.role).toBe("root");
    expect(root[0]!.constraint.id).toBe(k.id);
  });

  it("is empty for a bone no constraint touches", () => {
    expect(ikRelations(f.rig, f.node("head"))).toEqual([]);
  });
});

describe("ikRoles", () => {
  it("covers four targets and the eight bones they drive", () => {
    const { targets, driven } = ikRoles(f.rig);
    expect(targets.size).toBe(4);
    expect(driven.size).toBe(8);
    // Disjoint by construction: a target inside the chain it drives would be
    // skipped by the solver, and the rig must not contain one.
    for (const id of targets) expect(driven.has(id)).toBe(false);
  });

  it("agrees with the single-node lookup", () => {
    const { targets, driven } = ikRoles(f.rig);
    for (const id of Object.keys(f.rig.nodes) as NodeId[]) {
      const expected = targets.has(id) ? "target" : driven.has(id) ? "driven" : null;
      expect(ikRoleOf(f.rig, id), nameOf(id)).toBe(expected);
    }
  });
});

describe("ikSummary", () => {
  it("tells a target which bones it moves", () => {
    const k = f.rig.ik[0]!;
    const text = ikSummary(f.rig, k.targetId)!;
    expect(text).toContain("IK target");
    for (const id of ikChain(f.rig, k)) expect(text).toContain(nameOf(id));
    expect(text).toContain(k.name);
  });

  it("tells a solved bone what pulls it, and not to key it", () => {
    const k = f.rig.ik[0]!;
    const text = ikSummary(f.rig, k.boneId)!;
    expect(text).toContain(nameOf(k.targetId));
    expect(text).toContain("do not keyframe");
  });

  it("says nothing about an ordinary bone", () => {
    expect(ikSummary(f.rig, f.node("chest"))).toBeNull();
  });
});

describe("ikDrivenAmong", () => {
  it("names the solved bones in a re-parent, and nothing else", async () => {
    const { loadStickman } = await import("./fixtures/stickman");
    const { ikDrivenAmong } = await import("@/core/doc/ikGraph");
    const f = await loadStickman();
    const ids = ["leg_near_thigh", "leg_near_shin", "foot_near_target", "head_art"].map((n) => f.node(n));
    expect(ikDrivenAmong(f.rig, ids)).toEqual([f.node("leg_near_thigh"), f.node("leg_near_shin")]);
    expect(ikDrivenAmong(f.rig, [f.node("head_art")])).toEqual([]);
  });
});
