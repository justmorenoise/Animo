import { describe, it, expect, beforeEach } from "vitest";
import { reseed } from "@/core/doc/ids";
import { createProject, createNode, createLayer } from "@/core/doc/defaults";
import { isSymbol } from "@/core/doc/types";
import { tf } from "@/core/math/Transform";
import { TWEEN_LINEAR } from "@/core/math/easing";
import { Store } from "@/app/Store";
import { MAX_FRAMES, clampFrame } from "@/core/doc/timeline";
import { doInsertFrames, doInsertKeyframe, doRemoveFrames } from "@/app/TimelineOps";
import { RemoveNodes } from "@/core/history/commands";

beforeEach(() => reseed());

/** One layer, optionally keyed — the difference the "empty animation" rule
 *  in `stretchEmptyAnimation` turns on. */
function scene(keyed: boolean) {
  const project = createProject("R");
  const sym = project.items[project.rootSymbolId];
  if (!isSymbol(sym)) throw new Error("no root");

  const a = createNode("group", "a", { x: 0, y: 0 });
  sym.nodes[a.id] = a;
  sym.layers = [createLayer(a.id, "a", 0)];
  sym.animations[0]!.duration = 16;
  if (keyed) {
    sym.animations[0]!.tracks[a.id] = {
      nodeId: a.id,
      endFrame: 15,
      keys: [{ frame: 0, transform: tf(0, 0), displayIndex: 0, tween: TWEEN_LINEAR }],
    };
  }
  return { store: new Store(project), a };
}

describe("the playhead reaches past the end of the animation", () => {
  it("parks on an empty frame instead of snapping back to the last one", () => {
    const { store } = scene(true);
    expect(store.maxFrame).toBe(15);
    store.setFrame(400);
    expect(store.ui.frame).toBe(400);
  });

  it("stops at the timeline's own limit", () => {
    const { store } = scene(true);
    store.setFrame(MAX_FRAMES + 500);
    expect(store.ui.frame).toBe(MAX_FRAMES - 1);
    store.setFrame(-3);
    expect(store.ui.frame).toBe(0);
    expect(clampFrame(1e9)).toBe(MAX_FRAMES - 1);
  });
});

describe("frame operations out past the end", () => {
  it("F5 there stretches a track-less animation to that frame", () => {
    const { store } = scene(false);
    doInsertFrames(store, [], 99, 1);
    expect(store.currentAnimation!.duration).toBe(100);
    expect(store.currentAnimation!.tracks).toEqual({});
  });

  it("F5 there extends a keyed layer's span to that frame", () => {
    const { store, a } = scene(true);
    doInsertFrames(store, [a.id], 99, 1);
    expect(store.currentAnimation!.tracks[a.id]!.endFrame).toBe(99);
    expect(store.currentAnimation!.duration).toBe(100);
  });

  it("F5 there inserts the whole run, not just one frame", () => {
    const { store, a } = scene(true);
    doInsertFrames(store, [a.id], 40, 5);
    expect(store.currentAnimation!.tracks[a.id]!.endFrame).toBe(44);
  });

  it("F6 there keys the frame and carries the span out to it", () => {
    const { store, a } = scene(true);
    doInsertKeyframe(store, 60, [a.id]);
    const track = store.currentAnimation!.tracks[a.id]!;
    expect(track.keys.map((k) => k.frame)).toEqual([0, 60]);
    expect(track.endFrame).toBe(60);
  });

  it("removing frames out there has nothing to remove", () => {
    const { store } = scene(false);
    doRemoveFrames(store, [], 99, 1);
    expect(store.currentAnimation!.duration).toBe(16);
  });
});

describe("deleting a layer", () => {
  it("shortens the animation to what is left, and undo restores it", () => {
    const { store, a } = scene(true);
    doInsertFrames(store, [a.id], 0, 40);
    expect(store.currentAnimation!.duration).toBe(56);

    store.apply(new RemoveNodes(store.currentSymbolId, [a.id]));
    // Nothing is keyed any more, so the stored length stands — but the track
    // that claimed those frames is gone.
    expect(store.currentAnimation!.tracks[a.id]).toBeUndefined();

    store.history.undo();
    expect(store.currentAnimation!.duration).toBe(56);
    expect(store.currentAnimation!.tracks[a.id]!.endFrame).toBe(55);
  });

  it("collapses to the longest surviving track", () => {
    const project = createProject("R");
    const sym = project.items[project.rootSymbolId];
    if (!isSymbol(sym)) throw new Error("no root");
    const a = createNode("group", "a", { x: 0, y: 0 });
    const b = createNode("group", "b", { x: 0, y: 0 });
    sym.nodes[a.id] = a;
    sym.nodes[b.id] = b;
    sym.layers = [createLayer(a.id, "a", 0), createLayer(b.id, "b", 1)];
    const anim = sym.animations[0]!;
    anim.duration = 60;
    const key = { frame: 0, transform: tf(0, 0), displayIndex: 0, tween: TWEEN_LINEAR };
    anim.tracks[a.id] = { nodeId: a.id, endFrame: 59, keys: [key] };
    anim.tracks[b.id] = { nodeId: b.id, endFrame: 9, keys: [{ ...key }] };

    const store = new Store(project);
    store.apply(new RemoveNodes(store.currentSymbolId, [a.id]));
    expect(store.currentAnimation!.duration).toBe(10);

    store.history.undo();
    expect(store.currentAnimation!.duration).toBe(60);
  });
});
