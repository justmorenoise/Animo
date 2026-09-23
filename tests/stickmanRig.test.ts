import { describe, it, expect, beforeAll } from "vitest";
import { evaluateSymbol } from "@/core/doc/pose";
import { exportSkeleton } from "@/core/export/exportSkeleton";
import type { Project, SymbolItem } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";

/**
 * `stickman.animo` — the bone + IK rig, dance (front) and run (side).
 *
 * The two things this file has to keep true, both of them silent when they
 * break: every IK target stays INSIDE the chain's reach (an unreachable
 * target does not throw, the leg just straightens and the foot slides off the
 * ground), and no bone the solver drives is ever keyed (the runtime solves the
 * chain on playback, so a keyframe there fights it and the preview and the
 * stage drift apart).
 *
 * Regenerate the file with `npx vite-node scripts/buildStickman.ts`.
 */

let project: Project;
let rig: SymbolItem;

beforeAll(async () => {
  const f = await loadStickman();
  expect(f.diagnostics).toEqual([]);
  project = f.project;
  rig = f.rig;
});

describe("stickman rig", () => {
  it("carries both animations and four two-bone chains", () => {
    expect(rig.animations.map((a) => a.name)).toEqual(["dance", "run"]);
    expect(rig.ik).toHaveLength(4);
    for (const k of rig.ik) {
      expect(k.chain).toBe(1);
      expect(rig.nodes[k.boneId]?.kind).toBe("bone");
      expect(rig.nodes[k.targetId]?.kind).toBe("bone");
      // A target inside the chain it drives would be skipped by the solver.
      const root = rig.nodes[k.boneId]!.parentId!;
      let cursor = rig.nodes[k.targetId]!.parentId;
      while (cursor) {
        expect(cursor).not.toBe(root);
        cursor = rig.nodes[cursor]!.parentId;
      }
    }
  });

  it("keeps every IK target within reach, on every frame of both animations", () => {
    for (const anim of rig.animations) {
      for (let f = 0; f < anim.duration; f++) {
        const pose = evaluateSymbol(rig, anim, f, "animate");
        for (const k of rig.ik) {
          const effector = pose.byNode.get(k.boneId)!;
          const target = pose.byNode.get(k.targetId)!;
          const len = effector.node.boneLength ?? 0;
          const tipX = effector.world.tx + effector.world.a * len;
          const tipY = effector.world.ty + effector.world.b * len;
          const miss = Math.hypot(tipX - target.world.tx, tipY - target.world.ty);
          expect(
            miss,
            `${k.name} misses its target by ${miss.toFixed(2)}px at ${anim.name} frame ${f}`,
          ).toBeLessThan(0.01);
        }
      }
    }
  });

  it("never keyframes a bone the solver drives", () => {
    const driven = new Set<string>();
    for (const k of rig.ik) {
      driven.add(k.boneId);
      const parent = rig.nodes[k.boneId]?.parentId;
      if (parent) driven.add(parent);
    }
    for (const anim of rig.animations) {
      for (const id of Object.keys(anim.tracks)) {
        const node = rig.nodes[id as keyof typeof rig.nodes];
        expect(driven.has(id), `${node?.name} is keyed in ${anim.name}`).toBe(false);
      }
    }
  });

  it("exports one clean armature with both animations", () => {
    const { skeleton, diagnostics } = exportSkeleton(project);
    expect(diagnostics).toEqual([]);
    expect(skeleton.armature).toHaveLength(1);

    const armature = skeleton.armature[0]!;
    expect(armature.ik).toHaveLength(4);
    // 11 pieces of art, and no slot for the bones or the IK targets.
    expect(armature.slot).toHaveLength(11);

    const byName = new Map(armature.animation.map((a) => [a.name, a]));
    expect([...byName.keys()]).toEqual(["dance", "run"]);

    // Only the run shades the far side of the body, so only it carries slot
    // timelines — colour in the dance would mean the far limbs never lighten.
    expect(byName.get("dance")!.slot ?? []).toHaveLength(0);
    expect(byName.get("run")!.slot ?? []).toHaveLength(4);
  });
});
