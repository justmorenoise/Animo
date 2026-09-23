import { describe, it, expect, beforeEach } from "vitest";
import { reseed } from "@/core/doc/ids";
import { createProject, createNode, createLayer } from "@/core/doc/defaults";
import { isSymbol } from "@/core/doc/types";
import { tf } from "@/core/math/Transform";
import { Store } from "@/app/Store";
import { applyTransforms, doInsertFrame } from "@/app/TimelineOps";
import { TWEEN_LINEAR } from "@/core/math/easing";
import { SetBoneLength } from "@/core/history/ikCommands";
import {
  SetBindTransform, SetBindColor,
  SetPivot, SetDocumentSettings, SetNodeMotionBlur, SetParent, AddNode,
} from "@/core/history/commands";
import { SetAnimationDuration, EditTracks } from "@/core/history/timelineCommands";

beforeEach(() => reseed());

function scene() {
  const project = createProject("H");
  const sym = project.items[project.rootSymbolId];
  if (!isSymbol(sym)) throw new Error("no root");
  const n = createNode("group", "n", { x: 0, y: 0 });
  sym.nodes[n.id] = n;
  sym.layers = [createLayer(n.id, "n", 0)];
  return { store: new Store(project), n };
}

/** Where the node actually shows, whichever mode wrote it. */
function shownX(store: Store, id: string): number {
  const anim = store.currentAnimation!;
  const track = anim.tracks[id as never];
  if (track) return track.keys[0]!.transform.x;
  return store.currentSymbol.nodes[id as never]!.bind.x;
}

/** A drag: many writes between begin and end, one per pointermove. */
function drag(store: Store, id: string, steps: number[]): void {
  store.history.beginInteraction("node.transform");
  for (const x of steps) {
    applyTransforms(store, new Map([[id as never, tf(x, 0)]]), true);
  }
  store.history.endInteraction();
}

describe("history", () => {
  it("folds a drag into one undo step in animate mode", () => {
    const { store, n } = scene();
    store.setUi({ mode: "animate" });
    const steps = Array.from({ length: 25 }, (_, i) => (i + 1) * 4);

    drag(store, n.id, steps);
    expect(shownX(store, n.id)).toBe(100);
    // One entry, not one per pointermove — the bug this guards was a mode
    // mismatch: the tool opens "node.transform", animate mode emits
    // "timeline.transform".
    expect(store.history.entries.length).toBe(1);

    store.undo();
    expect(shownX(store, n.id)).toBe(0);
  });

  it("folds a drag into one undo step in setup mode too", () => {
    const { store, n } = scene();
    store.setUi({ mode: "setup" });
    drag(store, n.id, [10, 20, 30]);
    expect(store.history.entries.length).toBe(1);
    store.undo();
    expect(shownX(store, n.id)).toBe(0);
  });

  it("travels to any point and back", () => {
    const { store, n } = scene();
    store.setUi({ mode: "animate" });
    for (const x of [10, 20, 30]) drag(store, n.id, [x]);

    expect(store.history.entries.length).toBe(3);
    expect(store.history.position).toBe(3);

    store.goToHistory(1);
    expect(shownX(store, n.id)).toBe(10);
    // The steps ahead stay in the list, replayable.
    expect(store.history.entries.length).toBe(3);

    store.goToHistory(3);
    expect(shownX(store, n.id)).toBe(30);

    store.goToHistory(0);
    expect(shownX(store, n.id)).toBe(0);
    expect(store.history.reachesStart).toBe(true);
  });

  it("reverts to the document as opened", () => {
    const { store, n } = scene();
    store.setUi({ mode: "animate" });
    for (const x of [10, 20, 30]) drag(store, n.id, [x]);
    store.revertToOpened();
    expect(shownX(store, n.id)).toBe(0);
  });

  it("keeps at least twenty steps whatever the byte budget says", () => {
    const { store, n } = scene();
    store.setUi({ mode: "animate" });
    // A budget of zero would otherwise trim the list to nothing.
    (store.history as unknown as { opts: { maxBytes: number } }).opts.maxBytes = 0;
    for (let i = 1; i <= 30; i++) drag(store, n.id, [i]);
    expect(store.history.entries.length).toBe(20);
    expect(store.history.reachesStart).toBe(false);
  });
});

/* ── Undo has to be exact ────────────────────────────────────────────────
   Commands record a minimal inverse, which is only correct if nothing else
   reaches the objects they restore: frame operations share keyframe
   transforms between the old track and the new one, and several commands
   normalise mask links as a side effect.                                  */

describe("undo is exact", () => {
  function keyed() {
    const { store, n } = scene();
    store.currentAnimation!.tracks[n.id] = {
      nodeId: n.id, endFrame: 23,
      keys: [
        { frame: 0, transform: tf(0, 0), displayIndex: 0, tween: TWEEN_LINEAR },
        { frame: 10, transform: tf(100, 0), displayIndex: 0, tween: TWEEN_LINEAR },
      ],
    };
    return { store, n };
  }
  const xs = (store: Store, id: string) =>
    store.currentAnimation!.tracks[id as never]!.keys.map((k) => [k.frame, k.transform.x]);

  it("moving a transform point does not reach keys an earlier step still holds", () => {
    const { store, n } = keyed();
    doInsertFrame(store, 5, [n.id]);
    store.apply(new SetPivot(store.currentSymbolId, new Map([[n.id, { x: 7, y: 3 }]])));
    expect(xs(store, n.id)).toEqual([[0, 7], [11, 107]]);

    store.undo();
    store.undo();
    expect(xs(store, n.id)).toEqual([[0, 0], [10, 100]]);
    expect(store.currentSymbol.nodes[n.id]!.bind.x).toBe(0);

    store.redo();
    store.redo();
    expect(xs(store, n.id)).toEqual([[0, 7], [11, 107]]);
  });

  // With the document's values frozen (tests/setup.ts), a command that writes
  // into a key or a track in place throws instead of passing.
  it("reparenting a keyed node replaces its track and undoes to the same one", () => {
    const { store, n } = keyed();
    doInsertFrame(store, 5, [n.id]);
    const sym = store.currentSymbol;
    const parent = createNode("group", "p", { x: 50, y: 20 });
    store.apply(new AddNode("Add p", sym.id, parent, createLayer(parent.id, "p", 0)));
    const held = store.currentAnimation!.tracks[n.id];

    store.apply(new SetParent(sym.id, [n.id], parent.id));
    expect(xs(store, n.id)).toEqual([[0, -50], [11, 50]]);
    store.undo();
    expect(store.currentAnimation!.tracks[n.id]).toBe(held);
    store.redo();
    expect(xs(store, n.id)).toEqual([[0, -50], [11, 50]]);
  });

  it("changing the duration replaces the tracks it stretches and undoes to the same ones", () => {
    const { store, n } = keyed();
    doInsertFrame(store, 5, [n.id]);
    const anim = store.currentAnimation!;
    const held = anim.tracks[n.id];

    store.apply(new SetAnimationDuration(store.currentSymbolId, anim.id, 40));
    expect(anim.tracks[n.id]!.endFrame).toBe(39);
    store.undo();
    expect(anim.tracks[n.id]).toBe(held);
    expect(held!.endFrame).toBe(24);
  });
});

describe("a merged track edit", () => {
  it("restores a track that only a later step touched", () => {
    const { store, n } = scene();
    const sym = store.currentSymbol;
    const m = createNode("group", "m", { x: 0, y: 0 });
    sym.nodes[m.id] = m;
    sym.layers.push(createLayer(m.id, "m", 1));
    const anim = store.currentAnimation!;
    const key = (x: number) => ({ frame: 0, transform: tf(x, 0), displayIndex: 0, tween: TWEEN_LINEAR });
    const edit = (tracks: Array<[typeof n.id, number]>) => new EditTracks("drag", sym.id, anim.id,
      new Map(tracks.map(([id, x]) => [id, { nodeId: id, keys: [key(x)], endFrame: 0 }])), "timeline.transform");

    store.history.beginInteraction("node.transform");
    store.apply(edit([[n.id, 10]]));
    store.apply(edit([[n.id, 20], [m.id, 5]]));
    store.history.endInteraction();
    expect(store.history.entries).toHaveLength(1);

    store.undo();
    expect(anim.tracks[n.id]).toBeUndefined();
    expect(anim.tracks[m.id]).toBeUndefined();
    store.redo();
    expect(anim.tracks[m.id]!.keys[0]!.transform.x).toBe(5);
  });
});

describe("a scrubbed field is one undo step that redoes to where it ended", () => {
  it("document settings", () => {
    const { store } = scene();
    store.history.beginInteraction("doc.settings");
    for (const fps of [25, 26, 30]) store.apply(new SetDocumentSettings({ frameRate: fps }));
    store.history.endInteraction();
    expect(store.history.entries).toHaveLength(1);
    store.undo();
    expect(store.project.frameRate).toBe(24);
    store.redo();
    expect(store.project.frameRate).toBe(30);
  });

  it("motion blur strength", () => {
    const { store, n } = scene();
    store.history.beginInteraction("node.motionBlur");
    for (const v of [0.5, 0.25, 0]) store.apply(new SetNodeMotionBlur(store.currentSymbolId, [n.id], v));
    store.history.endInteraction();
    expect(store.history.entries).toHaveLength(1);
    store.undo();
    expect(store.currentSymbol.nodes[n.id]!.motionBlur).toBeUndefined();
    store.redo();
    expect(store.currentSymbol.nodes[n.id]!.motionBlur).toBe(0);
  });

  it("animation duration", () => {
    const { store } = scene();
    const anim = store.currentAnimation!;
    store.history.beginInteraction("anim.duration");
    for (const d of [10, 20, 40]) store.apply(new SetAnimationDuration(store.currentSymbolId, anim.id, d));
    store.history.endInteraction();
    store.undo();
    expect(anim.duration).toBe(1);
    store.redo();
    expect(anim.duration).toBe(40);
  });
});

describe("dirty tracking", () => {
  it("an edit after an undo is unsaved, whatever the stack length", () => {
    const { store, n } = scene();
    const move = (x: number) =>
      store.apply(new SetBindTransform(store.currentSymbolId, new Map([[n.id, tf(x, 0)]])));
    move(10);
    move(20);
    store.history.markSaved();
    store.undo();
    expect(store.history.isDirty).toBe(true);
    move(99);                                  // same length as when saved
    expect(store.history.isDirty).toBe(true);
    store.undo();
    expect(store.history.isDirty).toBe(true);  // the saved step is gone for good
  });

  it("revision moves on apply, merge, undo and redo", () => {
    const { store, n } = scene();
    const r0 = store.history.revision;
    store.history.beginInteraction("node.transform");
    store.apply(new SetBindTransform(store.currentSymbolId, new Map([[n.id, tf(1, 0)]])));
    const r1 = store.history.revision;
    store.apply(new SetBindTransform(store.currentSymbolId, new Map([[n.id, tf(2, 0)]])));
    store.history.endInteraction();
    const r2 = store.history.revision;
    store.undo();
    const r3 = store.history.revision;
    store.redo();
    expect(new Set([r0, r1, r2, r3, store.history.revision]).size).toBe(5);
  });
});

describe("merged steps restore every node they touched", () => {
  function two() {
    const { store, n } = scene();
    const sym = store.currentSymbol;
    const m = createNode("bone", "m", { x: 5, y: 5 });
    sym.nodes[m.id] = m;
    sym.layers.push(createLayer(m.id, "m", 1));
    const b = sym.nodes[n.id]!;
    b.kind = "bone";
    b.boneLength = 40;
    return { store, n, m };
  }

  it("SetBindTransform: a node only the second step moved goes back on undo", () => {
    const { store, n, m } = two();
    const id = store.currentSymbolId;
    store.history.beginInteraction("x");
    store.apply(new SetBindTransform(id, new Map([[n.id, tf(10, 0)]])));
    store.apply(new SetBindTransform(id, new Map([[n.id, tf(20, 0)], [m.id, tf(50, 50)]])));
    store.history.endInteraction();
    store.undo();
    expect(store.currentSymbol.nodes[n.id]!.bind.x).toBe(0);
    expect(store.currentSymbol.nodes[m.id]!.bind.x).toBe(5);
    store.redo();
    expect(store.currentSymbol.nodes[m.id]!.bind.x).toBe(50);
  });

  it("SetBindColor: same rule", () => {
    const { store, n, m } = two();
    const id = store.currentSymbolId;
    const tint = { aM: 50, rM: 100, gM: 100, bM: 100, aO: 0, rO: 0, gO: 0, bO: 0 };
    store.history.beginInteraction("c");
    store.apply(new SetBindColor(id, new Map([[n.id, tint]])));
    store.apply(new SetBindColor(id, new Map([[n.id, tint], [m.id, tint]])));
    store.history.endInteraction();
    store.undo();
    expect(store.currentSymbol.nodes[m.id]!.color).toBeUndefined();
  });

  it("SetBoneLength: same rule, and the caller's map is left alone", () => {
    const { store, n, m } = two();
    const id = store.currentSymbolId;
    const first = new Map([[n.id, 60]]);
    store.history.beginInteraction("l");
    store.apply(new SetBoneLength(id, first));
    store.apply(new SetBoneLength(id, new Map([[n.id, 70], [m.id, 80]])));
    store.history.endInteraction();
    expect(first.size).toBe(1);
    store.undo();
    expect(store.currentSymbol.nodes[n.id]!.boneLength).toBe(40);
    expect(store.currentSymbol.nodes[m.id]!.boneLength).toBe(40);
  });
});

describe("Set Duration", () => {
  it("keeps a layer that ends early where it ends", () => {
    const { store, n } = scene();
    const sym = store.currentSymbol;
    const m = createNode("group", "m");
    sym.nodes[m.id] = m;
    sym.layers.push(createLayer(m.id, "m", 1));
    const anim = store.currentAnimation!;
    const key = () => ({ frame: 0, transform: tf(), displayIndex: 0, tween: TWEEN_LINEAR });
    anim.tracks = {
      [n.id]: { nodeId: n.id, endFrame: 50, keys: [key()] },
      [m.id]: { nodeId: m.id, endFrame: 10, keys: [key()] },
    } as never;
    anim.duration = 51;
    store.apply(new SetAnimationDuration(store.currentSymbolId, anim.id, 60));
    expect(anim.duration).toBe(60);
    expect(anim.tracks[n.id]!.endFrame).toBe(59);
    expect(anim.tracks[m.id]!.endFrame).toBe(10);
    store.undo();
    expect(anim.duration).toBe(51);
    expect(anim.tracks[m.id]!.endFrame).toBe(10);
    store.redo();
    expect(anim.tracks[n.id]!.endFrame).toBe(59);
    expect(anim.tracks[m.id]!.endFrame).toBe(10);
  });
});

describe("transaction notifications", () => {
  it("tells listeners once, when the transaction closes, with every command's touches", () => {
    const { store, n } = scene();
    const heard: Array<{ nodes?: string[]; stage?: boolean; entries: number }> = [];
    store.history.onChange((t) => heard.push({ nodes: t.nodes, stage: t.stage, entries: store.history.canUndo ? 1 : 0 }));
    const m = createNode("group", "m", { x: 0, y: 0 });
    store.transaction("two", () => {
      store.apply(new SetBindTransform(store.currentSymbolId, new Map([[n.id, tf(5, 0)]])));
      store.apply(new AddNode("add", store.project.rootSymbolId, m, createLayer(m.id, "m", 1), 1));
      expect(heard).toHaveLength(0);
    });
    expect(heard).toHaveLength(1);
    expect(heard[0]!.nodes).toEqual(expect.arrayContaining([n.id]));
    // The entry is on the stack by the time listeners run.
    expect(heard[0]!.entries).toBe(1);
  });

  it("an empty transaction says nothing", () => {
    const { store } = scene();
    let heard = 0;
    store.history.onChange(() => heard++);
    store.transaction("none", () => {});
    expect(heard).toBe(0);
  });
});
