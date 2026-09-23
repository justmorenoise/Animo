import { describe, it, expect, beforeEach } from "vitest";
import { reseed, type AssetId } from "@/core/doc/ids";
import { createProject, createNode, createLayer, createImageItem } from "@/core/doc/defaults";
import { isSymbol } from "@/core/doc/types";
import { TWEEN_LINEAR, TWEEN_NONE } from "@/core/math/easing";
import { evaluateSymbol, invalidateBounds } from "@/core/doc/pose";
import { selectionBounds, buildGizmo, type PoseAt } from "@/view/tools/gizmo";
import { tf, toMatrix, type Transform } from "@/core/math/Transform";
import { mat, apply } from "@/core/math/Matrix2D";
import { deriveEdit, applyFrameEdit } from "@/core/math/multiEdit";
import { rotateAbout, snapshotOf, applyWorldMatrix, worldScaleMatrix } from "@/view/tools/transformOps";

const snap = (t: Transform) => snapshotOf("n" as never, t, toMatrix(mat(), t));

describe("Edit Multiple Frames — one edit, many keys", () => {
  it("a move shifts every key by the same vector", () => {
    const heights = [0, -120, 0, -60, 0];
    const keys = heights.map((y, i) => tf(i * 30, y));
    const edit = deriveEdit(keys[2]!, { ...keys[2]!, x: keys[2]!.x + 200 });
    expect(edit.kind).toBe("translate");
    const moved = keys.map((k) => applyFrameEdit(k, edit));
    moved.forEach((k, i) => {
      expect(k.x).toBe(keys[i]!.x + 200);
      expect(k.y).toBe(heights[i]);
    });
  });

  it("a rotation swings every key about the same point, shear and turns intact", () => {
    const a = tf(100, 0, 370, 360);           // sheared, past a full turn
    const b = tf(0, 100, 10, 10, 2, 1);
    const pivot = { x: 50, y: 50 };
    const after = rotateAbout(snap(a), pivot, 90);
    const edit = deriveEdit(a, after);
    expect(edit.kind).toBe("rotate");

    const ra = applyFrameEdit(a, edit);
    expect(ra.x).toBeCloseTo(after.x, 9);
    expect(ra.y).toBeCloseTo(after.y, 9);
    expect(ra.skewX).toBe(460);
    expect(ra.skewY).toBe(450);

    const rb = applyFrameEdit(b, edit);
    const expected = rotateAbout(snap(b), pivot, 90);
    expect(rb.x).toBeCloseTo(expected.x, 9);
    expect(rb.y).toBeCloseTo(expected.y, 9);
    expect(rb.skewX - rb.skewY).toBe(0);
    expect(rb.scaleX).toBe(2);
  });

  it("a scale applies the same parent-space matrix to every key", () => {
    const a = tf(10, 10);
    const b = tf(40, -20, 0, 0, -1, 1);                   // mirrored: sign must survive
    const m = worldScaleMatrix({ x: 0, y: 0 }, 2, 1.5);
    const edit = deriveEdit(a, applyWorldMatrix(snap(a), m));
    expect(edit.kind).toBe("affine");
    const rb = applyFrameEdit(b, edit);
    expect(rb.scaleX).toBeCloseTo(-2, 9);
    expect(rb.scaleY).toBeCloseTo(1.5, 9);
    const o = apply({ x: 0, y: 0 }, m, 40, -20);
    expect(rb.x).toBeCloseTo(o.x, 9);
    expect(rb.y).toBeCloseTo(o.y, 9);
  });

  it("no change is no edit", () => {
    const a = tf(3, 4, 20, 20);
    expect(deriveEdit(a, { ...a }).kind).toBe("none");
  });
});

describe("Edit Multiple Frames — the instances on stage", () => {
  beforeEach(() => { reseed(); invalidateBounds(); });

  /** One 100×60 image keyed from frame 10 on; before that the layer is not on stage. */
  function lateLayer() {
    const project = createProject("Late");
    const root = project.items[project.rootSymbolId];
    if (!isSymbol(root)) throw new Error("no root");
    const img = createImageItem("art", "asset_art" as AssetId, 100, 60);
    project.items[img.id] = img;
    const node = createNode("image", "art", { itemId: img.id });
    root.nodes[node.id] = node;
    root.layers.push(createLayer(node.id, "art", 0));
    const anim = root.animations[0]!;
    anim.duration = 20;
    anim.tracks[node.id] = {
      nodeId: node.id,
      keys: [
        { frame: 10, transform: tf(500, 0), displayIndex: 0, tween: TWEEN_LINEAR },
        { frame: 12, transform: tf(520, 0), displayIndex: 0, tween: TWEEN_NONE },
      ],
      endFrame: 19,
    };
    const at = (frame: number): PoseAt => {
      const when = { animationName: anim.name, frame, mode: "animate" as const };
      return { pose: evaluateSymbol(root, anim, frame, "animate"), when };
    };
    return { project, node, at };
  }

  it("wraps only the frames that show the layer", () => {
    const { project, node, at } = lateLayer();
    const poses = [at(11), ...[5, 6, 7, 8, 9, 10, 12].map(at)];
    const box = selectionBounds(project, poses, [node.id])!;
    expect(box.x).toBeCloseTo(500, 6);
    expect(box.w).toBeCloseTo(120, 6);
    expect(buildGizmo(project, poses, [node.id])!.single).toBeNull();
  });

  it("is one instance when only the playhead's frame shows it", () => {
    const { project, node, at } = lateLayer();
    const g = buildGizmo(project, [at(10), at(7), at(8)], [node.id])!;
    expect(g.single?.nodeId).toBe(node.id);
  });

  it("puts nothing on stage before the layer's track starts", () => {
    // Selecting a layer keyed from 7 while the playhead is at 5 used to draw
    // the bone box at the origin: an empty gizmo for a layer showing nothing.
    const { project, node, at } = lateLayer();
    expect(selectionBounds(project, [at(5)], [node.id])).toBeNull();
    expect(buildGizmo(project, [at(5)], [node.id])).toBeNull();
  });

  it("puts nothing on stage for a group or an empty layer", () => {
    // Both have nothing of their own on the stage; counting them drew a 40px
    // box at the origin — the stage's top-left corner for a new layer.
    const { project, node, at } = lateLayer();
    const root = project.items[project.rootSymbolId];
    if (!isSymbol(root)) throw new Error("no root");
    const group = createNode("group", "rig");
    const empty = createNode("empty", "Layer 2");
    for (const n of [group, empty]) {
      root.nodes[n.id] = n;
      root.layers.push(createLayer(n.id, n.name, 1));
    }
    const poses = [at(11)];
    expect(buildGizmo(project, poses, [group.id])).toBeNull();
    expect(buildGizmo(project, poses, [empty.id])).toBeNull();
    expect(selectionBounds(project, poses, [group.id, empty.id])).toBeNull();
    // With artwork in the selection the box is the artwork's, not the origin's.
    const box = selectionBounds(project, poses, [node.id, group.id])!;
    expect(box.x).toBeCloseTo(510, 6);          // where the art is at frame 11
    expect(box.w).toBeCloseTo(100, 6);
  });
});
