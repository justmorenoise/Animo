import { beforeEach, describe, expect, it } from "vitest";
import { type AssetId, reseed } from "@/core/doc/ids";
import { buildDbImport, type DbImageRef } from "@/core/doc/dbImport";
import { evaluateSymbol } from "@/core/doc/pose";
import { isSymbol, type Node, type Project, type SymbolItem } from "@/core/doc/types";
import { easeScalar } from "@/core/math/easing";
import { mat, mul, type Matrix2D } from "@/core/math/Matrix2D";
import { exportSkeleton } from "@/core/export/exportSkeleton";

beforeEach(() => reseed());

const images = new Map<string, DbImageRef>([
  ["arm", { assetId: "s1" as AssetId, width: 100, height: 40 }],
  ["hand", { assetId: "s2" as AssetId, width: 30, height: 30 }],
  ["body", { assetId: "s3" as AssetId, width: 80, height: 120 }],
]);

type Json = Record<string, unknown>;
/** A skeleton of one armature called "rig", at 24 fps. */
const skeleton = (arm: Json, extra: Json = {}) => ({
  name: "test", version: "5.5", frameRate: 24, armature: [{ name: "rig", bone: [], slot: [], skin: [{ name: "", slot: [] }], animation: [], ...arm }], ...extra,
});
const open = (arm: Json, extra: Json = {}) => buildDbImport({ name: "x", skeleton: skeleton(arm, extra), images });
const rootOf = (p: Project) => p.items[p.rootSymbolId] as SymbolItem;
const nodeNamed = (sym: SymbolItem, name: string) => Object.values(sym.nodes).find((n) => n.name === name)!;

/** The matrix a node's artwork is drawn with, at a frame of an animation (null: the setup pose). */
function drawMatrix(sym: SymbolItem, node: string, anim: string | null, frame = 0): Matrix2D | null {
  const pose = evaluateSymbol(sym, anim ? sym.animations.find((a) => a.name === anim)! : null, frame, anim ? "animate" : "setup");
  // A slot named after its bone shares the name: the artwork's entry is the one with a display.
  const e = pose.entries.find((x) => x.node.name === node && (x.node.kind === "image" || x.node.kind === "symbol"))!;
  if (!e.visible || !e.display) return null;
  return mul(mat(), e.world, { a: 1, b: 0, c: 0, d: 1, tx: -e.display.pivot.x, ty: -e.display.pivot.y });
}
/** Positions to 0.005 px (a curve's table holds four decimals of progress), the rest to 0.0005. */
const close = (m: Matrix2D | null, expected: Partial<Matrix2D>) => {
  for (const [k, v] of Object.entries(expected)) expect(m![k as keyof Matrix2D], k).toBeCloseTo(v as number, k === "tx" || k === "ty" ? 2 : 3);
};

describe("bones and slots", () => {
  it("a slot under a long bone is its own node, drawn through its display's transform and pivot", () => {
    const { project, warnings } = open({
      bone: [{ name: "root" }, { name: "upper", parent: "root", length: 120, transform: { x: 10, y: 20, skX: 90, skY: 90 } }],
      slot: [{ name: "upper", parent: "upper" }],
      skin: [{ slot: [{ name: "upper", display: [{ name: "arm", transform: { x: 50 }, pivot: { x: 0.25, y: 0.5 } }] }] }],
    });
    const sym = rootOf(project);
    const bone = nodeNamed(sym, "upper");
    expect(bone.kind).toBe("bone");
    expect(bone.boneLength).toBe(120);
    expect(nodeNamed(sym, "root").kind).toBe("group");
    const slot = Object.values(sym.nodes).find((n) => n.kind === "image")!;
    expect(slot.parentId).toBe(bone.id);
    // Both keep the file's name, as DragonBones Pro names a slot after its bone.
    expect(slot.name).toBe("upper");
    expect(warnings).toEqual([]);
    // Bone: translate (10, 20), turned 90°. Display: 50 along the bone, then −pivot (25, 20).
    close(drawMatrix(sym, "upper", null), { a: 0, b: 1, c: -1, d: 0, tx: 10 + 20, ty: 20 + 50 - 25 });
    // And it goes out again as it came: the slot on its bone, its place the display's transform.
    const arm = exportSkeleton(project).skeleton.armature[0]!;
    expect(arm.bone.map((b) => b.name)).toEqual(["root", "upper"]);
    expect(arm.slot).toEqual([{ name: "upper", parent: "upper" }]);
    expect(arm.skin[0]!.slot[0]!.display).toEqual([{ name: "arm", pivot: { x: 0.25, y: 0.5 }, transform: { x: 50 } }]);
  });

  it("a slot alone on its bone, called the same and at its origin, is that bone's node, as Animo writes them", () => {
    const { project } = open({
      bone: [{ name: "arm", transform: { x: 5 } }],
      slot: [{ name: "arm", parent: "arm" }],
      skin: [{ slot: [{ name: "arm", display: [{ name: "arm" }] }] }],
    });
    const sym = rootOf(project);
    expect(Object.values(sym.nodes)).toHaveLength(1);
    const node = nodeNamed(sym, "arm");
    expect(node.kind).toBe("image");
    // An absent pivot is the middle, as the runtime reads it.
    expect(node.pivot).toEqual({ x: 50, y: 20 });
  });

  it("the setup pose shows the slot's displayIndex: it becomes display 0, and the timeline's indices follow", () => {
    const { project } = open({
      bone: [{ name: "b" }],
      slot: [{ name: "s", parent: "b", displayIndex: 1 }],
      skin: [{ slot: [{ name: "s", display: [{ name: "arm" }, { name: "hand" }] }] }],
      animation: [{ name: "go", duration: 4, slot: [{ name: "s", displayFrame: [{ duration: 2, value: 0 }, { duration: 2, value: 1 }] }] }],
    });
    const sym = rootOf(project);
    const node = nodeNamed(sym, "s");
    expect(project.items[node.itemId!]!.name).toBe("hand");
    expect(node.extraDisplays!.map((d) => project.items[d.itemId]!.name)).toEqual(["arm"]);
    expect(sym.animations[0]!.tracks[node.id]!.keys.map((k) => [k.frame, k.displayIndex])).toEqual([[0, 1], [2, 0]]);
  });

  it("a slot hidden in the setup pose is hidden in every animation that does not show it", () => {
    const { project } = open({
      bone: [{ name: "b" }],
      slot: [{ name: "s", parent: "b", displayIndex: -1 }],
      skin: [{ slot: [{ name: "s", display: [{ name: "arm" }] }] }],
      animation: [{ name: "idle", duration: 3 }],
    });
    const sym = rootOf(project);
    expect(drawMatrix(sym, "s", "idle", 1)).toBeNull();
  });

  it("displays placed apart in one slot keep their places through their transform points", () => {
    const { project, warnings } = open({
      bone: [{ name: "b" }],
      slot: [{ name: "s", parent: "b" }],
      skin: [{ slot: [{ name: "s", display: [{ name: "arm", transform: { x: 10, y: 0, skX: 90, skY: 90 } }, { name: "hand", transform: { x: 30, y: 10, skX: 90, skY: 90 } }] }] }],
      animation: [{ name: "swap", duration: 2, slot: [{ name: "s", displayFrame: [{ value: 0 }, { value: 1 }] }] }],
    });
    expect(warnings).toEqual([]);
    const sym = rootOf(project);
    // hand: its pivot (15, 15) at (30, 10), turned 90°.
    close(drawMatrix(sym, "s", "swap", 1), { a: 0, b: 1, c: -1, d: 0, tx: 30 + 15, ty: 10 - 15 });
  });

  it("names what it leaves out", () => {
    const { warnings } = open({
      bone: [{ name: "b" }],
      slot: [{ name: "s", parent: "b" }, { name: "t", parent: "b" }],
      skin: [{ slot: [{ name: "s", display: [{ type: "mesh", name: "m" }, { name: "nowhere" }] }] }, { name: "other", slot: [] }],
      animation: [{ name: "a", duration: 2, ffd: [{ name: "m" }], zOrder: { frame: [] }, frame: [{ events: [{ name: "hit" }] }] }],
    }, { version: "5.6" });
    const all = warnings.join("\n");
    for (const re of [/meshes are not supported/, /no texture "nowhere"/, /only one skin/, /mesh deformations/, /draw order changes/, /events, sounds and actions/, /newer than 5\.5/]) {
      expect(all).toMatch(re);
    }
  });

  it("nodes the file leaves unnamed are node, node_2…", () => {
    const { project } = open({ bone: [{ name: "" }], slot: [{ name: "", parent: "" }, { name: "s", parent: "" }] });
    expect(Object.values(rootOf(project).nodes).map((n) => n.name).sort()).toEqual(["node", "node_2", "s"]);
  });
});

describe("timelines", () => {
  const rig = (animation: Json) => open({
    bone: [{ name: "b" }],
    slot: [{ name: "b", parent: "b" }],
    skin: [{ slot: [{ name: "b", display: [{ name: "hand", pivot: { x: 0, y: 0 } }] }] }],
    animation: [animation],
  });
  const at = (p: Project, anim: string, f: number) => drawMatrix(rootOf(p), "b", anim, f)!;

  it("each channel keeps its own keys and eases: the pose matches the file's at every frame", () => {
    // Translate: 0 → 100 over 10 frames, quad in. Rotate: linear 0 → 90 at 4, then 90 → 0.
    const { project } = rig({
      name: "a", duration: 10, playTimes: 1, bone: [{
        name: "b",
        translateFrame: [{ duration: 10, tweenEasing: -1, x: 0 }, { duration: 0, x: 100 }],
        rotateFrame: [{ duration: 4, tweenEasing: 0, rotate: 0 }, { duration: 6, tweenEasing: 0, rotate: 90 }, { duration: 0, rotate: 0 }],
      }],
    });
    for (let f = 0; f < 10; f++) {
      const x = 100 * easeScalar(f / 10, -1);
      const deg = f <= 4 ? (90 * f) / 4 : 90 - (90 * (f - 4)) / 6;
      const r = (deg * Math.PI) / 180;
      close(at(project, "a", f), { tx: x, a: Math.cos(r), b: Math.sin(r) });
    }
  });

  it("a channel that holds while another tweens holds", () => {
    const { project } = rig({
      name: "a", duration: 10, playTimes: 1, bone: [{
        name: "b",
        translateFrame: [{ duration: 10, x: 0 }, { duration: 0, x: 100 }],
        scaleFrame: [{ duration: 10, tweenEasing: 0, x: 1 }, { duration: 0, x: 2 }],
      }],
    });
    close(at(project, "a", 5), { tx: 0, a: 1.5 });
  });

  it("rotation takes the short way, unless a frame asks for whole turns", () => {
    const short = rig({ name: "a", duration: 4, playTimes: 1, bone: [{ name: "b", rotateFrame: [{ duration: 2, tweenEasing: 0, rotate: 170 }, { duration: 2, rotate: -170 }] }] });
    const node = nodeNamed(rootOf(short.project), "b");
    expect(rootOf(short.project).animations[0]!.tracks[node.id]!.keys.map((k) => k.transform.skewY)).toEqual([170, 190]);
    const turns = rig({ name: "a", duration: 4, playTimes: 1, bone: [{ name: "b", rotateFrame: [{ duration: 2, tweenEasing: 0, rotate: 0, clockwise: 1 }, { duration: 2, rotate: 10 }] }] });
    const n2 = nodeNamed(rootOf(turns.project), "b");
    expect(rootOf(turns.project).animations[0]!.tracks[n2.id]!.keys.map((k) => k.transform.skewY)).toEqual([0, 10]);
    const twice = rig({ name: "a", duration: 4, playTimes: 1, bone: [{ name: "b", rotateFrame: [{ duration: 2, tweenEasing: 0, rotate: 0, clockwise: 2 }, { duration: 2, rotate: 10 }] }] });
    const n3 = nodeNamed(rootOf(twice.project), "b");
    expect(rootOf(twice.project).animations[0]!.tracks[n3.id]!.keys.map((k) => k.transform.skewY)).toEqual([0, 370]);
  });

  it("reads the 5.0 timeline, one frame list with a whole transform each", () => {
    const { project } = rig({
      name: "a", duration: 4, playTimes: 1, bone: [{ name: "b", frame: [
        { duration: 4, tweenEasing: 0, transform: { x: 0, skX: 0, skY: 0 } },
        { duration: 0, transform: { x: 40, skX: 90, skY: 90 } },
      ] }],
    });
    close(at(project, "a", 2), { tx: 20, a: Math.cos(Math.PI / 4), b: Math.sin(Math.PI / 4) });
  });

  it("a looping animation's last frame tweens back to the first", () => {
    const { project } = rig({
      name: "a", duration: 10, playTimes: 0, bone: [{ name: "b", translateFrame: [{ duration: 5, x: 0 }, { duration: 5, tweenEasing: 0, x: 50 }] }],
    });
    // 50 at 5, back toward 0 at 10.
    close(at(project, "a", 9), { tx: 10 });
    const once = rig({ name: "a", duration: 10, playTimes: 1, bone: [{ name: "b", translateFrame: [{ duration: 5, x: 0 }, { duration: 5, tweenEasing: 0, x: 50 }] }] });
    close(at(once.project, "a", 9), { tx: 50 });
  });

  it("colour tweens, and the slot's own colour is the node's", () => {
    const { project } = open({
      bone: [{ name: "b" }],
      slot: [{ name: "b", parent: "b", color: { aM: 50 } }],
      skin: [{ slot: [{ name: "b", display: [{ name: "hand" }] }] }],
      animation: [{ name: "fade", duration: 4, playTimes: 1, slot: [{ name: "b", colorFrame: [{ duration: 4, tweenEasing: 0, value: { aM: 100 } }, { duration: 0, value: { aM: 0 } }] }] }],
    });
    const sym = rootOf(project);
    expect(nodeNamed(sym, "b").color!.aM).toBe(50);
    const pose = evaluateSymbol(sym, sym.animations[0]!, 2);
    expect(pose.entries[0]!.color.aM).toBeCloseTo(50);
  });
});

describe("the document", () => {
  it("draws slots in the file's order where the bones allow, and names those it cannot keep", () => {
    // Back to front: a1 (under A), b1 (under B), a2 (under A). A's two cannot both sit on either side of B's.
    const { project, warnings } = open({
      bone: [{ name: "A" }, { name: "B" }],
      slot: [{ name: "a1", parent: "A" }, { name: "b1", parent: "B" }, { name: "a2", parent: "A" }],
      skin: [{ slot: ["a1", "b1", "a2"].map((n) => ({ name: n, display: [{ name: "hand" }] })) }],
    });
    const rows = rootOf(project).layers.map((l) => l.name);
    expect(rows.filter((r) => r.startsWith("a") || r.startsWith("b"))).toEqual(["a2", "a1", "b1"]);
    expect(warnings.join(" ")).toMatch(/"b1" cannot keep the file's draw order/);
    const fine = open({
      bone: [{ name: "A" }, { name: "B" }],
      slot: [{ name: "a1", parent: "A" }, { name: "b1", parent: "B" }, { name: "b2", parent: "B" }],
      skin: [{ slot: ["a1", "b1", "b2"].map((n) => ({ name: n, display: [{ name: "hand" }] })) }],
    });
    expect(fine.warnings).toEqual([]);
    expect(rootOf(fine.project).layers.map((l) => l.name)).toEqual(["B", "b2", "b1", "A", "a1"]);
  });

  it("keeps IK, and makes its bones bones", () => {
    const { project } = open({
      bone: [{ name: "thigh", length: 50 }, { name: "shin", parent: "thigh", length: 0 }, { name: "target", transform: { x: 30, y: 60 } }],
      ik: [{ name: "leg", bone: "shin", target: "target", chain: 1, bendPositive: false, weight: 0.5 }],
    });
    const sym = rootOf(project);
    expect(sym.ik).toEqual([expect.objectContaining({
      name: "leg", boneId: nodeNamed(sym, "shin").id, targetId: nodeNamed(sym, "target").id, chain: 1, bendPositive: false, weight: 0.5,
    })]);
    expect(nodeNamed(sym, "target").kind).toBe("bone");
  });

  it("the scene is the armature no other one shows; a child plays the animation it starts with first", () => {
    const { project } = buildDbImport({
      name: "x", images, skeleton: {
        version: "5.5", frameRate: 30, armature: [
          { name: "child", bone: [{ name: "b" }], slot: [], skin: [], defaultActions: [{ gotoAndPlay: "walk" }], animation: [{ name: "idle", duration: 2 }, { name: "walk", duration: 4 }] },
          { name: "scene", bone: [{ name: "c" }], slot: [{ name: "c", parent: "c" }], skin: [{ slot: [{ name: "c", display: [{ type: "armature", name: "child" }] }] }], animation: [] },
        ],
      },
    });
    expect(project.items[project.rootSymbolId]!.name).toBe("scene");
    expect(project.frameRate).toBe(30);
    const child = Object.values(project.items).find((i) => i.name === "child") as SymbolItem;
    expect(child.animations.map((a) => a.name)).toEqual(["walk", "idle"]);
    expect(nodeNamed(rootOf(project), "c").kind).toBe("symbol");
  });

  it("takes the stage from the scene's canvas, or frames its bounds", () => {
    const withCanvas = open({ canvas: { x: -100, y: -50, width: 200, height: 100, color: 0x336699 }, bone: [{ name: "b" }] });
    expect(withCanvas.project.stage).toEqual({ width: 200, height: 100, background: "#336699" });
    expect(nodeNamed(rootOf(withCanvas.project), "b").bind.x).toBe(100);
    const withBounds = open({ aabb: { x: -50, y: -50, width: 100, height: 100 }, bone: [{ name: "b" }] });
    expect(withBounds.project.stage.width).toBe(120);
    expect(nodeNamed(rootOf(withBounds.project), "b").bind.x).toBe(60);
  });

  it("exports again what it read", () => {
    const { project } = open({
      bone: [{ name: "b", transform: { x: 3 } }],
      slot: [{ name: "b", parent: "b" }],
      skin: [{ slot: [{ name: "b", display: [{ name: "hand" }] }] }],
      animation: [{ name: "a", duration: 6, bone: [{ name: "b", translateFrame: [{ duration: 6, tweenEasing: 0, x: 0 }, { duration: 0, x: 12 }] }] }],
    });
    const again = exportSkeleton(project).skeleton.armature[0]!;
    expect(again.bone).toEqual([{ name: "b", transform: { x: 3 } }]);
    // Animo shows frames 0 to 5: the last takes the value on the way to 12 at 6.
    expect(again.animation[0]!.bone![0]!.translateFrame).toEqual([{ duration: 5, tweenEasing: 0 }, { x: 10 }, { duration: 0, x: 10 }]);
    // Mapped nodes are real nodes: kinds and parents.
    const nodes: Node[] = Object.values(rootOf(project).nodes);
    expect(nodes.every((n) => isSymbol(project.items[project.rootSymbolId]) && (n.parentId === null || rootOf(project).nodes[n.parentId]))).toBe(true);
  });
});
