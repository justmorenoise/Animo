import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { createNode } from "@/core/doc/defaults";
import { tf } from "@/core/math/Transform";
import { TWEEN_LINEAR, TWEEN_NONE } from "@/core/math/easing";
import { insertKeyframe, sampleTransformRaw } from "@/core/doc/timeline";
import { buildBoneTimeline } from "@/core/export/frameSplit";
import { validateProject } from "@/core/doc/schema";
import type { Keyframe, Node, Track } from "@/core/doc/types";

let node: Node;
beforeEach(() => { reseed(); node = createNode("bone", "arm"); });

/** Keys at 0 and 10: x 0 → 100 and rotation 0 → 90, the position held. */
function held(): Track {
  const keys: Keyframe[] = [
    { frame: 0, transform: tf(0, 0), displayIndex: 0, tween: TWEEN_LINEAR, eases: { position: TWEEN_NONE } },
    { frame: 10, transform: tf(100, 0, 90, 90), displayIndex: 0, tween: TWEEN_LINEAR },
  ];
  return { nodeId: node.id, keys, endFrame: 10 };
}

describe("a hold on one channel", () => {
  it("holds that channel on the stage while the others tween", () => {
    const t = sampleTransformRaw(held(), 5)!;
    expect(t.x).toBe(0);
    expect(t.skewY).toBeCloseTo(45);
  });

  it("is exported as a hold in that channel only", () => {
    const tl = buildBoneTimeline(held(), node, 11)!;
    expect(tl.translateFrame![0]).not.toHaveProperty("tweenEasing");
    expect(tl.rotateFrame![0]!.tweenEasing).toBe(0);
  });

  it("survives a cut: both halves hold", () => {
    const cut = insertKeyframe(held(), 4, node)!;
    expect(sampleTransformRaw(cut, 2)!.x).toBe(0);
  });

  // Stage, cut and export only ever asked `easeOf`; the load step dropped it.
  it("is kept by the schema on load", () => {
    const doc = {
      version: 7, name: "d", frameRate: 24, stage: { width: 10, height: 10, background: "#fff" },
      items: {
        s: {
          kind: "symbol", id: "s", name: "s", ik: [], layers: [{ id: "l", nodeId: "n", name: "n", color: "#f00", visible: true, locked: false, outline: false, depth: 0 }],
          nodes: { n: { id: "n", name: "n", kind: "bone", parentId: null, bind: tf(), pivot: { x: 0, y: 0 } } },
          animations: [{ id: "a", name: "a", duration: 11, playTimes: 0, tracks: { n: { ...held(), nodeId: "n" } } }],
        },
      },
      folders: {}, itemOrder: ["s"], rootSymbolId: "s",
    };
    const { project } = validateProject(JSON.parse(JSON.stringify(doc))) as unknown as { project: typeof doc };
    expect(project.items.s.animations[0]!.tracks.n.keys[0]!.eases).toEqual({ position: { kind: "none" } });
  });
});
