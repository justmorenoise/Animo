import { describe, it, expect, beforeEach } from "vitest";
import { reseed, type AssetId } from "@/core/doc/ids";
import { createProject, createNode, createLayer, createImageItem } from "@/core/doc/defaults";
import { isSymbol } from "@/core/doc/types";
import { tf } from "@/core/math/Transform";
import { TWEEN_LINEAR } from "@/core/math/easing";
import { Store } from "@/app/Store";
import { FrameClipboard } from "@/app/FrameClipboard";
import { sampleTransformRaw } from "@/core/doc/timeline";
import { evaluateSymbol } from "@/core/doc/pose";

beforeEach(() => reseed());

function scene(keys: Array<{ f: number; y: number }>) {
  const project = createProject("F");
  const sym = project.items[project.rootSymbolId];
  if (!isSymbol(sym)) throw new Error("no root");
  const n = createNode("group", "n", { x: 0, y: 0 });
  sym.nodes[n.id] = n;
  sym.layers = [createLayer(n.id, "n", 0)];
  sym.animations[0]!.tracks[n.id] = {
    nodeId: n.id,
    endFrame: 23,
    keys: keys.map((k) => ({
      frame: k.f, transform: tf(0, k.y), displayIndex: 0, tween: TWEEN_LINEAR,
    })),
  };
  const store = new Store(project);
  return { store, n };
}

const frames = (store: Store, id: string) =>
  store.currentAnimation!.tracks[id as never]!.keys.map((k) => ({
    f: k.frame, y: k.transform.y,
  }));

describe("frame clipboard", () => {
  it("copies one frame over the end to close a loop (overwrite)", () => {
    const { store, n } = scene([{ f: 0, y: 100 }, { f: 12, y: 40 }]);
    const clip = new FrameClipboard();

    store.selection = { ...store.selection, frames: [`${n.id}:0`] };
    expect(clip.copy(store)).toBe(1);
    expect(clip.paste(store, n.id, 23, "overwrite")).toBe(1);

    const out = frames(store, n.id);
    expect(out.map((k) => k.f)).toEqual([0, 12, 23]);
    // The last frame now matches the first, so the loop has no jump.
    expect(out[out.length - 1]!.y).toBe(out[0]!.y);
  });

  it("repeats a run further along the same layer", () => {
    const { store, n } = scene([{ f: 0, y: 100 }, { f: 12, y: 40 }]);
    const clip = new FrameClipboard();

    store.selection = {
      ...store.selection,
      frames: Array.from({ length: 13 }, (_, i) => `${n.id}:${i}`),
    };
    expect(clip.copy(store)).toBe(13);
    expect(clip.paste(store, n.id, 30)).toBe(13);

    expect(frames(store, n.id).map((k) => k.f)).toEqual([0, 12, 30, 42]);
    // The animation grew to fit what was pasted.
    expect(store.currentAnimation!.duration).toBe(43);
  });

  it("replaces whatever was already inside the pasted range", () => {
    const { store, n } = scene([{ f: 0, y: 100 }, { f: 5, y: 70 }, { f: 12, y: 40 }]);
    const clip = new FrameClipboard();

    store.selection = { ...store.selection, frames: [`${n.id}:0`] };
    clip.copy(store);
    clip.paste(store, n.id, 5, "overwrite");  // one frame, over the key at 5

    const out = frames(store, n.id);
    expect(out.map((k) => k.f)).toEqual([0, 5, 12]);
    expect(out[1]!.y).toBe(100);         // replaced, not merged
  });

  it("bakes the visible pose when the range starts mid-tween", () => {
    // Selecting frame 6 of a 0..12 tween has no keyframe of its own; copying
    // must still capture what is on screen, or the paste would be empty.
    const { store, n } = scene([{ f: 0, y: 0 }, { f: 12, y: 120 }]);
    const clip = new FrameClipboard();

    store.selection = { ...store.selection, frames: [`${n.id}:6`] };
    expect(clip.copy(store)).toBe(1);
    clip.paste(store, n.id, 20);

    const pasted = frames(store, n.id).find((k) => k.f === 20)!;
    expect(pasted.y).toBeCloseTo(60, 6);
  });

  it("cut removes the range but keeps the frame-0 anchor", () => {
    const { store, n } = scene([{ f: 0, y: 100 }, { f: 5, y: 70 }, { f: 12, y: 40 }]);
    const clip = new FrameClipboard();

    store.selection = { ...store.selection, frames: [`${n.id}:5`, `${n.id}:6`] };
    expect(clip.cut(store)).toBe(2);
    expect(frames(store, n.id).map((k) => k.f)).toEqual([0, 12]);

    clip.paste(store, n.id, 5, "overwrite");
    expect(frames(store, n.id).map((k) => k.f)).toEqual([0, 5, 12]);
  });

  it("reads a contiguous run out of the selection", () => {
    const { store, n } = scene([{ f: 0, y: 0 }]);
    store.selection = {
      ...store.selection,
      frames: [`${n.id}:3`, `${n.id}:7`, `${n.id}:5`],
    };
    expect(FrameClipboard.selectionOf(store)).toEqual({ nodeIds: [n.id], from: 3, to: 7 });
  });

  it("does nothing without a selection", () => {
    const { store } = scene([{ f: 0, y: 0 }]);
    const clip = new FrameClipboard();
    expect(clip.copy(store)).toBe(0);
    expect(clip.paste(store)).toBe(0);
  });
});

describe("frame clipboard, copying from inside a tween", () => {
  it("bakes colour and the turns still to come when a copy starts mid-tween", () => {
    const { store, n } = scene([{ f: 0, y: 0 }, { f: 12, y: 0 }]);
    const anim = store.currentAnimation!;
    const track = anim.tracks[n.id]!;
    anim.tracks[n.id] = {
      ...track,
      keys: [
        { ...track.keys[0]!, transform: tf(0, 0, 0, 0), rotateDir: "cw", rotateTurns: 1 }, // 450° in all
        {
          ...track.keys[1]!, transform: tf(0, 0, 90, 90),
          color: { aM: 0, rM: 100, gM: 100, bM: 100, aO: 0, rO: 0, gO: 0, bO: 0 },
        },
      ],
    };
    const original = anim.tracks[n.id]!;

    const clip = new FrameClipboard();
    store.selection = {
      ...store.selection,
      frames: Array.from({ length: 7 }, (_, i) => `${n.id}:${6 + i}`),
    };
    clip.copy(store);
    clip.paste(store, n.id, 30);

    const after = store.currentAnimation!.tracks[n.id]!;
    const pasted = after.keys.find((k) => k.frame === 30)!;
    expect(pasted.color?.aM).toBeCloseTo(50, 6);
    // Three frames in, the spin is where the original was at frame 9.
    expect(sampleTransformRaw(after, 33)!.skewY).toBeCloseTo(sampleTransformRaw(original, 9)!.skewY, 6);
  });
});

/**
 * `test_Anim.animo` in miniature: two hearts in a group, keyed alike, and
 * a star beside them. A frame carries what the layer shows there, as in
 * Flash, and several rows paste into the target and the layers below it.
 */
describe("frames carry their content", () => {
  function hearts() {
    const project = createProject("Hearts");
    const sym = project.items[project.rootSymbolId];
    if (!isSymbol(sym)) throw new Error("no root");
    const heart = createImageItem("heart_a", "a1" as AssetId, 70, 74);
    const star = createImageItem("star", "a2" as AssetId, 40, 40);
    project.items[heart.id] = heart;
    project.items[star.id] = star;

    const group = createNode("group", "Group 1", { x: 0, y: 0 });
    const a = createNode("image", "heart_a", { itemId: heart.id, x: 336, y: 305, pivotX: 35, pivotY: 37 });
    const b = createNode("image", "heart_a_2", { itemId: heart.id, x: 342, y: 323, pivotX: 35, pivotY: 37 });
    a.parentId = group.id;
    b.parentId = group.id;
    for (const n of [group, a, b]) sym.nodes[n.id] = n;
    sym.layers = [group, a, b].map((n, i) => createLayer(n.id, n.name, i));

    const anim = sym.animations[0]!;
    anim.duration = 92;
    for (const n of [a, b]) {
      anim.tracks[n.id] = {
        nodeId: n.id, endFrame: 91,
        keys: [0, 35, 72, 84, 91].map((f) => ({
          frame: f, transform: tf(n.bind.x + f, n.bind.y), displayIndex: 0, tween: TWEEN_LINEAR,
        })),
      };
    }
    return { project, sym, heart, star, group, a, b, store: new Store(project) };
  }

  const select = (store: Store, ids: string[], from: number, to: number) => {
    store.selection = {
      ...store.selection,
      frames: ids.flatMap((id) => Array.from({ length: to - from + 1 }, (_, i) => `${id}:${from + i}`)),
    };
  };
  const keysOf = (store: Store, id: string) =>
    store.currentAnimation!.tracks[id as never]!.keys.map((k) => k.frame);

  it("pastes every copied row, from the target layer down", () => {
    const { store, a, b } = hearts();
    const clip = new FrameClipboard();
    select(store, [a.id, b.id], 72, 91);           // Flash's 73–92
    expect(clip.copy(store)).toBe(20);

    select(store, [a.id], 92, 92);                 // Flash's 93 on heart_a
    expect(clip.paste(store)).toBe(20);

    for (const id of [a.id, b.id]) {
      expect(keysOf(store, id)).toEqual([0, 35, 72, 84, 91, 92, 104, 111]);
      expect(store.currentAnimation!.tracks[id]!.endFrame).toBe(111);
    }
    expect(store.currentAnimation!.duration).toBe(112);
  });

  it("creates a layer below when the stack runs out", () => {
    const { store, sym, heart, group, a, b } = hearts();
    const clip = new FrameClipboard();
    select(store, [a.id, b.id], 72, 91);
    clip.copy(store);

    select(store, [b.id], 92, 92);                 // Flash's 93 on heart_a_2
    clip.paste(store);

    expect(sym.layers.map((l) => l.name)).toEqual(["Group 1", "heart_a", "heart_a_2", "heart_a_3"]);
    const added = Object.values(sym.nodes).find((n) => n.name === "heart_a_3")!;
    expect(added.parentId).toBe(group.id);
    expect(added.itemId).toBe(heart.id);
    // heart_a_2 took heart_a's frames: its x runs 336 + 72 ... at 92.
    expect(store.currentAnimation!.tracks[b.id]!.keys.find((k) => k.frame === 92)!.transform.x).toBe(408);
    const track = store.currentAnimation!.tracks[added.id]!;
    expect(track.keys.map((k) => k.frame)).toEqual([92, 104, 111]);
    expect(track.keys[0]!.transform.x).toBe(342 + 72);
    // Not on stage before the run it was created for.
    const early = evaluateSymbol(sym, store.currentAnimation, 50).byNode.get(added.id)!;
    expect(early.visible).toBe(false);

    store.history.undo();
    expect(sym.layers).toHaveLength(3);
    expect(keysOf(store, b.id)).toEqual([0, 35, 72, 84, 91]);
    store.history.redo();
    expect(sym.layers).toHaveLength(4);
  });

  it("fills an empty layer with the copied artwork, tween kept", () => {
    const { store, sym, heart, a } = hearts();
    const anim = store.currentAnimation!;
    const src = anim.tracks[a.id]!;
    anim.tracks[a.id] = {
      ...src,
      keys: src.keys.map((k, i) => (i === 0 ? { ...k, tween: { kind: "ease" as const, value: -1 } } : k)),
    };
    const empty = createNode("empty", "Layer 1");
    sym.nodes[empty.id] = empty;
    sym.layers.unshift(createLayer(empty.id, empty.name, 9));

    const clip = new FrameClipboard();
    select(store, [a.id], 0, 0);
    clip.copy(store);
    select(store, [empty.id], 0, 0);
    clip.paste(store);

    const filled = sym.nodes[empty.id]!;
    expect(filled.kind).toBe("image");
    expect(filled.itemId).toBe(heart.id);
    expect(filled.pivot).toEqual({ x: 35, y: 37 });
    const track = anim.tracks[empty.id]!;
    expect(track.keys).toHaveLength(1);
    expect(track.keys[0]!.tween).toEqual({ kind: "ease", value: -1 });
    expect(track.endFrame).toBe(0);
    const entry = evaluateSymbol(sym, anim, 0).byNode.get(empty.id)!;
    expect(entry.visible).toBe(true);
    expect(entry.display?.itemId).toBe(heart.id);
  });

  it("adds the copied artwork to a layer that shows something else", () => {
    const { store, sym, heart, star, a } = hearts();
    const other = createNode("image", "star", { itemId: star.id, x: 0, y: 0, pivotX: 20, pivotY: 20 });
    sym.nodes[other.id] = other;
    sym.layers.push(createLayer(other.id, "star", 9));

    const clip = new FrameClipboard();
    select(store, [a.id], 72, 91);
    clip.copy(store);
    select(store, [other.id], 10, 10);
    clip.paste(store);

    const node = sym.nodes[other.id]!;
    expect(node.itemId).toBe(star.id);
    expect(node.extraDisplays).toEqual([{ itemId: heart.id, pivot: { x: 35, y: 37 } }]);
    const anim = store.currentAnimation!;
    const shown = (f: number) => evaluateSymbol(sym, anim, f).byNode.get(other.id)!.display?.itemId;
    expect(shown(5)).toBe(star.id);
    expect(shown(15)).toBe(heart.id);
    expect(shown(30)).toBe(star.id);             // the star moved right, intact
  });

  it("replaces a selected range rather than inserting before it", () => {
    const { store, a } = hearts();
    const clip = new FrameClipboard();
    select(store, [a.id], 0, 0);
    clip.copy(store);
    select(store, [a.id], 35, 40);                // six frames over the key at 35
    clip.paste(store);
    // The six frames go and one comes in, so everything after the range
    // moves 5 left; what followed it, the rest of key 35's span, stays.
    expect(keysOf(store, a.id)).toEqual([0, 35, 36, 67, 79, 86]);
  });

  it("carries what the source did NOT show", () => {
    const { store, sym, a, b } = hearts();
    const anim = store.currentAnimation!;
    const late = anim.tracks[b.id]!;
    anim.tracks[b.id] = { ...late, keys: late.keys.filter((k) => k.frame >= 35) };

    const clip = new FrameClipboard();
    select(store, [a.id, b.id], 30, 39);
    clip.copy(store);
    select(store, [b.id], 92, 92);
    clip.paste(store);

    const added = Object.values(sym.nodes).find((n) => n.name === "heart_a_3")!;
    const track = anim.tracks[added.id]!;
    expect(track.keys.map((k) => [k.frame, k.displayIndex])).toEqual([[92, -1], [97, 0]]);
  });
});

describe("dragging frames to a new location", () => {
  function two() {
    const project = createProject("Drag");
    const sym = project.items[project.rootSymbolId];
    if (!isSymbol(sym)) throw new Error("no root");
    const heart = createImageItem("heart", "a1" as AssetId, 70, 74);
    project.items[heart.id] = heart;
    const a = createNode("image", "A", { itemId: heart.id, x: 0, y: 0 });
    const b = createNode("image", "B", { itemId: heart.id, x: 0, y: 500 });
    for (const n of [a, b]) sym.nodes[n.id] = n;
    sym.layers = [a, b].map((n, i) => createLayer(n.id, n.name, i));
    const anim = sym.animations[0]!;
    anim.duration = 40;
    for (const n of [a, b]) {
      anim.tracks[n.id] = {
        nodeId: n.id, endFrame: 39,
        keys: [0, 10, 20, 30].map((f) => ({
          frame: f, transform: tf(f, n.bind.y), displayIndex: 0, tween: TWEEN_LINEAR,
        })),
      };
    }
    return { project, sym, a, b, store: new Store(project) };
  }

  const at = (store: Store, id: string) =>
    store.currentAnimation!.tracks[id as never]!.keys.map((k) => [k.frame, k.displayIndex]);

  it("moves a run along the same layer, emptying the frames it left", () => {
    const { store, a } = two();
    const clip = new FrameClipboard();
    clip.dragTo(store, { nodeIds: [a.id], from: 10, to: 19 }, a.id, 25);

    // 10..19 is gone — a blank key holds the gap, since key 0 would otherwise
    // keep showing — and its one key lands at 25, over the span that held 30.
    expect(at(store, a.id)).toEqual([[0, 0], [10, -1], [20, 0], [25, 0]]);
    expect(store.currentAnimation!.tracks[a.id]!.endFrame).toBe(39);
  });

  it("moves a run to another layer, over what was there", () => {
    const { store, sym, a, b } = two();
    const clip = new FrameClipboard();
    clip.dragTo(store, { nodeIds: [a.id], from: 0, to: 10 }, b.id, 0);

    // The source starts empty now. Frames 11..19 were not moved and keep
    // what they showed — the tween from 10 towards 20 — through a key at 11.
    expect(at(store, a.id)).toEqual([[11, 0], [20, 0], [30, 0]]);
    expect(store.currentAnimation!.tracks[a.id]!.keys[0]!.transform.x).toBeCloseTo(11, 9);
    expect(evaluateSymbol(sym, store.currentAnimation, 5).byNode.get(a.id)!.visible).toBe(false);
    // B keeps its own frames outside the run and takes A's inside it.
    expect(at(store, b.id)).toEqual([[0, 0], [10, 0], [20, 0], [30, 0]]);
    expect(store.currentAnimation!.tracks[b.id]!.keys[0]!.transform.y).toBe(0);
  });

  it("copies instead of moving, and leaves the ⌘C clipboard alone", () => {
    const { store, a, b } = two();
    const clip = new FrameClipboard();
    store.selection = { ...store.selection, frames: [`${a.id}:30`] };
    clip.copy(store);

    clip.dragTo(store, { nodeIds: [a.id], from: 0, to: 10 }, b.id, 20, true);
    expect(at(store, a.id)).toEqual([[0, 0], [10, 0], [20, 0], [30, 0]]);
    expect(at(store, b.id)).toEqual([[0, 0], [10, 0], [20, 0], [30, 0]]);
    expect(store.currentAnimation!.tracks[b.id]!.keys[2]!.transform.x).toBe(0);
    expect(clip.span).toBe(1);                     // still the frame copied first
  });

  it("takes the span with it when the run reached the end", () => {
    const { store, a } = two();
    const clip = new FrameClipboard();
    // 25 is mid-span, so the copy bakes a key there; 30 follows five frames on.
    clip.dragTo(store, { nodeIds: [a.id], from: 25, to: 39 }, a.id, 5);
    expect(at(store, a.id)).toEqual([[0, 0], [5, 0], [10, 0], [20, 0]]);
    expect(store.currentAnimation!.tracks[a.id]!.endFrame).toBe(24);
  });

  it("is one undo step", () => {
    const { store, a, b } = two();
    const before = at(store, a.id);
    new FrameClipboard().dragTo(store, { nodeIds: [a.id], from: 10, to: 19 }, b.id, 0);
    store.history.undo();
    expect(at(store, a.id)).toEqual(before);
    expect(at(store, b.id)).toEqual(before);
  });
});

describe("frame clipboard, symbols inside themselves", () => {
  it("refuses to paste frames showing a symbol into that symbol", async () => {
    const { createSymbol } = await import("@/core/doc/defaults");
    const { rowsNestHost } = await import("@/app/FrameClipboard");
    const { store } = scene([{ f: 0, y: 0 }]);
    const project = store.project;
    const sym = createSymbol("S");
    project.items[sym.id] = sym;
    project.itemOrder.push(sym.id);
    const root = store.currentSymbol;
    const inst = createNode("symbol", "inst", { itemId: sym.id });
    root.nodes[inst.id] = inst;
    root.layers.push(createLayer(inst.id, "inst", 1));

    expect(rowsNestHost(project, sym.id, [inst])).toBe(true);
    expect(rowsNestHost(project, root.id, [inst])).toBe(false);

    const clip = new FrameClipboard();
    store.selection = { ...store.selection, frames: [`${inst.id}:0`] };
    expect(clip.copy(store)).toBe(1);
    const empty = createNode("empty", "slot");
    sym.nodes[empty.id] = empty;
    sym.layers.push(createLayer(empty.id, "slot", 0));
    store.openSymbol(sym.id);
    expect(clip.paste(store, empty.id, 0)).toBe(0);
    expect(Object.keys(sym.nodes)).toEqual([empty.id]);
    expect(sym.nodes[empty.id]!.itemId).toBeUndefined();
  });
});

describe("dragging frames leaves the rest alone", () => {
  it("frames after the range keep showing what they showed", () => {
    const { store, n } = scene([{ f: 0, y: 0 }, { f: 20, y: 200 }]);
    const sym = store.currentSymbol;
    const other = createNode("group", "other");
    sym.nodes[other.id] = other;
    sym.layers.push(createLayer(other.id, "other", 1));
    const y = (f: number) => evaluateSymbol(sym, store.currentAnimation, f).byNode.get(n.id)!;
    const before = [11, 15, 19].map((f) => y(f).local.y);

    new FrameClipboard().dragTo(store, { nodeIds: [n.id], from: 5, to: 10 }, other.id, 0);
    expect(y(7).visible).toBe(false);                    // moved away: empty
    [11, 15, 19].forEach((f, i) => {
      expect(y(f).visible).toBe(true);
      expect(y(f).local.y).toBeCloseTo(before[i]!, 9);
    });
  });

  it("a never-keyed layer is emptied by a move, not copied", () => {
    const { store } = scene([{ f: 0, y: 0 }]);
    const sym = store.currentSymbol;
    const img = createImageItem("img", "a1" as AssetId, 10, 10);
    store.project.items[img.id] = img;
    const art = createNode("image", "art", { itemId: img.id });
    const dest = createNode("empty", "dest");
    for (const x of [art, dest]) { sym.nodes[x.id] = x; sym.layers.push(createLayer(x.id, x.name, 2)); }
    store.currentAnimation!.duration = 24;              // as `durationFor` keeps it

    new FrameClipboard().dragTo(store, { nodeIds: [art.id], from: 0, to: 9 }, dest.id, 0);
    const pose = (f: number) => evaluateSymbol(sym, store.currentAnimation, f).byNode;
    expect(pose(3).get(art.id)!.visible).toBe(false);
    expect(pose(3).get(dest.id)!.visible).toBe(true);
    expect(pose(15).get(art.id)!.visible).toBe(true);     // outside the range: still there
  });
});

