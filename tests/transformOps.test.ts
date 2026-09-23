import { describe, it, expect } from "vitest";
import { tf, matrixOf, toMatrix, shearOf, type Transform } from "@/core/math/Transform";
import { mat, matOf, mul, apply, clone } from "@/core/math/Matrix2D";
import {
  snapshotOf, moveBy, rotateAbout, scaleLocal, skewLocal, applyWorldMatrix, uniformFactor,
  movePivotKeepingArtwork, topmostSelected,
} from "@/view/tools/transformOps";
import type { NodeId } from "@/core/doc/ids";

const ID = "n1" as NodeId;
const BOX = { x: -45, y: -65, w: 90, h: 130 };

/** A root node: its world matrix is just its own transform. */
function rootSnap(t: Transform) {
  return snapshotOf(ID, t, matrixOf(t));
}

/** A child node under `parent`. */
function childSnap(local: Transform, parent: Transform) {
  const p = matrixOf(parent);
  const world = mul(mat(), p, matrixOf(local));
  return snapshotOf(ID, local, world, p);
}

/** A local box corner, in world space, under a given transform. */
function cornerWorld(t: Transform, fx: number, fy: number, parent?: Transform) {
  const local = matrixOf(t);
  const world = parent ? mul(mat(), matrixOf(parent), local) : local;
  return apply({ x: 0, y: 0 }, world, BOX.x + fx * BOX.w, BOX.y + fy * BOX.h);
}

describe("moveBy", () => {
  it("translates a root node one-for-one", () => {
    const out = moveBy(rootSnap(tf(100, 50)), 30, -20);
    expect(out.x).toBeCloseTo(130, 9);
    expect(out.y).toBeCloseTo(30, 9);
  });

  it("converts the world delta into the parent's space", () => {
    // Parent rotated 90 degrees: dragging right in world moves the child
    // DOWN in its own parent space.
    const snap = childSnap(tf(0, 0), tf(0, 0, 90, 90));
    const out = moveBy(snap, 10, 0);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(-10, 9);
  });

  it("accounts for a scaled parent", () => {
    const snap = childSnap(tf(0, 0), tf(0, 0, 0, 0, 2, 4));
    const out = moveBy(snap, 10, 8);
    expect(out.x).toBeCloseTo(5, 9);
    expect(out.y).toBeCloseTo(2, 9);
  });
});

describe("rotateAbout", () => {
  it("adds theta to both skews and leaves the scales untouched", () => {
    const src = tf(100, 100, 0, 0, 1.5, 0.5);
    const out = rotateAbout(rootSnap(src), { x: 100, y: 100 }, 30);
    expect(out.skewX).toBeCloseTo(30, 9);
    expect(out.skewY).toBeCloseTo(30, 9);
    expect(out.scaleX).toBe(1.5);
    expect(out.scaleY).toBe(0.5);
  });

  it("preserves shear exactly", () => {
    const src = tf(0, 0, 40, 10, 1.3, 0.7);      // sheared by 30 degrees
    const out = rotateAbout(rootSnap(src), { x: 0, y: 0 }, 77);
    expect(shearOf(out)).toBeCloseTo(shearOf(src), 12);
  });

  it("keeps the anchor point fixed", () => {
    const src = tf(200, 120);
    const anchor = { x: 50, y: 50 };
    const out = rotateAbout(rootSnap(src), anchor, 90);
    // (200,120) swung 90 degrees about (50,50) -> (50-70, 50+150) = (-20, 200)
    expect(out.x).toBeCloseTo(-20, 9);
    expect(out.y).toBeCloseTo(200, 9);
  });

  it("accumulates past a full turn instead of wrapping", () => {
    const out = rotateAbout(rootSnap(tf(0, 0)), { x: 0, y: 0 }, 810);
    expect(out.skewY).toBeCloseTo(810, 9);
    expect(out.skewX).toBeCloseTo(810, 9);
  });

  it("reverses direction under a mirrored parent", () => {
    const snap = childSnap(tf(0, 0), tf(0, 0, 0, 0, -1, 1));
    const out = rotateAbout(snap, { x: 0, y: 0 }, 40);
    expect(out.skewY).toBeCloseTo(-40, 9);
  });
});

describe("scaleLocal", () => {
  const anchorFrac = { fx: 0, fy: 0 };            // NW
  const handleFrac = { fx: 1, fy: 1 };            // SE

  it("scales by the pointer ratio and pins the anchor corner", () => {
    const src = tf(0, 0);
    const snap = rootSnap(src);
    const nw = cornerWorld(src, 0, 0);
    // Drag the SE corner to twice its distance from NW.
    const se = cornerWorld(src, 1, 1);
    const pointer = { x: nw.x + (se.x - nw.x) * 2, y: nw.y + (se.y - nw.y) * 2 };

    const out = scaleLocal({
      snap, box: BOX, anchor: anchorFrac, handle: handleFrac,
      pointer, uniform: false, fromCenter: false,
    });
    expect(out.scaleX).toBeCloseTo(2, 9);
    expect(out.scaleY).toBeCloseTo(2, 9);

    const nwAfter = cornerWorld(out, 0, 0);
    expect(nwAfter.x).toBeCloseTo(nw.x, 8);
    expect(nwAfter.y).toBeCloseTo(nw.y, 8);
  });

  it("pins the anchor even when the object is rotated and sheared", () => {
    const src = tf(120, -40, 55, 25, 1.4, 0.8);
    const snap = rootSnap(src);
    const nw = cornerWorld(src, 0, 0);
    const se = cornerWorld(src, 1, 1);
    const pointer = { x: nw.x + (se.x - nw.x) * 1.7, y: nw.y + (se.y - nw.y) * 0.6 };

    const out = scaleLocal({
      snap, box: BOX, anchor: anchorFrac, handle: handleFrac,
      pointer, uniform: false, fromCenter: false,
    });
    const nwAfter = cornerWorld(out, 0, 0);
    expect(nwAfter.x).toBeCloseTo(nw.x, 7);
    expect(nwAfter.y).toBeCloseTo(nw.y, 7);
    // Shear and rotation must survive a scale untouched.
    expect(out.skewX).toBeCloseTo(src.skewX, 9);
    expect(out.skewY).toBeCloseTo(src.skewY, 9);
  });

  it("an edge handle scales one axis only", () => {
    const src = tf(0, 0);
    const snap = rootSnap(src);
    const w = cornerWorld(src, 0, 0.5);
    const e = cornerWorld(src, 1, 0.5);
    const pointer = { x: w.x + (e.x - w.x) * 3, y: e.y };

    const out = scaleLocal({
      snap, box: BOX, anchor: { fx: 0, fy: 0.5 }, handle: { fx: 1, fy: 0.5 },
      pointer, uniform: false, fromCenter: false,
    });
    expect(out.scaleX).toBeCloseTo(3, 9);
    expect(out.scaleY).toBeCloseTo(1, 9);
  });

  it("never lets a scale reach zero, which would make the matrix singular", () => {
    const src = tf(0, 0);
    const snap = rootSnap(src);
    const nw = cornerWorld(src, 0, 0);
    const out = scaleLocal({
      snap, box: BOX, anchor: anchorFrac, handle: handleFrac,
      pointer: { x: nw.x, y: nw.y }, uniform: false, fromCenter: false,
    });
    expect(Math.abs(out.scaleX)).toBeGreaterThan(0);
    expect(Math.abs(out.scaleY)).toBeGreaterThan(0);
    const m = toMatrix(mat(), out);
    expect(m.a * m.d - m.b * m.c).not.toBe(0);
  });
});

describe("skewLocal", () => {
  it("dragging a horizontal edge changes only scaleY and skewX", () => {
    const src = tf(0, 0, 0, 0, 1.5, 0.8);
    const snap = rootSnap(src);
    const start = cornerWorld(src, 0.5, 0);
    const out = skewLocal(snap, BOX, "n", { x: start.x + 40, y: start.y }, start);

    // Column 0 is untouched by a right-multiplied x-shear.
    expect(out.scaleX).toBeCloseTo(src.scaleX, 9);
    expect(out.skewY).toBeCloseTo(src.skewY, 9);
    // Column 1 tilts.
    expect(out.skewX).not.toBeCloseTo(src.skewX, 3);
  });

  it("dragging a vertical edge changes only scaleX and skewY", () => {
    const src = tf(0, 0, 0, 0, 1.5, 0.8);
    const snap = rootSnap(src);
    const start = cornerWorld(src, 1, 0.5);
    const out = skewLocal(snap, BOX, "e", { x: start.x, y: start.y + 40 }, start);

    expect(out.scaleY).toBeCloseTo(src.scaleY, 9);
    expect(out.skewX).toBeCloseTo(src.skewX, 9);
    expect(out.skewY).not.toBeCloseTo(src.skewY, 3);
  });

  it("pins the opposite edge", () => {
    const src = tf(30, 70, 0, 0, 1.2, 0.9);
    const snap = rootSnap(src);
    const start = cornerWorld(src, 0.5, 0);
    const before = cornerWorld(src, 0.5, 1);            // south edge midpoint
    const out = skewLocal(snap, BOX, "n", { x: start.x + 35, y: start.y }, start);
    const after = cornerWorld(out, 0.5, 1);
    expect(after.x).toBeCloseTo(before.x, 7);
    expect(after.y).toBeCloseTo(before.y, 7);
  });
});

describe("applyWorldMatrix (multi-selection)", () => {
  it("scales a child about a world anchor, whatever its parent does", () => {
    const parent = tf(200, 100, 35, 35, 1.2, 1.2);
    const local = tf(40, -30, 10, 10, 0.8, 1.4);
    const snap = childSnap(local, parent);
    const anchor = { x: 0, y: 0 };
    const s = 2;
    const m = matOf(s, 0, 0, s, anchor.x * (1 - s), anchor.y * (1 - s));

    const out = applyWorldMatrix(snap, m);

    // The resulting WORLD matrix must equal m * originalWorld.
    const expected = mul(mat(), m, clone(snap.world));
    const actual = mul(mat(), matrixOf(parent), matrixOf(out));
    for (const k of ["a", "b", "c", "d", "tx", "ty"] as const) {
      expect(actual[k]).toBeCloseTo(expected[k], 7);
    }
  });

  it("survives a non-uniform world scale on a rotated child (which does shear it)", () => {
    const local = tf(0, 0, 45, 45);
    const snap = rootSnap(local);
    const m = matOf(2, 0, 0, 0.5, 0, 0);
    const out = applyWorldMatrix(snap, m);
    const expected = mul(mat(), m, clone(snap.world));
    const actual = matrixOf(out);
    for (const k of ["a", "b", "c", "d", "tx", "ty"] as const) {
      expect(actual[k]).toBeCloseTo(expected[k], 7);
    }
    // A rotated object under a non-uniform scale genuinely acquires shear.
    expect(Math.abs(shearOf(out))).toBeGreaterThan(1);
  });
});

describe("movePivotKeepingArtwork", () => {
  /** Where the image's top-left lands in world space, given a transform and
   *  a pivot — the renderer draws at `-pivot` inside the node's local space. */
  function artworkOrigin(t: Transform, pivot: { x: number; y: number }, parent?: Transform) {
    const local = matrixOf(t);
    const world = parent ? mul(mat(), matrixOf(parent), local) : local;
    return apply({ x: 0, y: 0 }, world, -pivot.x, -pivot.y);
  }

  it("moves the point without moving the artwork (unrotated)", () => {
    const bind = tf(400, 300);
    const pivot = { x: 45, y: 65 };
    const snap = snapshotOf(ID, bind, matrixOf(bind), undefined, pivot);
    const before = artworkOrigin(bind, pivot);

    const out = movePivotKeepingArtwork(snap, { x: 0, y: 0 });
    const after = artworkOrigin(out.bind, out.pivot);

    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    // The origin itself HAS moved — that is the whole point.
    expect(out.bind.x).toBeCloseTo(355, 9);
    expect(out.bind.y).toBeCloseTo(235, 9);
  });

  it("holds the artwork still under rotation, scale and shear", () => {
    const bind = tf(120, -80, 62, 24, 1.7, 0.55);
    const pivot = { x: 45, y: 65 };
    const snap = snapshotOf(ID, bind, matrixOf(bind), undefined, pivot);
    const before = artworkOrigin(bind, pivot);

    for (const target of [{ x: 0, y: 0 }, { x: 90, y: 130 }, { x: -40, y: 200 }]) {
      const out = movePivotKeepingArtwork(snap, target);
      const after = artworkOrigin(out.bind, out.pivot);
      expect(after.x).toBeCloseTo(before.x, 7);
      expect(after.y).toBeCloseTo(before.y, 7);
      expect(out.pivot).toEqual(target);
    }
  });

  it("holds the artwork still for a child of a rotated, scaled parent", () => {
    const parent = tf(300, 200, 40, 40, 1.3, 0.8);
    const local = tf(25, -15, 12, 12, 0.9, 1.1);
    const pivot = { x: 37, y: 37 };
    const snap = childSnapWithPivot(local, parent, pivot);
    const before = artworkOrigin(local, pivot, parent);

    const out = movePivotKeepingArtwork(snap, { x: 74, y: 0 });
    const after = artworkOrigin(out.bind, out.pivot, parent);
    expect(after.x).toBeCloseTo(before.x, 7);
    expect(after.y).toBeCloseTo(before.y, 7);
  });

  it("is idempotent from a snapshot, so a drag cannot accumulate drift", () => {
    const bind = tf(50, 50, 30, 10, 1.4, 0.6);
    const pivot = { x: 20, y: 20 };
    const snap = snapshotOf(ID, bind, matrixOf(bind), undefined, pivot);
    const before = artworkOrigin(bind, pivot);

    // Replaying every intermediate pointer position against the SAME snapshot
    // must always land on the same answer for the same target.
    let last = movePivotKeepingArtwork(snap, { x: 80, y: 5 });
    for (let i = 0; i < 50; i++) {
      const mid = movePivotKeepingArtwork(snap, { x: 20 + i, y: 20 - i });
      const after = artworkOrigin(mid.bind, mid.pivot);
      expect(after.x).toBeCloseTo(before.x, 7);
      expect(after.y).toBeCloseTo(before.y, 7);
      last = movePivotKeepingArtwork(snap, { x: 80, y: 5 });
    }
    expect(last.bind.x).toBeCloseTo(
      movePivotKeepingArtwork(snap, { x: 80, y: 5 }).bind.x, 12,
    );
  });

  function childSnapWithPivot(local: Transform, parent: Transform, pivot: { x: number; y: number }) {
    const p = matrixOf(parent);
    const world = mul(mat(), p, matrixOf(local));
    return snapshotOf(ID, local, world, p, pivot);
  }
});

describe("SetParent preserves the world transform", () => {
  it("keeps a node visually in place when it gains a parent", async () => {
    const { createProject, createNode, createLayer } = await import("@/core/doc/defaults");
    const { SetParent } = await import("@/core/history/commands");
    const { evaluateSymbol } = await import("@/core/doc/pose");
    const { reseed } = await import("@/core/doc/ids");
    const { isSymbol } = await import("@/core/doc/types");
    reseed();

    const project = createProject("P");
    const sym = project.items[project.rootSymbolId];
    if (!isSymbol(sym)) throw new Error("no root");

    // A parent that is rotated, scaled AND sheared — the case where naively
    // keeping the local transform sends the child somewhere else entirely.
    const parent = createNode("group", "parent", { x: 400, y: 300 });
    parent.bind = tf(400, 300, 55, 25, 1.6, 0.7);
    const child = createNode("group", "child", { x: 120, y: 90 });
    sym.nodes[parent.id] = parent;
    sym.nodes[child.id] = child;
    sym.layers = [createLayer(child.id, "child", 0), createLayer(parent.id, "parent", 1)];

    const before = evaluateSymbol(sym, null, 0, "setup").byNode.get(child.id)!.world;

    const cmd = new SetParent(project.rootSymbolId, [child.id], parent.id);
    cmd.apply(project);

    const after = evaluateSymbol(sym, null, 0, "setup").byNode.get(child.id)!.world;
    for (const k of ["a", "b", "c", "d", "tx", "ty"] as const) {
      expect(after[k]).toBeCloseTo(before[k], 7);
    }
    expect(sym.nodes[child.id]!.parentId).toBe(parent.id);

    // and undo puts the local transform back exactly
    cmd.revert(project);
    expect(sym.nodes[child.id]!.parentId).toBeNull();
    const reverted = evaluateSymbol(sym, null, 0, "setup").byNode.get(child.id)!.world;
    for (const k of ["a", "b", "c", "d", "tx", "ty"] as const) {
      expect(reverted[k]).toBeCloseTo(before[k], 7);
    }
  });

  it("re-expresses existing keyframes too, not just the bind pose", async () => {
    const { createProject, createNode, createLayer } = await import("@/core/doc/defaults");
    const { SetParent } = await import("@/core/history/commands");
    const { evaluateSymbol } = await import("@/core/doc/pose");
    const { reseed } = await import("@/core/doc/ids");
    const { isSymbol } = await import("@/core/doc/types");
    const { TWEEN_LINEAR } = await import("@/core/math/easing");
    reseed();

    const project = createProject("P");
    const sym = project.items[project.rootSymbolId];
    if (!isSymbol(sym)) throw new Error("no root");

    const parent = createNode("group", "parent", {});
    parent.bind = tf(200, 100, 30, 30);
    const child = createNode("group", "child", {});
    child.bind = tf(500, 400);
    sym.nodes[parent.id] = parent;
    sym.nodes[child.id] = child;
    sym.layers = [createLayer(child.id, "child", 0), createLayer(parent.id, "parent", 1)];

    const anim = sym.animations[0]!;
    anim.tracks[child.id] = {
      nodeId: child.id,
      endFrame: 23,
      keys: [
        { frame: 0, transform: tf(500, 400), displayIndex: 0, tween: TWEEN_LINEAR },
        { frame: 12, transform: tf(600, 250, 40, 40), displayIndex: 0, tween: TWEEN_LINEAR },
      ],
    };

    const worldAt = (frame: number) =>
      evaluateSymbol(sym, anim, frame, "animate").byNode.get(child.id)!.world;
    const before = [worldAt(0), worldAt(12)];

    new SetParent(project.rootSymbolId, [child.id], parent.id).apply(project);

    const after = [worldAt(0), worldAt(12)];
    for (let i = 0; i < 2; i++) {
      for (const k of ["a", "b", "c", "d", "tx", "ty"] as const) {
        expect(after[i]![k]).toBeCloseTo(before[i]![k], 6);
      }
    }
  });
});

describe("topmostSelected", () => {
  // root > arm > hand, plus an unrelated leg.
  const parents: Record<string, string | null> = { root: null, arm: "root", hand: "arm", leg: null };
  const parentOf = (id: NodeId) => (parents[id] ?? null) as NodeId | null;
  const ids = (...xs: string[]) => xs as NodeId[];

  it("drops a node whose ancestor is also selected, since it moves with it", () => {
    expect(topmostSelected(ids("hand", "root", "leg"), parentOf)).toEqual(ids("root", "leg"));
    expect(topmostSelected(ids("arm", "hand"), parentOf)).toEqual(ids("arm"));
  });

  it("keeps siblings and unrelated nodes, in selection order", () => {
    expect(topmostSelected(ids("leg", "hand"), parentOf)).toEqual(ids("leg", "hand"));
  });

  it("survives a parent loop instead of hanging", () => {
    const loop = (id: NodeId) => (id === "a" ? "b" : "a") as NodeId;
    expect(topmostSelected(ids("a"), loop)).toEqual(ids("a"));
  });

  it("moving the kept nodes moves the whole selection by the drag, once", () => {
    const parent = tf(100, 0);
    const child = tf(50, 0);
    const [kept] = topmostSelected(ids("arm", "hand"), parentOf);
    expect(kept).toBe("arm");
    const moved = moveBy(rootSnap(parent), 10, 0);
    const childWorld = mul(mat(), matrixOf(moved), matrixOf(child));
    expect(childWorld.tx).toBeCloseTo(160, 9);
  });
});

describe("mirrored and uniform edge edits", () => {
  const sameMatrix = (a: ReturnType<typeof tf>, b: ReturnType<typeof tf>) => {
    const m = toMatrix(mat(), a), n = toMatrix(mat(), b);
    for (const k of ["a", "b", "c", "d", "tx", "ty"] as const) expect(m[k]).toBeCloseTo(n[k], 9);
  };

  it.each([
    ["e", tf(0, 0, 10, 10, -1, 1), 1, 0.5],     // flipped horizontally, side handle
    ["w", tf(0, 0, 10, 10, -1.5, 0.8), 0, 0.5],
    ["n", tf(0, 0, 0, 0, 1, -2), 0.5, 0],       // flipped vertically, top handle
    ["s", tf(0, 0, 20, 20, 0.5, -1), 0.5, 1],
  ] as const)("a skew drag of zero on the %s edge of a mirrored node changes nothing", (edge, src, fx, fy) => {
    const snap = rootSnap(src);
    const start = cornerWorld(src, fx, fy);
    sameMatrix(skewLocal(snap, BOX, edge, start, start), src);
  });

  it("a small skew on a mirrored node keeps it mirrored", () => {
    const src = tf(0, 0, 0, 0, -1, 1);
    const snap = rootSnap(src);
    const start = cornerWorld(src, 1, 0.5);
    const out = skewLocal(snap, BOX, "e", { x: start.x, y: start.y + 5 }, start);
    const m = toMatrix(mat(), out);
    expect(m.a).toBeLessThan(0);                 // column 0 still points left
  });

  it.each([
    [1, 0.5, false, true, 0.5],    // ⇧ on a top/bottom edge can shrink
    [0.4, 1, true, false, 0.4],    // and on a side edge
    [0.5, 2, true, true, 2],       // a corner takes the larger change
    [-3, 2, true, true, 3],
  ])("uniformFactor(%f, %f, %s, %s) = %f", (sx, sy, x, y, want) => {
    expect(uniformFactor(sx, sy, x, y)).toBe(want);
  });

  it("⇧ on an edge handle shrinks the object", () => {
    const src = tf(0, 0, 0, 0, 1, 1);
    const snap = rootSnap(src);
    const out = scaleLocal({
      snap, box: BOX, anchor: { fx: 0.5, fy: 0 }, handle: { fx: 0.5, fy: 1 },
      pointer: cornerWorld(src, 0.5, 0.5), uniform: true, fromCenter: false,
    });
    expect(out.scaleY).toBeCloseTo(0.5, 9);
  });
});

describe("bone lengths measured on the stage", () => {
  it("divides by the bone's world x-scale", async () => {
    const { localLength } = await import("@/view/tools/boneGeom");
    expect(localLength(100, matOf(2, 0, 0, 2, 5, 5))).toBeCloseTo(50, 9);
    expect(localLength(100, matOf(0, 3, -1, 0, 0, 0))).toBeCloseTo(100 / 3, 9);
    expect(localLength(100, matOf(1, 0, 0, 1, 0, 0))).toBe(100);
  });

  it("skips bones the filter refuses", async () => {
    const { pickBoneTip, boneSegment } = await import("@/view/tools/boneGeom");
    const { createSymbol, createNode, createLayer } = await import("@/core/doc/defaults");
    const { evaluateSymbol } = await import("@/core/doc/pose");
    const sym = createSymbol("s");
    const bone = createNode("bone", "b", { x: 10, y: 10 });
    sym.nodes[bone.id] = bone;
    sym.layers.push(createLayer(bone.id, "b", 0));
    const pose = evaluateSymbol(sym, null, 0, "setup");
    const tip = boneSegment(pose.byNode.get(bone.id)!);
    const at = { x: tip.bx, y: tip.by };
    expect(pickBoneTip(pose, at, 4)).toBe(bone.id);
    expect(pickBoneTip(pose, at, 4, () => false)).toBeNull();
  });
});
