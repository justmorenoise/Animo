import { describe, it, expect, beforeEach } from "vitest";
import { reseed, type AssetId } from "@/core/doc/ids";
import {
  createProject, createSymbol, createNode, createLayer, createImageItem, createAnimation,
} from "@/core/doc/defaults";
import { isSymbol } from "@/core/doc/types";
import { tf } from "@/core/math/Transform";
import { translateLocal, matrixOf } from "@/core/math/Transform";
import { TWEEN_LINEAR } from "@/core/math/easing";
import {
  childFrame, innerContext, symbolBounds, localBox, invalidateBounds, SETUP_CONTEXT,
} from "@/core/doc/pose";
import { SetPivot } from "@/core/history/commands";
import { exportSkeleton } from "@/core/export/exportSkeleton";

beforeEach(() => { reseed(); invalidateBounds(); });

/** A scene holding one instance of a symbol that itself holds one image. */
function nested() {
  const project = createProject("Nested");
  const root = project.items[project.rootSymbolId];
  if (!isSymbol(root)) throw new Error("no root");

  const img = createImageItem("art", "asset_art" as AssetId, 100, 60);
  project.items[img.id] = img;
  project.itemOrder.push(img.id);

  const inner = createSymbol("part");
  const leaf = createNode("image", "art", { itemId: img.id, x: 20, y: 10 });
  inner.nodes[leaf.id] = leaf;
  inner.layers.push(createLayer(leaf.id, "art", 0));
  project.items[inner.id] = inner;
  project.itemOrder.push(inner.id);

  const instance = createNode("symbol", "part", { itemId: inner.id, x: 300, y: 200 });
  root.nodes[instance.id] = instance;
  root.layers.push(createLayer(instance.id, "part", 0));

  return { project, root, inner, leaf, instance, img };
}

/** Where the artwork's own top-left lands, in the node's parent space. */
function artworkAt(transform: ReturnType<typeof tf>, pivot: { x: number; y: number }) {
  const m = matrixOf(transform);
  return {
    x: m.tx + m.a * -pivot.x + m.c * -pivot.y,
    y: m.ty + m.b * -pivot.x + m.d * -pivot.y,
  };
}

describe("a nested symbol's own timeline", () => {
  it("is what the stage shows, not its bind pose", () => {
    const { project, inner, leaf, instance, root } = nested();
    // Move the leaf on a keyframe only, exactly as animate mode does.
    const anim = inner.animations[0]!;
    anim.tracks[leaf.id] = {
      nodeId: leaf.id,
      keys: [{ frame: 0, transform: tf(-400, -300), displayIndex: 0, tween: TWEEN_LINEAR }],
      endFrame: 23,
    };
    // A new animation is one frame long; this fixture keys 24 of them.
    anim.duration = 24;

    const setup = childFrame(inner, SETUP_CONTEXT);
    expect(setup.animation).toBeNull();

    const playing = childFrame(inner, { animationName: "animation", frame: 5, mode: "animate" });
    expect(playing.animation).toBe(anim);
    expect(playing.frame).toBe(5);

    // The instance's box follows the keyframe, so what you can click matches
    // what the runtime draws.
    const box = localBox(project, instance.itemId, instance.pivot,
      { animationName: "animation", frame: 0, mode: "animate" })!;
    expect(box.x).toBeCloseTo(-400, 6);
    expect(box.y).toBeCloseTo(-300, 6);
    void root;
  });

  it("loops the child on its own clock", () => {
    const { inner } = nested();
    inner.animations[0]!.duration = 10;
    expect(childFrame(inner, { animationName: "animation", frame: 24, mode: "animate" }).frame).toBe(4);
    expect(childFrame(inner, { animationName: "animation", frame: -1, mode: "animate" }).frame).toBe(9);
  });

  it("matches the child's animation by name, falling back to its first", () => {
    const { inner } = nested();
    const walk = createAnimation("walk", 12);
    inner.animations.push(walk);
    expect(childFrame(inner, { animationName: "walk", frame: 0, mode: "animate" }).animation).toBe(walk);
    expect(childFrame(inner, { animationName: "nope", frame: 0, mode: "animate" }).animation)
      .toBe(inner.animations[0]);
  });

  it("hands a grandchild the CHILD's animation and frame, as the runtime does", () => {
    // Root plays "walk"; the child has no "walk", so it plays its first
    // animation, "idle", and the runtime's fadeIn passes "idle" down — not
    // "walk". `previewClient.seekChildren` recurses with the child's name too.
    const { project, root, inner } = nested();
    root.animations[0]!.name = "walk";
    inner.animations = [createAnimation("idle", 7)];
    inner.nodes = {};
    inner.layers = [];

    const leafSym = createSymbol("leaf");
    const img = Object.values(project.items).find((i) => i.kind === "image")!;
    const art = createNode("image", "art", { itemId: img.id });
    leafSym.nodes[art.id] = art;
    leafSym.layers.push(createLayer(art.id, "art", 0));
    const still = createAnimation("walk", 5);
    const moving = createAnimation("idle", 5);
    moving.tracks[art.id] = {
      nodeId: art.id, endFrame: 4,
      keys: [
        { frame: 0, transform: tf(0, 0), displayIndex: 0, tween: TWEEN_LINEAR },
        { frame: 4, transform: tf(40, 0), displayIndex: 0, tween: TWEEN_LINEAR },
      ],
    };
    leafSym.animations = [still, moving];
    project.items[leafSym.id] = leafSym;
    const leafInstance = createNode("symbol", "leaf", { itemId: leafSym.id });
    inner.nodes[leafInstance.id] = leafInstance;
    inner.layers.push(createLayer(leafInstance.id, "leaf", 0));

    // Root frame 9 -> child "idle" frame 2 -> grandchild "idle" frame 2, x = 20.
    const ctx = { animationName: "walk", frame: 9, mode: "animate" as const };
    expect(innerContext(inner, ctx)).toEqual({ animationName: "idle", frame: 2, mode: "animate" });
    expect(symbolBounds(project, inner.id, ctx).x).toBeCloseTo(20, 9);
  });

  it("measures a nested symbol from where its contents actually are", () => {
    const { project, inner, instance } = nested();
    const bounds = symbolBounds(project, inner.id);
    // The leaf sits at (20, 10) inside the symbol and is 100x60.
    expect(bounds).toMatchObject({ x: 20, y: 10, w: 100, h: 60 });

    // The instance's box keeps that offset rather than snapping to the origin.
    const box = localBox(project, instance.itemId, instance.pivot)!;
    expect(box).toMatchObject({ x: 20, y: 10, w: 100, h: 60 });
  });
});

describe("moving a transform point", () => {
  it("keeps the artwork still at the bind pose and at every keyframe", () => {
    const { project, root, instance } = nested();
    const symbolId = project.rootSymbolId;
    const anim = root.animations[0]!;
    anim.tracks[instance.id] = {
      nodeId: instance.id,
      keys: [
        { frame: 0, transform: tf(300, 200), displayIndex: 0, tween: TWEEN_LINEAR },
        { frame: 12, transform: { ...tf(500, 260), skewX: 30, skewY: 30 }, displayIndex: 0, tween: TWEEN_LINEAR },
      ],
      endFrame: 23,
    };

    const before = {
      bind: artworkAt(instance.bind, instance.pivot),
      keys: anim.tracks[instance.id]!.keys.map((k) => artworkAt(k.transform, instance.pivot)),
    };

    const cmd = new SetPivot(symbolId, new Map([[instance.id, { x: 40, y: 25 }]]));
    cmd.apply(project);

    expect(instance.pivot).toEqual({ x: 40, y: 25 });
    const afterBind = artworkAt(instance.bind, instance.pivot);
    expect(afterBind.x).toBeCloseTo(before.bind.x, 9);
    expect(afterBind.y).toBeCloseTo(before.bind.y, 9);

    anim.tracks[instance.id]!.keys.forEach((key, i) => {
      const now = artworkAt(key.transform, instance.pivot);
      expect(now.x).toBeCloseTo(before.keys[i]!.x, 9);
      expect(now.y).toBeCloseTo(before.keys[i]!.y, 9);
    });

    // The rotated keyframe moved through its OWN basis, not the bind pose's.
    expect(anim.tracks[instance.id]!.keys[1]!.transform.x).not.toBeCloseTo(
      anim.tracks[instance.id]!.keys[0]!.transform.x + 200, 3,
    );

    cmd.revert(project);
    expect(instance.pivot).toEqual({ x: 0, y: 0 });
    expect(instance.bind.x).toBeCloseTo(300, 9);
    expect(anim.tracks[instance.id]!.keys[1]!.transform.x).toBeCloseTo(500, 9);
  });

  it("sets the point outright when the artwork is not meant to stay", () => {
    const { project, instance } = nested();
    new SetPivot(project.rootSymbolId, new Map([[instance.id, { x: 10, y: 10 }]]),
      { keepArtwork: false }).apply(project);
    expect(instance.pivot).toEqual({ x: 10, y: 10 });
    expect(instance.bind.x).toBe(300);      // untouched
  });

  it("shifts a transform through its own basis", () => {
    const rotated = { ...tf(100, 50), skewX: 90, skewY: 90 };
    const out = translateLocal(tf(), rotated, 10, 0);
    // A quarter turn sends local +x to world +y.
    expect(out.x).toBeCloseTo(100, 9);
    expect(out.y).toBeCloseTo(60, 9);
  });
});

describe("exporting a symbol instance's transform point", () => {
  it("puts it on the display, where it moves the slot and not the bone", () => {
    const { project, instance } = nested();
    new SetPivot(project.rootSymbolId, new Map([[instance.id, { x: 40, y: 25 }]])).apply(project);

    const { skeleton } = exportSkeleton(project);
    const scene = skeleton.armature.find((a) => a.name === "Scene 1")!;
    const display = scene.skin[0]!.slot[0]!.display[0]!;
    expect(display).toMatchObject({ type: "armature", transform: { x: -40, y: -25 } });

    // The bone carries the compensated origin, so the artwork stays put.
    const bone = scene.bone.find((b) => b.name === "part")!;
    expect(bone.transform!.x).toBeCloseTo(340, 4);
    expect(bone.transform!.y).toBeCloseTo(225, 4);
  });

  it("writes no display transform when the point is where it started", () => {
    const { project } = nested();
    const { skeleton } = exportSkeleton(project);
    const scene = skeleton.armature.find((a) => a.name === "Scene 1")!;
    expect(scene.skin[0]!.slot[0]!.display[0]).toEqual({ name: "part", type: "armature" });
  });
});
