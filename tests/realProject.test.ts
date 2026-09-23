import { describe, it, expect, beforeEach } from "vitest";
import { reseed, type NodeId, type ItemId } from "@/core/doc/ids";
import { createNode, createLayer } from "@/core/doc/defaults";
import { DOC_VERSION, isImage, isSymbol, type SymbolItem, type Track } from "@/core/doc/types";
import { sampleTransformRaw } from "@/core/doc/timeline";
import { evaluateSymbol } from "@/core/doc/pose";
import { exportSkeleton } from "@/core/export/exportSkeleton";
import { AddNode, ReplaceImageAsset, SetLayerExcluded, SetNodeItem } from "@/core/history/commands";
import { wouldCreateCycle } from "@/core/history/symbolCommands";
import { serializeProject, deserializeProject } from "@/io/project/ProjectFile";
import { Clipboard } from "@/app/Clipboard";
import { FrameClipboard } from "@/app/FrameClipboard";
import type { Store } from "@/app/Store";
import {
  loadFixture, fakeAssets, RIG, rowNames, type Fixture,
} from "./fixtures/realProject";

beforeEach(() => reseed());

/**
 * The new timeline / library / export features, exercised against the real
 * `frog.animo` instead of a two-layer scene.
 *
 * Why the real file: every one of these features only misbehaves once a
 * symbol has SEVERAL rows and a long timeline — a mask that has to be
 * re-pointed at its copy, a track that must survive a paste, a suffix that
 * must not renumber when a sibling is excluded. The fixture has eleven
 * symbols, mask links, nested instances and animations up to 288 frames.
 */

/** The model half of `TimelinePanel.addEmptyLayer` — the panel adds only DOM. */
function addEmptyLayer(store: Store, name: string, at: number): NodeId {
  const sym = store.currentSymbol;
  const node = createNode("empty", name);
  const layer = createLayer(node.id, node.name, sym.layers.length);
  store.apply(new AddNode("New Layer", store.currentSymbolId, node, layer, at));
  store.selectNodes([node.id]);
  return node.id;
}

/** The selection `TimelinePanel.selectAllFrames` writes: whole rows, 0..end. */
function selectAllFrames(store: Store, nodeIds: NodeId[]): void {
  const duration = store.currentAnimation?.duration ?? 1;
  const frames: string[] = [];
  for (const id of nodeIds) {
    for (let f = 0; f < duration; f++) frames.push(`${id}:${f}`);
  }
  store.selection = { ...store.selection, nodes: nodeIds, frames };
}

const keyFrames = (track: Track | undefined) => (track?.keys ?? []).map((k) => k.frame);
const nodeOf = (sym: SymbolItem, layerName: string) =>
  sym.nodes[sym.layers.find((l) => l.name === layerName)!.nodeId]!;
const armatureNamed = (fx: Fixture, name: string) =>
  exportSkeleton(fx.project).skeleton.armature.find((a) => a.name === name)!;

describe("the fixture itself", () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await loadFixture(); });

  it("opens a v2 file and migrates it to the current version", () => {
    // The file on disk is version 2 — written before `excludeFromExport` and
    // the "empty" node kind existed. Loading it must land on the current one, not be
    // refused and not stay at 2.
    expect(fx.project.version).toBe(DOC_VERSION);
    expect(DOC_VERSION).toBe(7);
    expect(fx.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("has the multi-layer symbols these tests need", () => {
    expect(rowNames(fx.symbol(RIG.eyeLeft))).toEqual([
      "eyelid_mask", "eyelid_top", "eyelid_bottom", "pupil_2", "Layer 6",
    ]);
    expect(rowNames(fx.symbol(RIG.body))).toHaveLength(5);
    expect(fx.symbol(RIG.body).animations[0]!.duration).toBe(120);
    expect(fx.symbol(RIG.eyeLeft).animations[0]!.duration).toBe(288);
  });

  it("exports without errors, with the mask link the rig carries", () => {
    const result = exportSkeleton(fx.project);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    const link = result.masks.find((m) => m.armature === RIG.eyeLeft)!;
    expect(link.mask).toBe("eyelid_mask");
    expect(link.targets.sort()).toEqual(["eyelid_bottom", "eyelid_top"]);
  });
});

/* ── Copy / Paste / Duplicate Layer ─────────────────────────────────────── */

describe("layer clipboard on a five-layer symbol", () => {
  let fx: Fixture;
  let sym: SymbolItem;
  let clip: Clipboard;

  beforeEach(async () => {
    fx = await loadFixture();
    sym = fx.open(RIG.eyeLeft);
    clip = new Clipboard();
  });

  const allNodes = () => sym.layers.map((l) => l.nodeId);

  it("copies all five rows and pastes them above, in stack order", () => {
    fx.store.selectNodes(allNodes());
    expect(clip.copyLayers(fx.store)).toBe(5);

    fx.store.clearSelection();
    expect(clip.pasteLayers(fx.store)).toBe(5);

    expect(sym.layers).toHaveLength(10);
    // The copies land at the top, in the order they were stacked, with the
    // originals untouched below them.
    expect(rowNames(sym).slice(5)).toEqual([
      "eyelid_mask", "eyelid_top", "eyelid_bottom", "pupil_2", "Layer 6",
    ]);
    expect(rowNames(sym).slice(0, 5)).not.toContain("eyelid_mask");
    expect(new Set(allNodes()).size).toBe(10);         // every id is fresh
  });

  it("brings each row's whole timeline with it, unshifted", () => {
    const source = nodeOf(sym, "eyelid_top");
    const before = fx.store.currentAnimation!.tracks[source.id]!;

    fx.store.selectNodes([source.id]);
    clip.copyLayers(fx.store);
    clip.pasteLayers(fx.store);

    const copyId = fx.store.selection.nodes[0]!;
    const after = fx.store.currentAnimation!.tracks[copyId]!;
    expect(keyFrames(after)).toEqual(keyFrames(before));
    expect(after.endFrame).toBe(before.endFrame);
    // Layers paste with no offset — a copied row sits exactly on the original.
    expect(after.keys[0]!.transform.x).toBe(before.keys[0]!.transform.x);
    expect(after.keys[0]!.transform.y).toBe(before.keys[0]!.transform.y);
  });

  it("re-points a copied mask link at the copied mask", () => {
    const mask = nodeOf(sym, "eyelid_mask");
    const top = nodeOf(sym, "eyelid_top");
    fx.store.selectNodes([mask.id, top.id]);
    clip.copyLayers(fx.store);
    clip.pasteLayers(fx.store);

    const created = fx.store.selection.nodes;
    const copiedMask = sym.layers.find((l) => l.nodeId === created[0]);
    const copiedTop = sym.layers.find((l) => l.nodeId === created[1]);
    expect(copiedMask!.isMask).toBe(true);
    // The link must point at the COPY, or the pasted rows would clip through
    // the originals.
    expect(copiedTop!.maskedBy).toBe(copiedMask!.id);
    expect(copiedTop!.maskedBy).not.toBe(
      sym.layers.find((l) => l.nodeId === mask.id)!.id);
  });

  it("stays clipped by the original mask when pasted underneath it", () => {
    // The mask was not copied, but it is still here and still above the
    // pasted row — so the copy goes on being clipped, which is what "the same
    // layer" has to mean when the empty row sits inside a mask group.
    const mask = sym.layers[0]!;
    const top = nodeOf(sym, "eyelid_top");
    fx.store.selectNodes([top.id]);
    clip.copyLayers(fx.store);

    addEmptyLayer(fx.store, "Layer 7", 1);             // under eyelid_mask
    clip.pasteLayers(fx.store);

    const copied = sym.layers.find((l) => l.nodeId === fx.store.selection.nodes[0]);
    expect(sym.layers.indexOf(copied!)).toBe(1);
    expect(copied!.maskedBy).toBe(mask.id);
  });

  it("drops the link when the copy lands above that mask", () => {
    // Above its mask the link cannot mean anything — layers[0] is the top row
    // — so it falls away rather than clipping upwards.
    const top = nodeOf(sym, "eyelid_top");
    fx.store.selectNodes([top.id]);
    clip.copyLayers(fx.store);
    fx.store.clearSelection();
    clip.pasteLayers(fx.store);                        // at = 0, above the mask

    const copied = sym.layers.find((l) => l.nodeId === fx.store.selection.nodes[0]);
    expect(copied!.maskedBy).toBeUndefined();
  });

  it("consumes a single empty layer, sliding the rest down", () => {
    fx.store.selectNodes(allNodes());
    clip.copyLayers(fx.store);

    const empty = addEmptyLayer(fx.store, "Layer 7", 2);
    expect(rowNames(sym)[2]).toBe("Layer 7");

    expect(clip.pasteLayers(fx.store)).toBe(5);
    expect(sym.nodes[empty]).toBeUndefined();          // the empty row is gone
    expect(sym.layers).toHaveLength(10);
    expect(rowNames(sym).slice(0, 2)).toEqual(["eyelid_mask", "eyelid_top"]);
    expect(rowNames(sym).slice(7)).toEqual(["eyelid_bottom", "pupil_2", "Layer 6"]);
  });

  it("duplicates a row directly above the original, keeping the instance", () => {
    const pupil = nodeOf(sym, "pupil_2");
    const keys = keyFrames(fx.store.currentAnimation!.tracks[pupil.id]);
    expect(keys).toHaveLength(10);                     // the long, real track

    fx.store.selectNodes([pupil.id]);
    expect(clip.duplicateLayers(fx.store)).toBe(1);

    const copyId = fx.store.selection.nodes[0]!;
    expect(sym.layers.findIndex((l) => l.nodeId === copyId)).toBe(3);
    expect(sym.layers.findIndex((l) => l.nodeId === pupil.id)).toBe(4);
    expect(sym.nodes[copyId]!.kind).toBe("symbol");
    expect(sym.nodes[copyId]!.itemId).toBe(pupil.itemId);
    expect(keyFrames(fx.store.currentAnimation!.tracks[copyId])).toEqual(keys);
  });

  it("keeps the object clipboard intact while copying layers", () => {
    const pupil = nodeOf(sym, "pupil_2");
    fx.store.selectNodes([pupil.id]);
    clip.copy(fx.store);                               // stage clipboard
    fx.store.selectNodes(allNodes());
    clip.copyLayers(fx.store);                         // layer clipboard
    expect(clip.hasContent).toBe(true);
    expect(clip.hasLayers).toBe(true);
    expect(clip.paste(fx.store)).toBe(1);              // still the single node
  });

  it("refuses a paste that would put a symbol inside itself", () => {
    // arm_left_2 is an instance of `arm_left`; pasting that row INTO arm_left
    // is the cycle the guard exists for.
    fx.open(RIG.body);
    const arm = nodeOf(fx.symbol(RIG.body), "arm_left_2");
    fx.store.selectNodes([arm.id]);
    clip.copyLayers(fx.store);

    const armLeft = fx.open("arm_left");
    const before = armLeft.layers.length;
    expect(clip.pasteLayers(fx.store)).toBe(0);
    expect(armLeft.layers).toHaveLength(before);
    expect(wouldCreateCycle(fx.project, armLeft.id, arm.itemId!)).toBe(true);
  });

  it("carries the frames into another symbol, matching the animation by name", () => {
    // Animation ids are per symbol, so an id lookup finds nothing across the
    // boundary and the row used to arrive with its artwork and none of its
    // animation. Both symbols call their timeline "animation".
    const top = nodeOf(sym, "eyelid_top");
    const keys = keyFrames(sym.animations[0]!.tracks[top.id]);
    fx.store.selectNodes([top.id]);
    clip.copyLayers(fx.store);

    const body = fx.open(RIG.body);
    expect(body.animations[0]!.name).toBe(sym.animations[0]!.name);
    expect(clip.pasteLayers(fx.store)).toBe(1);

    const copyId = fx.store.selection.nodes[0]!;
    expect(body.nodes[copyId]!.itemId).toBe(top.itemId);
    expect(keyFrames(body.animations[0]!.tracks[copyId])).toEqual(keys);
  });

  it("falls back to the open timeline when no name matches", () => {
    // The root scene's animation is called "rest"; a single-timeline row has
    // exactly one place its keys can be about, so they go there rather than
    // being dropped without a word.
    const top = nodeOf(sym, "eyelid_top");
    const keys = keyFrames(sym.animations[0]!.tracks[top.id]);
    fx.store.selectNodes([top.id]);
    clip.copyLayers(fx.store);

    const scene = fx.open("Scene 1");
    expect(scene.animations.some((a) => a.name === sym.animations[0]!.name)).toBe(false);
    expect(clip.pasteLayers(fx.store)).toBe(1);

    const copyId = fx.store.selection.nodes[0]!;
    expect(keyFrames(fx.store.currentAnimation!.tracks[copyId])).toEqual(keys);
  });
});

describe("copying several layers reproduces them exactly", () => {
  let fx: Fixture;
  let sym: SymbolItem;
  let clip: Clipboard;

  beforeEach(async () => {
    fx = await loadFixture();
    sym = fx.open(RIG.eyeLeft);
    clip = new Clipboard();
  });

  /** Everything about a row that a copy must reproduce, node id aside. */
  const shapeOf = (nodeId: NodeId) => {
    const node = sym.nodes[nodeId]!;
    const layer = sym.layers.find((l) => l.nodeId === nodeId)!;
    return {
      kind: node.kind, itemId: node.itemId,
      bind: { ...node.bind }, pivot: { ...node.pivot },
      color: node.color, blendMode: node.blendMode, boneLength: node.boneLength,
      visible: layer.visible, outline: layer.outline,
      excludeFromExport: layer.excludeFromExport,
      // Keys of EVERY animation, not just the one on screen.
      tracks: sym.animations.map((a) => {
        const t = a.tracks[nodeId];
        return t && { endFrame: t.endFrame, keys: JSON.parse(JSON.stringify(t.keys)) };
      }),
    };
  };

  it("carries every frame of every animation, not just the open one", () => {
    // A second animation, keyed on one row only: a copy that reads the open
    // timeline alone would lose it and nothing on screen would say so.
    const second = { id: "a2", name: "second", duration: 30, tracks: {} } as
      unknown as (typeof sym.animations)[number];
    const node = nodeOf(sym, "eyelid_top");
    second.tracks[node.id] = {
      nodeId: node.id, endFrame: 29,
      keys: [
        { frame: 0, transform: { ...node.bind }, displayIndex: 0, tween: { kind: "linear" } },
        { frame: 29, transform: { ...node.bind, x: 999 }, displayIndex: 0, tween: { kind: "none" } },
      ],
    } as never;
    sym.animations.push(second);

    fx.store.selectNodes([node.id]);
    clip.copyLayers(fx.store);
    clip.pasteLayers(fx.store);

    const copyId = fx.store.selection.nodes[0]!;
    expect(keyFrames(sym.animations[0]!.tracks[copyId])).toEqual(
      keyFrames(sym.animations[0]!.tracks[node.id]));
    expect(keyFrames(second.tracks[copyId])).toEqual([0, 29]);
    expect(second.tracks[copyId]!.keys[1]!.transform.x).toBe(999);
  });

  it("pastes five rows onto one empty layer, each identical to its original", () => {
    const originals = sym.layers.map((l) => l.nodeId);
    const before = originals.map(shapeOf);

    fx.store.selectNodes(originals);
    expect(clip.copyLayers(fx.store)).toBe(5);

    // The Flash gesture: make one empty row, paste the stack into it.
    addEmptyLayer(fx.store, "Layer 7", 0);
    expect(clip.pasteLayers(fx.store)).toBe(5);

    const created = fx.store.selection.nodes;
    expect(created).toHaveLength(5);
    expect(sym.layers.slice(0, 5).map((l) => l.nodeId)).toEqual(created);
    expect(sym.layers.slice(5).map((l) => l.nodeId)).toEqual(originals);

    created.forEach((id, i) => {
      // Everything but the identity: same artwork, same pose, same frames,
      // same flags — which is what "the same layer, pasted" has to mean.
      expect(shapeOf(id)).toEqual(before[i]);
      expect(id).not.toBe(originals[i]);
    });
    // ...and every key really is there, not an empty track that merely exists.
    expect(keyFrames(sym.animations[0]!.tracks[created[1]!])).toHaveLength(13);
  });

  it("keeps the copied rows drawing where the originals draw", () => {
    // Same pose at the same frame, evaluated through the pose engine rather
    // than by reading the keys back — a paste that shifted a parent link or a
    // pivot would still have matching keyframes and draw somewhere else.
    const originals = sym.layers.map((l) => l.nodeId);
    fx.store.selectNodes(originals);
    clip.copyLayers(fx.store);
    clip.pasteLayers(fx.store);
    const created = fx.store.selection.nodes;

    for (const frame of [0, 73, 200]) {
      const pose = evaluateSymbol(sym, sym.animations[0]!, frame, "animate");
      created.forEach((id, i) => {
        const copy = pose.byNode.get(id)!;
        const original = pose.byNode.get(originals[i]!)!;
        expect(copy.world).toEqual(original.world);
      });
    }
  });

  it("duplicates several rows at once, above the topmost of them", () => {
    const picked = [nodeOf(sym, "eyelid_top").id, nodeOf(sym, "eyelid_bottom").id];
    const before = picked.map(shapeOf);

    fx.store.selectNodes(picked);
    expect(clip.duplicateLayers(fx.store)).toBe(2);

    const created = fx.store.selection.nodes;
    expect(sym.layers.map((l) => l.nodeId).slice(1, 3)).toEqual(created);
    created.forEach((id, i) => expect(shapeOf(id)).toEqual(before[i]));
  });
});

/* ── Frames ─────────────────────────────────────────────────────────────── */

describe("frames on a symbol with four keyed layers", () => {
  let fx: Fixture;
  let sym: SymbolItem;
  let frames: FrameClipboard;

  beforeEach(async () => {
    fx = await loadFixture();
    sym = fx.open(RIG.body);
    frames = new FrameClipboard();
  });

  it("Select All Frames covers every frame of every selected row", () => {
    const rows = sym.layers.map((l) => l.nodeId);
    selectAllFrames(fx.store, rows);

    expect(fx.store.selection.frames).toHaveLength(5 * 120);
    const sel = FrameClipboard.selectionOf(fx.store)!;
    expect(sel.from).toBe(0);
    expect(sel.to).toBe(119);                          // duration - 1
    expect(sel.nodeIds).toHaveLength(5);
  });

  it("copies a whole row and pastes it over another row's range (overwrite)", () => {
    const source = nodeOf(sym, "body_top");
    const target = nodeOf(sym, "leg");
    const sourceKeys = fx.store.currentAnimation!.tracks[source.id]!.keys;
    expect(keyFrames(fx.store.currentAnimation!.tracks[target.id])).toEqual([0, 49, 119]);

    selectAllFrames(fx.store, [source.id]);
    expect(frames.copy(fx.store)).toBe(120);
    expect(frames.paste(fx.store, target.id, 0, "overwrite")).toBe(120);

    const after = fx.store.currentAnimation!.tracks[target.id]!;
    expect(keyFrames(after)).toEqual([0, 49, 119]);
    expect(after.keys[1]!.transform.x).toBe(sourceKeys[1]!.transform.x);
    expect(after.keys[1]!.transform.y).toBe(sourceKeys[1]!.transform.y);
  });

  it("repeats a run further along the same row, keeping what falls outside (overwrite)", () => {
    const source = nodeOf(sym, "body_top");
    const target = nodeOf(sym, "leg");
    fx.store.selection = {
      ...fx.store.selection,
      nodes: [source.id],
      frames: Array.from({ length: 50 }, (_, f) => `${source.id}:${f}`),
    };
    expect(frames.copy(fx.store)).toBe(50);            // frames 0..49

    expect(frames.paste(fx.store, target.id, 60, "overwrite")).toBe(50);
    // 0 and 49 survive (before the pasted range), 119 survives (after it),
    // and the two copied keys land at 60 and 109.
    expect(keyFrames(fx.store.currentAnimation!.tracks[target.id])).toEqual([0, 49, 60, 109, 119]);
  });

  it("bakes the visible pose when the range starts mid-span", () => {
    const source = nodeOf(sym, "body_top");
    const target = nodeOf(sym, "leg");
    const track = fx.store.currentAnimation!.tracks[source.id]!;
    const shown = sampleTransformRaw(track, 20)!;

    fx.store.selection = {
      ...fx.store.selection,
      nodes: [source.id],
      frames: Array.from({ length: 10 }, (_, i) => `${source.id}:${20 + i}`),
    };
    expect(frames.copy(fx.store)).toBe(10);
    frames.paste(fx.store, target.id, 60);

    const pasted = fx.store.currentAnimation!.tracks[target.id]!.keys.find((k) => k.frame === 60)!;
    expect(pasted.transform.x).toBeCloseTo(shown.x, 6);
    expect(pasted.transform.y).toBeCloseTo(shown.y, 6);
  });

  it("cut clears the range and can be pasted back", () => {
    const target = nodeOf(sym, "leg");
    fx.store.selection = {
      ...fx.store.selection,
      nodes: [target.id],
      frames: Array.from({ length: 20 }, (_, i) => `${target.id}:${40 + i}`),
    };
    const before = fx.store.currentAnimation!.tracks[target.id]!.keys.find((k) => k.frame === 49)!;

    expect(frames.cut(fx.store)).toBe(20);
    expect(keyFrames(fx.store.currentAnimation!.tracks[target.id])).toEqual([0, 119]);

    frames.paste(fx.store, target.id, 40, "overwrite");
    const back = fx.store.currentAnimation!.tracks[target.id]!.keys.find((k) => k.frame === 49)!;
    expect(back.transform.x).toBe(before.transform.x);
    expect(back.transform.y).toBe(before.transform.y);
  });

  it("pastes onto a row that has no track at all, materialising one", () => {
    const source = nodeOf(sym, "body_top");
    const empty = addEmptyLayer(fx.store, "Layer 9", 0);
    selectAllFrames(fx.store, [source.id]);
    frames.copy(fx.store);

    expect(frames.paste(fx.store, empty, 0)).toBe(120);
    expect(keyFrames(fx.store.currentAnimation!.tracks[empty])).toEqual([0, 49, 119]);
  });
});

/* ── Empty layers, exclude from export, swap instance ───────────────────── */

describe("empty layers and Exclude from Export on the real rig", () => {
  let fx: Fixture;
  let sym: SymbolItem;

  beforeEach(async () => {
    fx = await loadFixture();
    sym = fx.open(RIG.eyeLeft);
  });

  it("an empty layer changes nothing about the exported file", () => {
    const before = JSON.stringify(exportSkeleton(fx.project).skeleton);
    addEmptyLayer(fx.store, "Layer 7", 0);
    expect(JSON.stringify(exportSkeleton(fx.project).skeleton)).toBe(before);
  });

  it("excluding the mask layer removes its bone, slot and mask link", () => {
    const layer = sym.layers.find((l) => l.name === "eyelid_mask")!;
    const image = sym.nodes[layer.nodeId]!.itemId!;
    expect(exportSkeleton(fx.project).usedImages).toContain(image);

    fx.store.apply(new SetLayerExcluded(sym.id, [layer.id], true));

    const result = exportSkeleton(fx.project);
    const arm = result.skeleton.armature.find((a) => a.name === RIG.eyeLeft)!;
    expect(arm.slot.map((s) => s.name)).not.toContain("eyelid_mask");
    expect(arm.bone.map((b) => b.name)).not.toContain("eyelid_mask");
    expect(arm.animation[0]!.bone?.some((b) => b.name === "eyelid_mask")).toBeFalsy();
    expect(result.masks.some((m) => m.armature === RIG.eyeLeft)).toBe(false);
    // The image drops out of the atlas because nothing draws it any more.
    expect(result.usedImages).not.toContain(image);
    expect(result.diagnostics.some((d) => d.message.includes("eyelid_mask"))).toBe(true);
  });

  it("leaves the other rows of the same symbol named exactly as they were", () => {
    const before = armatureNamed(fx, RIG.eyeLeft).slot.map((s) => s.name)
      .filter((n) => n !== "eyelid_mask");
    const layer = sym.layers.find((l) => l.name === "eyelid_mask")!;
    fx.store.apply(new SetLayerExcluded(sym.id, [layer.id], true));
    expect(armatureNamed(fx, RIG.eyeLeft).slot.map((s) => s.name)).toEqual(before);
  });

  it("is undoable, byte for byte", () => {
    const before = JSON.stringify(exportSkeleton(fx.project).skeleton);
    const layer = sym.layers.find((l) => l.name === "eyelid_bottom")!;
    fx.store.apply(new SetLayerExcluded(sym.id, [layer.id], true));
    expect(JSON.stringify(exportSkeleton(fx.project).skeleton)).not.toBe(before);

    fx.store.undo();
    expect("excludeFromExport" in layer).toBe(false);
    expect(JSON.stringify(exportSkeleton(fx.project).skeleton)).toBe(before);
  });

  it("survives a save and reload", async () => {
    const layer = sym.layers.find((l) => l.name === "Layer 6")!;
    fx.store.apply(new SetLayerExcluded(sym.id, [layer.id], true));
    const emptyId = addEmptyLayer(fx.store, "Layer 7", 0);

    const assets = fakeAssets();
    const blob = await serializeProject(fx.project, fx.assets);
    const { project } = await deserializeProject(await blob.arrayBuffer(), assets);

    expect(project.version).toBe(DOC_VERSION);
    const reloaded = Object.values(project.items).find((i) => i.name === RIG.eyeLeft)!;
    if (!isSymbol(reloaded)) throw new Error("no symbol");
    expect(reloaded.layers.find((l) => l.name === "Layer 6")!.excludeFromExport).toBe(true);
    expect(reloaded.nodes[emptyId]!.kind).toBe("empty");
  });
});

describe("Swap Instance on a real node", () => {
  let fx: Fixture;
  let sym: SymbolItem;

  beforeEach(async () => {
    fx = await loadFixture();
    sym = fx.open(RIG.eyeLeft);
  });

  it("changes only the item, keeping pose, transform point and timeline", () => {
    const node = nodeOf(sym, "eyelid_top");
    // Resolved through the OTHER node, not by item name: in this rig the
    // layer names and the library names are crossed (the layer "eyelid_top"
    // draws the item called "eyelid_bottom"), which is exactly the kind of
    // thing a hand-built fixture never reproduces.
    const other = nodeOf(sym, "eyelid_bottom").itemId!;
    const bind = { ...node.bind };
    const pivot = { ...node.pivot };
    const track = fx.store.currentAnimation!.tracks[node.id]!;
    const keys = keyFrames(track);

    fx.store.apply(new SetNodeItem(sym.id, new Map([[node.id, { itemId: other, kind: "image" }]])));

    expect(node.itemId).toBe(other);
    expect(node.kind).toBe("image");
    expect(node.bind).toEqual(bind);
    expect(node.pivot).toEqual(pivot);
    expect(fx.store.currentAnimation!.tracks[node.id]).toBe(track);
    expect(keyFrames(fx.store.currentAnimation!.tracks[node.id])).toEqual(keys);

    fx.store.undo();
    expect(node.itemId).not.toBe(other);
    expect(keyFrames(fx.store.currentAnimation!.tracks[node.id])).toEqual(keys);
  });

  it("swaps an image for a symbol, and the export follows", () => {
    const node = nodeOf(sym, "Layer 6");
    const symbolItem = fx.itemId(RIG.pupil2);
    fx.store.apply(new SetNodeItem(
      sym.id, new Map([[node.id, { itemId: symbolItem, kind: "symbol" }]])));

    const arm = armatureNamed(fx, RIG.eyeLeft);
    const slot = arm.skin[0]!.slot.find((s) => s.name === "Layer 6")!;
    expect(slot.display[0]!.type).toBe("armature");
    expect(slot.display[0]!.name).toBe(RIG.pupil2);
  });

  it("fills an empty layer in place, keeping its row and its id", () => {
    const item = nodeOf(sym, "eyelid_top").itemId!;
    const emptyId = addEmptyLayer(fx.store, "Layer 7", 1);
    const layerId = sym.layers[1]!.id;

    fx.store.apply(new SetNodeItem(
      sym.id, new Map([[emptyId, { itemId: item, kind: "image" }]])));

    expect(sym.layers[1]!.id).toBe(layerId);           // same row, same z-order
    expect(sym.layers[1]!.nodeId).toBe(emptyId);
    expect(armatureNamed(fx, RIG.eyeLeft).slot.map((s) => s.name)).toContain("Layer 7");
  });

  it("is refused where it would nest a symbol inside itself", () => {
    // eye_left already contains an instance of pupil_2, so putting eye_left
    // inside pupil_2 is a cycle — the guard every entry point must call.
    expect(wouldCreateCycle(fx.project, fx.itemId(RIG.pupil2), fx.symbol(RIG.eyeLeft).id)).toBe(true);
    expect(wouldCreateCycle(fx.project, fx.symbol(RIG.eyeLeft).id, fx.itemId(RIG.pupil2))).toBe(false);
  });
});

/* ── Replace Image ──────────────────────────────────────────────────────── */

describe("Replace Image on an image used by several rows", () => {
  let fx: Fixture;

  beforeEach(async () => { fx = await loadFixture(); });

  it("keeps the ItemId, so every instance, pivot and track survives", () => {
    const sym = fx.open(RIG.eyeLeft);
    const node = nodeOf(sym, "eyelid_top");
    const itemId = node.itemId!;
    const item = fx.project.items[itemId]!;
    if (!isImage(item)) throw new Error("not an image");
    const was = { assetId: item.assetId, width: item.width, height: item.height };
    const name = item.name;
    const pivot = { ...node.pivot };
    const keys = keyFrames(sym.animations[0]!.tracks[node.id]);

    const hosts = Object.values(fx.project.items)
      .filter(isSymbol)
      .filter((s) => Object.values(s.nodes).some((n) => n.itemId === itemId))
      .map((s) => s.id as ItemId);
    expect(hosts).toContain(sym.id);

    fx.store.apply(new ReplaceImageAsset(
      itemId, { assetId: "asset_new" as never, width: 240, height: 180 }, hosts));

    expect(item.assetId).toBe("asset_new");
    expect(item.width).toBe(240);
    expect(item.height).toBe(180);
    expect(item.name).toBe(name);                      // the item is not renamed
    expect(node.itemId).toBe(itemId);
    expect(node.pivot).toEqual(pivot);                 // pivots deliberately untouched
    expect(keyFrames(sym.animations[0]!.tracks[node.id])).toEqual(keys);

    fx.store.undo();
    expect(item.assetId).toBe(was.assetId);
    expect(item.width).toBe(was.width);
    expect(item.height).toBe(was.height);
  });

  it("re-anchors the exported pivot, exactly as the toast warns", () => {
    // The transform point is stored in PIXELS and the exporter normalises it
    // against the untrimmed size, so a resize moves the anchor inside the
    // artwork — even for a pivot that was dead centre, which every pivot in
    // this rig is. This is the shift the user is told about instead of
    // discovering it in game.
    const sym = fx.open(RIG.eyeLeft);
    const node = nodeOf(sym, "eyelid_top");
    const itemId = node.itemId!;
    const pivotOf = () => armatureNamed(fx, RIG.eyeLeft)
      .skin[0]!.slot.find((s) => s.name === "eyelid_top")!.display[0]!.pivot!;
    expect(pivotOf()).toEqual({ x: 0.5, y: 0.5 });     // 70,40 of 140x80
    expect(node.pivot).toEqual({ x: 70, y: 40 });

    fx.store.apply(new ReplaceImageAsset(
      itemId, { assetId: "asset_new" as never, width: 240, height: 180 }, [sym.id]));

    expect(node.pivot).toEqual({ x: 70, y: 40 });      // untouched, by design
    const after = pivotOf();
    expect(after.x).toBeCloseTo(70 / 240, 4);
    expect(after.y).toBeCloseTo(40 / 180, 4);

    fx.store.undo();
    expect(pivotOf()).toEqual({ x: 0.5, y: 0.5 });
  });
});
