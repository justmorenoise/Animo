import { describe, it, expect, beforeEach } from "vitest";
import { reseed } from "@/core/doc/ids";
import { createProject, createNode, createLayer } from "@/core/doc/defaults";
import { isSymbol } from "@/core/doc/types";
import { tf } from "@/core/math/Transform";
import { TWEEN_LINEAR, TWEEN_NONE } from "@/core/math/easing";
import { isTweened } from "@/core/doc/timeline";
import { evaluateSymbol } from "@/core/doc/pose";
import { Store } from "@/app/Store";
import {
  doInsertFrames, doRemoveFrames, doConvertToKeyframes, doClearKeyframes, doMoveKeyframes,
  doInsertKeyframe, ensureTrack,
} from "@/app/TimelineOps";

beforeEach(() => reseed());

/** Two layers, one of them with a track, the way a half-animated scene looks. */
function scene() {
  const project = createProject("R");
  const sym = project.items[project.rootSymbolId];
  if (!isSymbol(sym)) throw new Error("no root");

  // Ordinary layers: a group that was never keyed has no frames of its own,
  // and the frame operations pass over it.
  const a = createNode("image", "a", { x: 0, y: 0 });
  const b = createNode("image", "b", { x: 0, y: 0 });
  sym.nodes[a.id] = a;
  sym.nodes[b.id] = b;
  sym.layers = [createLayer(a.id, "a", 0), createLayer(b.id, "b", 1)];
  sym.animations[0]!.duration = 24;
  sym.animations[0]!.tracks[a.id] = {
    nodeId: a.id,
    endFrame: 23,
    keys: [
      { frame: 0, transform: tf(0, 0), displayIndex: 0, tween: TWEEN_LINEAR },
      { frame: 10, transform: tf(0, 100), displayIndex: 0, tween: TWEEN_LINEAR },
    ],
  };
  return { store: new Store(project), a, b };
}

const keysOf = (store: Store, id: string) =>
  store.currentAnimation!.tracks[id as never]?.keys.map((k) => k.frame);

describe("frame range operations", () => {
  it("inserts a run of frames and pushes later keyframes right", () => {
    const { store, a } = scene();
    doInsertFrames(store, [a.id], 5, 3);
    expect(keysOf(store, a.id)).toEqual([0, 13]);
    expect(store.currentAnimation!.duration).toBe(27);
  });

  it("removes a run of frames, pulling later keyframes left", () => {
    const { store, a } = scene();
    doRemoveFrames(store, [a.id], 5, 3);
    expect(keysOf(store, a.id)).toEqual([0, 7]);
    expect(store.currentAnimation!.duration).toBe(21);
  });

  it("acts on every layer given, in one undo step", () => {
    const { store, a, b } = scene();
    doInsertFrames(store, [a.id, b.id], 0, 2);
    // The track-less layer gets one, so "all layers" really means all layers.
    expect(keysOf(store, b.id)).toEqual([0]);
    expect(store.currentAnimation!.duration).toBe(26);

    store.undo();
    expect(keysOf(store, a.id)).toEqual([0, 10]);
    expect(keysOf(store, b.id)).toBeUndefined();
  });

  it("shortens a layer that has never been keyed", () => {
    // The `eyes` case: a PSD-imported symbol whose layers all draw a
    // full-length span with no track behind it. Remove used to skip them and
    // silently do nothing.
    const { store, a, b } = scene();
    delete store.currentAnimation!.tracks[a.id];
    store.currentAnimation!.duration = 24;

    doRemoveFrames(store, [a.id, b.id], 4, 4);
    // Nothing is keyed anywhere, so the length IS the stored duration and no
    // pointless one-key tracks are invented for the export.
    expect(store.currentAnimation!.duration).toBe(20);
    expect(Object.keys(store.currentAnimation!.tracks)).toEqual([]);

    store.undo();
    expect(store.currentAnimation!.duration).toBe(24);
  });

  it("materialises a track-less layer when another layer is keyed", () => {
    const { store, a, b } = scene();
    doRemoveFrames(store, [b.id], 4, 4);
    // `a` still spans 24, so the animation keeps its length; `b` now has a
    // track of its own and is four frames shorter.
    expect(store.currentAnimation!.tracks[b.id]!.endFrame).toBe(19);
    expect(store.currentAnimation!.duration).toBe(24);
    void a;
  });

  it("passes over a group that was never keyed", () => {
    // A group holds no frames of its own: "Insert Frames (All Layers)" used
    // to give every group row a static keyframe for the whole animation.
    const { store, a } = scene();
    const sym = store.currentSymbol;
    const g = createNode("group", "rig", { x: 0, y: 0 });
    sym.nodes[g.id] = g;
    sym.layers.push(createLayer(g.id, "rig", 2));

    doInsertFrames(store, [a.id, g.id], 0, 2);
    expect(store.currentAnimation!.tracks[g.id]).toBeUndefined();
    doRemoveFrames(store, [a.id, g.id], 0, 2);
    expect(store.currentAnimation!.tracks[g.id]).toBeUndefined();
    doConvertToKeyframes(store, [a.id, g.id], 0, 2);
    expect(store.currentAnimation!.tracks[g.id]).toBeUndefined();

    // Aimed at the group alone, F6 still keys it: that is how a group gets
    // animated.
    doInsertKeyframe(store, 5, [g.id]);
    expect(keysOf(store, g.id)).toEqual([0, 5]);
    // Keyed, it follows the frame operations like any other row.
    doInsertFrames(store, [a.id, g.id], 0, 2);
    expect(keysOf(store, g.id)).toEqual([0, 7]);
  });

  it("gives a new keyframe no tween, so nothing animates unasked", () => {
    const { store, b } = scene();
    doInsertKeyframe(store, 20, [b.id]);
    const track = store.currentAnimation!.tracks[b.id]!;
    expect(track.keys.map((k) => k.frame)).toEqual([0, 20]);
    expect(track.keys[0]!.tween).toEqual(TWEEN_NONE);
    expect(isTweened(track, 5)).toBe(false);
  });

  it("drags the implicit keyframe of a layer that has no track yet", () => {
    // What dropping a library item on the stage leaves behind: a bind pose
    // and no track. Dragging its keyframe is how the instance starts later.
    const { store, b } = scene();
    const node = store.currentSymbol.nodes[b.id]!;
    doMoveKeyframes(store, b.id, 0, 0, 9, ensureTrack(store, node));
    const track = store.currentAnimation!.tracks[b.id]!;
    expect(track.keys.map((k) => k.frame)).toEqual([9]);
    expect(evaluateSymbol(store.currentSymbol, store.currentAnimation, 3).byNode.get(b.id)!.visible)
      .toBe(false);
  });

  it("removing across every layer does not shorten a layer that ends before the range", () => {
    const { store, a, b } = scene();
    store.currentAnimation!.tracks[b.id] = {
      nodeId: b.id, endFrame: 5,
      keys: [{ frame: 0, transform: tf(0, 0), displayIndex: 0, tween: TWEEN_LINEAR }],
    };
    doRemoveFrames(store, [a.id, b.id], 10, 3);
    expect(store.currentAnimation!.tracks[a.id]!.endFrame).toBe(20);
    expect(store.currentAnimation!.tracks[b.id]!.endFrame).toBe(5);
  });

  it("keeps the frames it did remove when a run reaches past a layer's end", () => {
    const { store, a } = scene();
    // a ends at 23; five frames from 21 can only take three.
    doRemoveFrames(store, [a.id], 21, 5);
    expect(store.currentAnimation!.tracks[a.id]!.endFrame).toBe(20);
  });

  it("converts a selection to keyframes without moving anything", () => {
    const { store, a } = scene();
    const at = (f: number) =>
      store.currentAnimation!.tracks[a.id]!.keys.find((k) => k.frame === f);
    doConvertToKeyframes(store, [a.id], 4, 6);
    expect(keysOf(store, a.id)).toEqual([0, 4, 5, 6, 10]);
    // Frame 5 sits halfway along a linear tween from 0 to 100.
    expect(at(5)!.transform.y).toBeCloseTo(50, 6);
  });

  it("clears keyframes in a range but never the frame-0 anchor", () => {
    const { store, a } = scene();
    doConvertToKeyframes(store, [a.id], 0, 3);
    doClearKeyframes(store, [a.id], 0, 3);
    expect(keysOf(store, a.id)).toEqual([0, 10]);
  });
});

describe("dragging a keyframe", () => {
  it("does not destroy a key it only passes over", () => {
    const { store, a } = scene();
    const anim = store.currentAnimation!;
    const track = anim.tracks[a.id]!;
    anim.tracks[a.id] = {
      ...track, keys: [...track.keys, { frame: 20, transform: tf(0, 200), displayIndex: 0, tween: TWEEN_LINEAR }],
    };
    const base = anim.tracks[a.id]!;

    // One drag of the key at 10: over 20, then on to 25.
    store.history.beginInteraction("timeline.move");
    for (const delta of [5, 10, 15]) doMoveKeyframes(store, a.id, 10, 10, delta, base);
    store.history.endInteraction();
    expect(keysOf(store, a.id)).toEqual([0, 20, 25]);

    store.undo();
    expect(keysOf(store, a.id)).toEqual([0, 10, 20]);
  });

  it("drops onto a key and replaces it when released there", () => {
    const { store, a } = scene();
    const anim = store.currentAnimation!;
    const track = anim.tracks[a.id]!;
    anim.tracks[a.id] = {
      ...track, keys: [...track.keys, { frame: 20, transform: tf(0, 200), displayIndex: 0, tween: TWEEN_LINEAR }],
    };
    const base = anim.tracks[a.id]!;
    doMoveKeyframes(store, a.id, 10, 10, 10, base);
    expect(keysOf(store, a.id)).toEqual([0, 20]);
    expect(store.currentAnimation!.tracks[a.id]!.keys[1]!.transform.y).toBe(100);
  });
});
