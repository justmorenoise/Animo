import { describe, it, expect } from "vitest";
import { loadFixture } from "./fixtures/realProject";
import { onionFrames, onionSpan, dragMarkers, type OnionFramesArgs } from "@/core/doc/onion";
import { isSymbol } from "@/core/doc/types";
import type { NodeId } from "@/core/doc/ids";

/**
 * Two pieces of stage state that used to be invisible to the tests: which
 * frame the ghosted context behind an edited symbol is drawn at, and which
 * neighbours the onion skin draws.
 */

describe("edit-in-place context", () => {
  /**
   * A symbol with a timeline worth remembering a frame on, opened for
   * editing, plus an instance inside it to descend into. The scene itself is
   * one frame long in this rig, so it would prove nothing about the playhead.
   */
  async function nested() {
    const f = await loadFixture();
    for (const item of Object.values(f.project.items)) {
      if (!isSymbol(item)) continue;
      if ((item.animations[0]?.duration ?? 1) <= 12) continue;
      const instance = item.layers
        .map((l) => item.nodes[l.nodeId]!)
        .find((n) => n.kind === "symbol" && n.itemId);
      if (!instance) continue;
      f.store.openSymbol(item.id);
      return { f, host: item, instance };
    }
    throw new Error("the fixture has no animated symbol holding an instance");
  }

  it("remembers the frame and animation it was descended out of", async () => {
    const { f, host, instance } = await nested();
    const anim = host.animations[0]!;
    f.store.setFrame(7);
    expect(f.store.ui.animId).toBe(anim.id);

    f.store.enterSymbol(instance.itemId!, undefined, instance.id as NodeId);

    const ctx = f.store.editContext;
    expect(ctx.at(-1)!.symbolId).toBe(host.id);
    // The ghost is drawn at the pose the user was looking at, not at frame 0
    // of the bind pose — which is what made an arm keyed on frame 0 appear
    // somewhere it has never been.
    expect(ctx.at(-1)!.frame).toBe(7);
    expect(ctx.at(-1)!.animId).toBe(anim.id);
    expect(ctx.at(-1)!.hideNode).toBe(instance.id);
    expect(ctx.at(-1)!.ghost).toBe(true);
  });

  it("puts the playhead back where it was on the way out", async () => {
    const { f, instance } = await nested();
    f.store.setFrame(11);
    f.store.enterSymbol(instance.itemId!, undefined, instance.id as NodeId);
    expect(f.store.ui.frame).toBe(0);          // the symbol's own timeline

    f.store.exitToDepth(f.store.ui.editPath.length - 2);
    expect(f.store.ui.frame).toBe(11);
  });

  it("ghosts nothing when a symbol is opened from the library", async () => {
    const f = await loadFixture();
    f.store.setFrame(5);
    f.open("body");
    expect(f.store.editContext.every((c) => !c.ghost)).toBe(true);
    expect(f.store.ui.frame).toBe(0);
  });

  it("keeps one recorded frame per level, and drops it on the way back", async () => {
    const { f, instance } = await nested();
    f.store.setFrame(3);
    f.store.enterSymbol(instance.itemId!, undefined, instance.id as NodeId);
    const inner = f.store.currentSymbol.layers
      .map((l) => f.store.currentSymbol.nodes[l.nodeId]!)
      .find((n) => n.kind === "symbol" && n.itemId);
    if (inner) {
      f.store.setFrame(2);
      f.store.enterSymbol(inner.itemId!, undefined, inner.id as NodeId);
      expect(f.store.editContext.map((c) => c.frame).slice(-2)).toEqual([3, 2]);
    }
    f.store.exitToDepth(0);
    expect(f.store.editContext).toHaveLength(0);
  });
});

describe("onion skin frames", () => {
  const prefs = { onionBefore: 2, onionAfter: 2 };
  const frames = (frame: number, max: number, extra: Partial<OnionFramesArgs> = {}) =>
    onionFrames({
      frame, span: onionSpan(frame, max, prefs, null), opacity: 0.3, falloff: 0.25, ...extra,
    });

  it("draws the neighbours, never the current frame", () => {
    const list = frames(10, 100).map((o) => o.frame);
    expect(list).not.toContain(10);
    expect(new Set(list)).toEqual(new Set([8, 9, 11, 12]));
  });

  it("fades with distance, and draws the nearest last", () => {
    const list = frames(10, 100);
    const near = list.find((o) => o.frame === 9)!;
    const far = list.find((o) => o.frame === 8)!;
    expect(near.alpha).toBeCloseTo(0.3);
    expect(far.alpha).toBeCloseTo(0.3 * 0.75);
    expect(list.at(-1)!.frame).toBe(11);
  });

  it("tells past from future", () => {
    const list = frames(10, 100);
    expect(list.filter((o) => o.side === "past").map((o) => o.frame).sort()).toEqual([8, 9]);
    expect(list.filter((o) => o.side === "future").map((o) => o.frame).sort()).toEqual([11, 12]);
  });

  it("clamps at both ends of the animation", () => {
    expect(frames(0, 100).map((o) => o.frame)).toEqual([2, 1]);
    expect(frames(100, 100).map((o) => o.frame)).toEqual([98, 99]);
    expect(frames(0, 0)).toEqual([]);
  });

  it("uses before and after independently, and an anchor over both", () => {
    expect(onionSpan(10, 100, { onionBefore: 5, onionAfter: 0 }, null)).toEqual({ start: 5, end: 10 });
    expect(onionSpan(10, 100, prefs, { start: 40, end: 30 })).toEqual({ start: 30, end: 40 });
    expect(onionSpan(10, 20, prefs, { start: 15, end: 90 })).toEqual({ start: 15, end: 20 });
  });

  it("keeps an anchored range even with the playhead outside it", () => {
    const list = onionFrames({ frame: 0, span: { start: 10, end: 12 }, opacity: 0.3, falloff: 0 });
    expect(list.map((o) => o.frame).sort()).toEqual([10, 11, 12]);
    expect(list.every((o) => o.side === "future")).toBe(true);
  });

  it("draws only keyframes when asked", () => {
    const list = frames(10, 100, { isKey: (f) => f % 2 === 0 });
    expect(list.map((o) => o.frame).sort()).toEqual([12, 8]);
    expect(list.find((o) => o.frame === 8)!.alpha).toBeCloseTo(0.3 * 0.75);
  });
});

describe("onion markers", () => {
  const base = { start: 8, end: 12 };

  it("drags one marker, never past the other", () => {
    expect(dragMarkers(base, "start", -3, 100)).toEqual({ start: 5, end: 12 });
    expect(dragMarkers(base, "end", -10, 100)).toEqual({ start: 8, end: 8 });
  });

  it("widens both sides with ⌘", () => {
    expect(dragMarkers(base, "both", 2, 100)).toEqual({ start: 6, end: 14 });
    expect(dragMarkers(base, "both", -20, 100, 10)).toEqual({ start: 10, end: 10 });
  });

  it("slides the whole range with ⇧, inside the animation", () => {
    expect(dragMarkers(base, "range", 5, 100)).toEqual({ start: 13, end: 17 });
    expect(dragMarkers(base, "range", 500, 100)).toEqual({ start: 96, end: 100 });
    expect(dragMarkers(base, "range", -50, 100)).toEqual({ start: 0, end: 4 });
  });

  it("keeps a following range around the playhead", () => {
    expect(dragMarkers(base, "range", 5, 100, 10)).toEqual({ start: 10, end: 14 });
    expect(dragMarkers(base, "start", 5, 100, 10)).toEqual({ start: 10, end: 12 });
  });
});
