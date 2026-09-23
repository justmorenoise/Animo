import { describe, it, expect, beforeEach } from "vitest";
import { reseed, type AssetId } from "@/core/doc/ids";
import { createProject, createSymbol, createImageItem, createNode, createLayer, createAnimation } from "@/core/doc/defaults";
import { isSymbol, DOC_VERSION, type Keyframe, type Project, type SymbolItem, type Node } from "@/core/doc/types";
import { tf } from "@/core/math/Transform";
import { TWEEN_LINEAR } from "@/core/math/easing";
import { displaysOf, displayAt, findOrAddDisplay, itemsOf } from "@/core/doc/displays";
import { evaluateSymbol, childFrame, displayContext } from "@/core/doc/pose";
import { History } from "@/core/history/History";
import { SetPivot, SetNodeDisplays, SetNodeItem } from "@/core/history/commands";
import { wouldCreateCycle } from "@/core/history/symbolCommands";
import { validateProject, migrate } from "@/core/doc/schema";
import { exportSkeleton } from "@/core/export/exportSkeleton";

beforeEach(() => reseed());

const key = (frame: number, x: number, displayIndex: number): Keyframe =>
  ({ frame, transform: tf(x, 0), displayIndex, tween: TWEEN_LINEAR });

/** One layer showing `heart` (display 0) and `star` (display 1). */
function scene(keys: Keyframe[] = [key(0, 0, 0), key(10, 100, 1), key(20, 200, 1)]) {
  const project = createProject("Displays");
  const sym = project.items[project.rootSymbolId];
  if (!isSymbol(sym)) throw new Error("no root");
  const heart = createImageItem("heart", "a1" as AssetId, 70, 74);
  const star = createImageItem("star", "a2" as AssetId, 40, 40);
  project.items[heart.id] = heart;
  project.items[star.id] = star;
  project.itemOrder.push(heart.id, star.id);
  const node = createNode("image", "shape", { itemId: heart.id, pivotX: 35, pivotY: 37 });
  node.extraDisplays = [{ itemId: star.id, pivot: { x: 20, y: 20 } }];
  sym.nodes[node.id] = node;
  sym.layers = [createLayer(node.id, "shape", 0)];
  const anim = sym.animations[0]!;
  anim.duration = 30;
  anim.tracks[node.id] = { nodeId: node.id, endFrame: 29, keys };
  return { project, sym, anim, node, heart, star };
}

describe("display list", () => {
  it("is the node's own item first, then its extra displays", () => {
    const { node, heart, star } = scene();
    expect(displaysOf(node).map((d) => d.itemId)).toEqual([heart.id, star.id]);
    expect(displayAt(node, 1)?.pivot).toEqual({ x: 20, y: 20 });
    expect(displayAt(node, -1)).toBeNull();
    expect(displayAt(node, 2)).toBeNull();
    expect(itemsOf(node)).toEqual([heart.id, star.id]);
    expect(displaysOf(createNode("group", "g"))).toEqual([]);
  });

  it("finds a display by item AND transform point, appending otherwise", () => {
    const { node, star } = scene();
    const list = displaysOf(node);
    expect(findOrAddDisplay(list, { itemId: star.id, pivot: { x: 20, y: 20 } }).index).toBe(1);
    const added = findOrAddDisplay(list, { itemId: star.id, pivot: { x: 0, y: 0 } });
    expect(added.index).toBe(2);
    expect(added.displays).toHaveLength(3);
    expect(list).toHaveLength(2);                          // never edited in place
  });
});

describe("pose", () => {
  it("resolves the display each key shows, and where its run began", () => {
    const { sym, anim, node, heart, star } = scene([
      key(0, 0, 0), key(10, 100, 1), key(20, 200, 1), key(24, 0, -1), key(26, 0, 1),
    ]);
    const at = (f: number) => evaluateSymbol(sym, anim, f).byNode.get(node.id)!;
    expect(at(5).display?.itemId).toBe(heart.id);
    expect(at(5).displaySince).toBe(0);
    expect(at(15).display?.itemId).toBe(star.id);
    expect(at(22).displaySince).toBe(10);                  // 20 continues the run from 10
    expect(at(25).visible).toBe(false);
    expect(at(27).displaySince).toBe(26);                  // a blank key breaks the run
  });

  it("starts a run at the first key when the track starts late", () => {
    const { sym, anim, node } = scene([key(8, 0, 0)]);
    expect(evaluateSymbol(sym, anim, 12).byNode.get(node.id)!.displaySince).toBe(8);
  });

  it("plays a symbol swapped in mid-animation from its first animation, at 0", () => {
    const blink = createSymbol("Blink");
    blink.animations = [createAnimation("idle"), createAnimation("walk")];
    blink.animations[0]!.duration = 6;
    blink.animations[1]!.duration = 8;
    const ctx = { animationName: "walk", frame: 13, mode: "animate" as const };
    // Current since the parent's frame 0: follows the parent's name and frame.
    expect(childFrame(blink, displayContext(ctx, 0))).toMatchObject({ frame: 5 });
    expect(childFrame(blink, displayContext(ctx, 0)).animation?.name).toBe("walk");
    // Swapped in at 10: restarted there on its default animation.
    const late = childFrame(blink, displayContext(ctx, 10));
    expect(late.animation?.name).toBe("idle");
    expect(late.frame).toBe(3);
  });
});

describe("commands", () => {
  it("moves one display's transform point, compensating only its keys", () => {
    const { project, sym, anim, node } = scene();
    const history = new History(project);
    history.apply(new SetPivot(sym.id, new Map([[node.id, { x: 30, y: 20 }]]), {
      displays: new Map([[node.id, 1]]),
    }));
    const n = sym.nodes[node.id]!;
    expect(n.pivot).toEqual({ x: 35, y: 37 });
    expect(n.extraDisplays![0]!.pivot).toEqual({ x: 30, y: 20 });
    expect(anim.tracks[node.id]!.keys.map((k) => k.transform.x)).toEqual([0, 110, 210]);
    expect(n.bind.x).toBe(0);

    history.undo();
    expect(sym.nodes[node.id]!.extraDisplays![0]!.pivot).toEqual({ x: 20, y: 20 });
    expect(anim.tracks[node.id]!.keys.map((k) => k.transform.x)).toEqual([0, 100, 200]);
  });

  it("replaces the display list as a value, undo and redo included", () => {
    const { project, sym, node, heart } = scene();
    const history = new History(project);
    const before = sym.nodes[node.id]!.extraDisplays;
    const next = [...before!, { itemId: heart.id, pivot: { x: 0, y: 0 } }];
    history.apply(new SetNodeDisplays(sym.id, new Map([[node.id, next]])));
    expect(sym.nodes[node.id]!.extraDisplays).toHaveLength(2);
    history.undo();
    expect(sym.nodes[node.id]!.extraDisplays).toBe(before);
    history.redo();
    expect(sym.nodes[node.id]!.extraDisplays).toHaveLength(2);
  });

  it("swaps one display, leaving the node's own item and kind", () => {
    const { project, sym, node, heart } = scene();
    const other = createImageItem("moon", "a3" as AssetId, 10, 10);
    project.items[other.id] = other;
    const history = new History(project);
    history.apply(new SetNodeItem(sym.id, new Map([[node.id, { itemId: other.id, kind: "image", display: 1 }]])));
    expect(sym.nodes[node.id]!.itemId).toBe(heart.id);
    expect(sym.nodes[node.id]!.extraDisplays![0]!.itemId).toBe(other.id);
    history.undo();
    expect(sym.nodes[node.id]!.extraDisplays![0]!.itemId).not.toBe(other.id);
  });

  it("follows every display when looking for a cycle", () => {
    const { project, sym, node } = scene();
    const inner = createSymbol("Inner");
    project.items[inner.id] = inner;
    const n = sym.nodes[node.id]!;
    n.extraDisplays = [...n.extraDisplays!, { itemId: inner.id, pivot: { x: 0, y: 0 } }];
    // The root reaches Inner only through display 2.
    expect(wouldCreateCycle(project, inner.id, sym.id)).toBe(true);
  });
});

describe("loading", () => {
  it("drops displays whose item is gone and blanks the keys that showed them", () => {
    const { project, node } = scene();
    const raw = JSON.parse(JSON.stringify(project)) as Project;
    const sym = raw.items[raw.rootSymbolId] as SymbolItem;
    (sym.nodes[node.id] as Node).extraDisplays = [{ itemId: "gone" as never, pivot: { x: 1, y: 1 } }];
    const { project: out, diagnostics } = validateProject(migrate(raw));
    const loaded = (out.items[out.rootSymbolId] as SymbolItem);
    expect(loaded.nodes[node.id]!.extraDisplays).toBeUndefined();
    expect(loaded.animations[0]!.tracks[node.id]!.keys.map((k) => k.displayIndex)).toEqual([0, -1, -1]);
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("migrates a version 5 file", () => {
    const { project } = scene();
    const raw = JSON.parse(JSON.stringify({ ...project, version: 5 }));
    expect(validateProject(migrate(raw)).project.version).toBe(DOC_VERSION);
    expect(DOC_VERSION).toBe(7);
  });
});

describe("export", () => {
  it("writes every used display, each with its own pivot", () => {
    const { project } = scene();
    const { skeleton, usedImages } = exportSkeleton(project);
    const root = skeleton.armature[skeleton.armature.length - 1]!;
    const display = root.skin[0]!.slot[0]!.display;
    expect(display.map((d) => d.name)).toEqual(["heart", "star"]);
    expect(display[0]!.pivot).toEqual({ x: 0.5, y: 0.5 });
    expect(display[1]!.pivot).toEqual({ x: 0.5, y: 0.5 });
    expect(usedImages).toHaveLength(2);
    const frames = root.animation[0]!.slot![0]!.displayFrame!;
    expect(frames.map((f) => f.value ?? 0)).toEqual([0, 1, 1, 1]);   // keys, then the end
  });

  it("leaves out a display no key uses, remapping the ones after it", () => {
    const { project, sym, node, heart } = scene([key(0, 0, 0), key(10, 0, 2)]);
    const n = sym.nodes[node.id]!;
    n.extraDisplays = [...n.extraDisplays!, { itemId: heart.id, pivot: { x: 0, y: 0 } }];
    const { skeleton } = exportSkeleton(project);
    const root = skeleton.armature[skeleton.armature.length - 1]!;
    expect(root.skin[0]!.slot[0]!.display.map((d) => d.name)).toEqual(["heart", "heart"]);
    expect(root.animation[0]!.slot![0]!.displayFrame!.map((f) => f.value ?? 0)).toEqual([0, 1, 1]);
  });

  it("exports a symbol reached only through an extra display", () => {
    const { project, sym, node } = scene();
    const inner = createSymbol("Inner");
    project.items[inner.id] = inner;
    project.itemOrder.push(inner.id);
    const n = sym.nodes[node.id]!;
    n.extraDisplays = [{ itemId: inner.id, pivot: { x: 5, y: 5 } }];
    const { skeleton } = exportSkeleton(project);
    expect(skeleton.armature.map((a) => a.name)).toContain("Inner");
    const root = skeleton.armature[skeleton.armature.length - 1]!;
    const d = root.skin[0]!.slot[0]!.display[1]!;
    expect(d.type).toBe("armature");
    expect(d.transform).toEqual({ x: -5, y: -5 });
  });
});
