import { describe, it, expect, beforeEach } from "vitest";
import { reseed, type AssetId } from "@/core/doc/ids";
import { createProject, createNode, createLayer, createImageItem } from "@/core/doc/defaults";
import { isSymbol } from "@/core/doc/types";
import { tf } from "@/core/math/Transform";
import { TWEEN_LINEAR } from "@/core/math/easing";
import { Clipboard, pastedParent } from "@/app/Clipboard";
import { evaluateSymbol } from "@/core/doc/pose";
import { Store } from "@/app/Store";

beforeEach(() => reseed());

function scene() {
  const project = createProject("Clip");
  const sym = project.items[project.rootSymbolId];
  if (!isSymbol(sym)) throw new Error("no root");

  const a = createNode("group", "a", { x: 100, y: 50 });
  const b = createNode("group", "b", { x: 200, y: 80 });
  b.parentId = a.id;
  sym.nodes[a.id] = a;
  sym.nodes[b.id] = b;
  sym.layers = [createLayer(b.id, "b", 0), createLayer(a.id, "a", 1)];

  sym.animations[0]!.tracks[a.id] = {
    nodeId: a.id, endFrame: 23,
    keys: [
      { frame: 0, transform: tf(100, 50), displayIndex: 0, tween: TWEEN_LINEAR },
      { frame: 12, transform: tf(180, 50), displayIndex: 0, tween: TWEEN_LINEAR },
    ],
  };

  return { store: new Store(project), sym, a, b };
}

describe("clipboard", () => {
  it("duplicates a node as it looks at the playhead, with no timeline", () => {
    const { store, a } = scene();
    const clip = new Clipboard();
    store.setFrame(6);                                  // halfway from x 100 to 180
    store.selectNodes([a.id]);

    expect(clip.duplicate(store)).toBe(1);
    const copy = store.selectedNodes[0]!;
    expect(copy.id).not.toBe(a.id);
    expect(copy.name).not.toBe(a.name);
    expect(copy.bind.x).toBeCloseTo(150, 6);            // 140 on screen, +10
    for (const anim of store.currentSymbol.animations) {
      expect(anim.tracks[copy.id]).toBeUndefined();
    }
  });

  it("keeps a parent that exists here, and links inside the copied set", () => {
    const { store, a, b } = scene();
    const clip = new Clipboard();

    // Copying both keeps b under the copy of a.
    store.selectNodes([a.id, b.id]);
    clip.copy(store);
    clip.paste(store);
    const pastedBoth = store.selectedNodes;
    const pastedA = pastedBoth.find((n) => n.name.startsWith("a"))!;
    const pastedB = pastedBoth.find((n) => n.name.startsWith("b"))!;
    expect(pastedB.parentId).toBe(pastedA.id);

    // Copying only the child keeps it under the original parent, beside it.
    store.selectNodes([b.id]);
    clip.copy(store);
    clip.paste(store);
    const lone = store.selectedNodes[0]!;
    expect(lone.parentId).toBe(a.id);
    expect(lone.bind.x).toBe(210);
    expect(lone.bind.y).toBe(90);
  });

  it("pasting twice gives two independent objects", () => {
    const { store, a } = scene();
    const clip = new Clipboard();
    store.selectNodes([a.id]);
    clip.copy(store);

    clip.paste(store);
    const first = store.selectedNodes[0]!;
    clip.paste(store);
    const second = store.selectedNodes[0]!;

    expect(first.id).not.toBe(second.id);
    expect(first.name).not.toBe(second.name);
    // No value shared between them, so a write into one cannot reach the other.
    expect(first.bind).not.toBe(second.bind);
    expect(first.pivot).not.toBe(second.pivot);
  });

  it("duplicate leaves the clipboard alone", () => {
    const { store, a, b } = scene();
    const clip = new Clipboard();
    store.selectNodes([a.id]);
    clip.copy(store);

    store.selectNodes([b.id]);
    clip.duplicate(store);

    // The clipboard should still hold `a`, not the duplicated `b`.
    store.clearSelection();
    clip.paste(store);
    expect(store.selectedNodes[0]!.name.startsWith("a")).toBe(true);
  });

  it("cut removes the original and can paste it back, children included", () => {
    // Cut deletes the whole subtree, so the clipboard has to hold all of it:
    // taking only the selection lost `b` for good.
    const { store, a, b } = scene();
    const clip = new Clipboard();
    store.selectNodes([a.id]);

    expect(clip.cut(store)).toBe(2);
    expect(store.currentSymbol.nodes[a.id]).toBeUndefined();
    expect(store.currentSymbol.nodes[b.id]).toBeUndefined();

    clip.paste(store);
    const pasted = store.selectedNodes;
    expect(pasted.length).toBe(2);
    const pa = pasted.find((n) => n.name === "a")!;
    const pb = pasted.find((n) => n.name === "b")!;
    expect(pb.parentId).toBe(pa.id);
  });

  it("offsets only the roots of what it pastes, so a child is not moved twice", () => {
    const { store, a, b } = scene();
    const clip = new Clipboard();
    store.selectNodes([a.id, b.id]);
    clip.copy(store);
    clip.paste(store);
    const pa = store.selectedNodes.find((n) => n.name.startsWith("a"))!;
    const pb = store.selectedNodes.find((n) => n.name.startsWith("b"))!;
    expect(pa.bind.x).toBe(110);
    expect(pb.bind.x).toBe(200);                        // still local to its (moved) parent
  });

  it("copying nothing does nothing", () => {
    const { store } = scene();
    const clip = new Clipboard();
    store.clearSelection();
    expect(clip.copy(store)).toBe(0);
    expect(clip.paste(store)).toBe(0);
  });
});

describe("clipboard, as Flash copies objects on stage", () => {
  function row() {
    const project = createProject("Row");
    const sym = project.items[project.rootSymbolId];
    if (!isSymbol(sym)) throw new Error("no root");
    const heart = createImageItem("heart", "a1" as AssetId, 70, 74);
    const star = createImageItem("star", "a2" as AssetId, 40, 40);
    project.items[heart.id] = heart;
    project.items[star.id] = star;
    const nodes = ["top", "mid", "bot"].map((name) => {
      const n = createNode("image", name, { itemId: heart.id, x: 100, y: 100, pivotX: 35, pivotY: 37 });
      sym.nodes[n.id] = n;
      return n;
    });
    sym.layers = nodes.map((n, i) => createLayer(n.id, n.name, i));
    return { project, sym, nodes, heart, star, store: new Store(project) };
  }
  const names = (s: Store) => s.currentSymbol.layers.map((l) => l.name);

  it("pastes a new layer directly above the selected one", () => {
    const { store, nodes } = row();
    const clip = new Clipboard();
    store.selectNodes([nodes[1]!.id]);
    clip.copy(store);
    clip.paste(store);
    expect(names(store)).toEqual(["top", "mid_2", "mid", "bot"]);
  });

  it("takes the colour and the artwork showing at the playhead", () => {
    const { store, sym, nodes, star } = row();
    const mid = nodes[1]!;
    sym.nodes[mid.id] = { ...mid, extraDisplays: [{ itemId: star.id, pivot: { x: 20, y: 20 } }] };
    sym.animations[0]!.tracks[mid.id] = {
      nodeId: mid.id, endFrame: 20,
      keys: [
        { frame: 0, transform: tf(100, 100), displayIndex: 0, tween: TWEEN_LINEAR,
          color: { aM: 100, rM: 100, gM: 100, bM: 100, aO: 0, rO: 0, gO: 0, bO: 0 } },
        { frame: 10, transform: tf(200, 100), displayIndex: 1, tween: TWEEN_LINEAR,
          color: { aM: 0, rM: 100, gM: 100, bM: 100, aO: 0, rO: 0, gO: 0, bO: 0 } },
        { frame: 20, transform: tf(300, 100), displayIndex: 1, tween: TWEEN_LINEAR,
          color: { aM: 100, rM: 100, gM: 100, bM: 100, aO: 0, rO: 0, gO: 0, bO: 0 } },
      ],
    };
    const clip = new Clipboard();
    store.setFrame(15);
    store.selectNodes([mid.id]);
    clip.copy(store);
    clip.paste(store, { x: 0, y: 0 });

    const copy = store.selectedNodes[0]!;
    expect(copy.itemId).toBe(star.id);
    expect(copy.pivot).toEqual({ x: 20, y: 20 });
    expect(copy.extraDisplays).toBeUndefined();
    expect(copy.bind.x).toBeCloseTo(250, 6);
    expect(copy.color?.aM).toBeCloseTo(50, 6);
  });

  it("fills a single selected empty layer in place", () => {
    const { store, sym, nodes, heart } = row();
    const empty = createNode("empty", "Layer 4");
    sym.nodes[empty.id] = empty;
    sym.layers.splice(1, 0, createLayer(empty.id, empty.name, 9));
    const clip = new Clipboard();
    store.selectNodes([nodes[2]!.id]);
    clip.copy(store);

    store.selectNodes([empty.id]);
    expect(clip.paste(store)).toBe(1);
    expect(names(store)).toEqual(["top", "Layer 4", "mid", "bot"]);
    const filled = store.currentSymbol.nodes[empty.id]!;
    expect(filled.kind).toBe("image");
    expect(filled.itemId).toBe(heart.id);
    expect(filled.pivot).toEqual({ x: 35, y: 37 });
    expect(filled.bind.x).toBe(110);
    expect(store.currentAnimation!.tracks[empty.id]).toBeUndefined();

    store.history.undo();
    expect(store.currentSymbol.nodes[empty.id]!.kind).toBe("empty");
  });

  it("re-expresses the pose when the empty layer hangs off another parent", () => {
    const { store, sym, nodes } = row();
    const group = createNode("group", "g", { x: 50, y: 0 });
    sym.nodes[group.id] = group;
    const empty = createNode("empty", "Layer 4");
    empty.parentId = group.id;
    sym.nodes[empty.id] = empty;
    sym.layers.push(createLayer(group.id, "g", 9), createLayer(empty.id, empty.name, 10));
    const clip = new Clipboard();
    store.selectNodes([nodes[0]!.id]);
    clip.copy(store);
    store.selectNodes([empty.id]);
    clip.paste(store, { x: 0, y: 0 });
    // Same place on screen: 100 in the scene is 50 inside a group at x 50.
    expect(store.currentSymbol.nodes[empty.id]!.bind.x).toBeCloseTo(50, 6);
  });

  it("cut holds a static pose too", () => {
    const { store, sym, nodes } = row();
    const top = nodes[0]!;
    sym.animations[0]!.tracks[top.id] = {
      nodeId: top.id, endFrame: 10,
      keys: [
        { frame: 0, transform: tf(0, 0), displayIndex: 0, tween: TWEEN_LINEAR },
        { frame: 10, transform: tf(100, 0), displayIndex: 0, tween: TWEEN_LINEAR },
      ],
    };
    const clip = new Clipboard();
    store.setFrame(5);
    store.selectNodes([top.id]);
    clip.cut(store);
    clip.paste(store, { x: 0, y: 0 });
    const pasted = store.selectedNodes[0]!;
    expect(pasted.bind.x).toBeCloseTo(50, 6);
    expect(store.currentAnimation!.tracks[pasted.id]).toBeUndefined();
  });
});

describe("instance properties", () => {
  it("copies everything the Properties panel shows, position included", () => {
    const { store, a, b } = scene();
    const clip = new Clipboard();
    store.setUi({ mode: "setup" }, "doc");

    a.bind = tf(100, 50, 35, 20, 1.4, 0.75);
    a.pivot = { x: 13, y: 6 };

    store.selectNodes([a.id]);
    expect(clip.copyProperties(store)).toBe(true);
    store.selectNodes([b.id]);
    expect(clip.pasteProperties(store)).toBe(1);

    const after = store.currentSymbol.nodes[b.id]!;
    expect(after.bind.x).toBeCloseTo(100, 6);
    expect(after.bind.y).toBeCloseTo(50, 6);
    expect(after.bind.scaleX).toBeCloseTo(1.4, 6);
    expect(after.bind.scaleY).toBeCloseTo(0.75, 6);
    expect(after.bind.skewX).toBeCloseTo(35, 6);
    expect(after.bind.skewY).toBeCloseTo(20, 6);
    expect(after.pivot).toEqual({ x: 13, y: 6 });
  });

  it("can leave position alone, for matching two things that must stay apart", () => {
    const { store, a, b } = scene();
    const clip = new Clipboard();
    store.setUi({ mode: "setup" }, "doc");
    a.bind = tf(100, 50, 0, 0, 1.4, 0.75);
    const bPos = { x: b.bind.x, y: b.bind.y };

    store.selectNodes([a.id]);
    clip.copyProperties(store);
    store.selectNodes([b.id]);
    clip.pasteProperties(store, false);

    const after = store.currentSymbol.nodes[b.id]!;
    expect(after.bind.scaleX).toBeCloseTo(1.4, 6);
    expect(after.bind.x).toBe(bPos.x);
    expect(after.bind.y).toBe(bPos.y);
  });

  it("applies to every selected instance at once", () => {
    const { store, a, b } = scene();
    const clip = new Clipboard();
    store.setUi({ mode: "setup" }, "doc");
    a.bind = tf(0, 0, 0, 0, 2, 2);

    store.selectNodes([a.id]);
    clip.copyProperties(store);
    store.selectNodes([a.id, b.id]);
    expect(clip.pasteProperties(store)).toBe(2);
    expect(store.currentSymbol.nodes[b.id]!.bind.scaleX).toBeCloseTo(2, 6);
  });

  it("does nothing with an empty clipboard", () => {
    const { store, a } = scene();
    const clip = new Clipboard();
    store.selectNodes([a.id]);
    expect(clip.pasteProperties(store)).toBe(0);
  });
});

/**
 * Layers are the same entries read as ROWS: nothing moves, the layer's own
 * flags come along, and the destination is a place in the stack. An empty
 * layer as the destination is consumed, which is what makes "make one empty
 * layer, paste three" produce three rows where the empty one was.
 */
describe("layer clipboard", () => {
  function stack() {
    const project = createProject("Rows");
    const sym = project.items[project.rootSymbolId];
    if (!isSymbol(sym)) throw new Error("no root");
    const nodes = ["top", "mid", "bot"].map((name) => {
      const n = createNode("group", name, { x: 10, y: 10 });
      sym.nodes[n.id] = n;
      return n;
    });
    sym.layers = nodes.map((n, i) => createLayer(n.id, n.name, i));
    return { store: new Store(project), sym, nodes };
  }

  const rows = (s: { currentSymbol: { layers: { name: string }[] } }) =>
    s.currentSymbol.layers.map((l) => l.name);

  it("pastes above the selected layer, without offsetting anything", () => {
    const { store, nodes } = stack();
    const clip = new Clipboard();
    store.selectNodes([nodes[2]!.id]);                 // "bot"
    expect(clip.copyLayers(store)).toBe(1);

    store.selectNodes([nodes[1]!.id]);                 // paste above "mid"
    expect(clip.pasteLayers(store)).toBe(1);

    expect(rows(store)).toEqual(["top", "bot_2", "mid", "bot"]);
    expect(store.selectedNodes[0]!.bind.x).toBe(10);   // no 10px nudge
  });

  it("consumes a single empty layer, pushing the rest down", () => {
    const { store, nodes } = stack();
    const clip = new Clipboard();
    store.selectNodes([nodes[0]!.id, nodes[2]!.id]);
    expect(clip.copyLayers(store)).toBe(2);

    // An empty layer between "top" and "mid" as the destination.
    const empty = createNode("empty", "Layer 1");
    store.currentSymbol.nodes[empty.id] = empty;
    store.currentSymbol.layers.splice(1, 0, createLayer(empty.id, empty.name, 9));
    store.selectNodes([empty.id]);

    expect(clip.pasteLayers(store)).toBe(2);
    expect(rows(store)).toEqual(["top", "top_2", "bot_2", "mid", "bot"]);
    expect(store.currentSymbol.nodes[empty.id]).toBeUndefined();
  });

  it("carries the layer's own flags across", () => {
    const { store, nodes } = stack();
    const clip = new Clipboard();
    const layer = store.currentSymbol.layers[2]!;
    layer.outline = true;
    layer.excludeFromExport = true;

    store.selectNodes([nodes[2]!.id]);
    clip.copyLayers(store);
    store.selectNodes([nodes[0]!.id]);
    clip.pasteLayers(store);

    const pasted = store.currentSymbol.layers[0]!;
    expect(pasted.outline).toBe(true);
    expect(pasted.excludeFromExport).toBe(true);
  });

  it("pastes a mask and what it clips as a working pair", () => {
    // Every AddNode normalises the layer list, and normalisation sees a mask
    // copy nobody links to yet and a target still pointing at the original —
    // so both flags are dropped before the whole set exists. They are put
    // back once, at the end, from the copied entries.
    const { store, nodes } = stack();
    const clip = new Clipboard();
    const sym = store.currentSymbol;
    sym.layers[1]!.isMask = true;                      // "mid" masks "bot"
    sym.layers[2]!.maskedBy = sym.layers[1]!.id;

    store.selectNodes([nodes[1]!.id, nodes[2]!.id]);
    expect(clip.copyLayers(store)).toBe(2);
    store.clearSelection();
    expect(clip.pasteLayers(store)).toBe(2);

    const [maskCopy, targetCopy] = sym.layers;
    expect(maskCopy!.isMask).toBe(true);
    expect(targetCopy!.maskedBy).toBe(maskCopy!.id);   // the copy, not the original
    // Rows are now [mid_2, bot_2, top, mid, bot] — the originals still linked.
    expect(sym.layers[4]!.maskedBy).toBe(sym.layers[3]!.id);
  });

  it("drops a mask link whose mask was not copied", () => {
    const { store, nodes } = stack();
    const clip = new Clipboard();
    const sym = store.currentSymbol;
    sym.layers[1]!.isMask = true;
    sym.layers[2]!.maskedBy = sym.layers[1]!.id;

    store.selectNodes([nodes[2]!.id]);                 // the target alone
    clip.copyLayers(store);
    store.clearSelection();
    clip.pasteLayers(store);

    expect(sym.layers[0]!.maskedBy).toBeUndefined();
  });

  it("duplicates a layer directly above the original", () => {
    const { store, nodes } = stack();
    const clip = new Clipboard();
    store.selectNodes([nodes[1]!.id]);
    expect(clip.duplicateLayers(store)).toBe(1);
    expect(rows(store)).toEqual(["top", "mid_2", "mid", "bot"]);
  });

  it("takes a group's children with it and re-parents them to the copy", () => {
    const { store, nodes } = stack();
    const clip = new Clipboard();
    store.currentSymbol.nodes[nodes[2]!.id]!.parentId = nodes[1]!.id;   // bot under mid
    store.selectNodes([nodes[1]!.id]);
    expect(clip.copyLayers(store)).toBe(2);

    store.selectNodes([nodes[0]!.id]);
    expect(clip.pasteLayers(store)).toBe(2);
    const copyOfMid = store.currentSymbol.layers[0]!;
    const copyOfBot = store.currentSymbol.layers[1]!;
    expect(store.currentSymbol.nodes[copyOfBot.nodeId]!.parentId)
      .toBe(copyOfMid.nodeId);
  });

  it("keeps the object clipboard and the layer clipboard apart", () => {
    const { store, nodes } = stack();
    const clip = new Clipboard();
    store.selectNodes([nodes[0]!.id]);
    clip.copy(store);
    clip.copyLayers(store);
    expect(clip.hasContent).toBe(true);
    expect(clip.hasLayers).toBe(true);
  });

  const clip = () => new Clipboard();

  it("a duplicated child stays in its group, where it was", () => {
    const { store, nodes } = stack();
    const sym = store.currentSymbol;
    const [top, mid, bot] = nodes;
    sym.nodes[mid!.id]!.bind = tf(200, 0, 30, 30);
    sym.nodes[bot!.id]!.parentId = mid!.id;            // bot is mid's child
    store.selectNodes([bot!.id]);
    const before = evaluateSymbol(sym, null, 0, "setup").byNode.get(bot!.id)!.world;

    expect(clip().duplicateLayers(store)).toBe(1);
    const copy = Object.values(sym.nodes).find((n) => n.name === "bot_2")!;
    expect(copy.parentId).toBe(mid!.id);
    const after = evaluateSymbol(sym, null, 0, "setup").byNode.get(copy.id)!.world;
    for (const k of ["a", "b", "c", "d", "tx", "ty"] as const) expect(after[k]).toBeCloseTo(before[k], 9);
    // Still inside mid's block, right above the original.
    expect(rows(store)).toEqual([top!.name, "mid", "bot_2", "bot"]);
  });
});

describe("pastedParent", () => {
  const ids = (s: string) => s as never;
  const copies = new Map([[ids("g"), ids("g2")]]);
  const here = (id: string) => id === "p";
  it.each([
    [null, null],
    ["g", "g2"],      // the parent came along: its copy
    ["p", "p"],       // exists here: kept
    ["x", null],      // neither
  ])("%s → %s", (parent, want) => {
    expect(pastedParent(parent as never, copies, here)).toBe(want);
  });
});


describe("a new document", () => {
  it("empties both clipboard slots", () => {
    const { store, a } = scene();
    const clip = new Clipboard();
    store.selectNodes([a.id]);
    clip.copy(store);
    clip.copyLayers(store);
    clip.reset();
    expect(clip.hasContent).toBe(false);
    expect(clip.hasLayers).toBe(false);
    expect(clip.paste(store)).toBe(0);
  });
});
