import { describe, it, expect, beforeAll } from "vitest";
import { loadStickman, type Stickman } from "./fixtures/stickman";
import { evaluateSymbol, type Pose } from "@/core/doc/pose";
import {
  drivenBox, isDescendant, axisTips, positionAxisTips, framesAlign,
  showsPositionAxes, frameDirections, SCENE_FRAME,
} from "@/view/viewport/nodeFrame";
import { matrixOf, tf } from "@/core/math/Transform";

/**
 * The stage reference for a node that draws nothing of its own. A bone with a
 * full timeline used to put NOTHING on the stage when selected, which is what
 * `drivenBox` (the artwork it carries) and the local axes are there to fix.
 */

let f: Stickman;
let pose: Pose;

beforeAll(async () => {
  f = await loadStickman();
  const dance = f.rig.animations.find((a) => a.name === "dance")!;
  pose = evaluateSymbol(f.rig, dance, 0, "animate");
});

const area = (r: { w: number; h: number }) => r.w * r.h;

describe("drivenBox", () => {
  it("covers the whole figure for the root bone", () => {
    const box = drivenBox(f.project, pose, f.node("hips"))!;
    expect(box).not.toBeNull();
    // The hips bone points up, so its local +x spans the body: head to feet is
    // a good 300px on this rig, whichever way round the box is measured.
    expect(Math.max(box.w, box.h)).toBeGreaterThan(280);
  });

  it("narrows to the part of the rig each bone actually carries", () => {
    const hips = drivenBox(f.project, pose, f.node("hips"))!;
    const chest = drivenBox(f.project, pose, f.node("chest"))!;
    const arm = drivenBox(f.project, pose, f.node("arm_near_up"))!;
    const shin = drivenBox(f.project, pose, f.node("leg_near_shin"))!;

    expect(area(chest)).toBeLessThan(area(hips));
    expect(area(arm)).toBeLessThan(area(chest));
    // One shin plus its foot, and nothing else.
    expect(Math.max(shin.w, shin.h)).toBeLessThan(120);
  });

  it("is null for a bone that carries no artwork", () => {
    for (const name of ["foot_far_target", "foot_near_target", "hand_far_target"]) {
      expect(drivenBox(f.project, pose, f.node(name)), name).toBeNull();
    }
  });

  it("follows the node's own frame, not the world axes", () => {
    // Two frames of the dance where the hips sit at different angles: the box
    // is expressed in the bone's space, so its SIZE barely changes even though
    // the figure has rotated on the stage. An axis-aligned envelope would grow.
    const dance = f.rig.animations.find((a) => a.name === "dance")!;
    const upright = drivenBox(f.project, evaluateSymbol(f.rig, dance, 0, "animate"), f.node("hips"))!;
    const swayed = drivenBox(f.project, evaluateSymbol(f.rig, dance, 8, "animate"), f.node("hips"))!;
    expect(Math.abs(swayed.h - upright.h)).toBeLessThan(upright.h * 0.35);
  });
});

describe("isDescendant", () => {
  it("walks up the parent chain, and counts the node itself", () => {
    const hips = f.node("hips");
    expect(isDescendant(pose, hips, hips)).toBe(true);
    expect(isDescendant(pose, f.node("shin_near"), hips)).toBe(true);
    expect(isDescendant(pose, f.node("head_art"), f.node("chest"))).toBe(true);
    expect(isDescendant(pose, f.node("chest"), f.node("head"))).toBe(false);
    // A scene-space IK target hangs off nothing.
    expect(isDescendant(pose, f.node("foot_far_target"), hips)).toBe(false);
  });
});

describe("positionAxisTips", () => {
  it("points along the PARENT's axes, which is where x/y actually move", () => {
    // `head` hangs off `chest`, and the chest points up: its +y is world +x.
    // So Position y + 10 moves the head to the RIGHT — the behaviour the
    // dashed ghost axes are on the stage to explain.
    const head = f.node("head");
    const chest = f.node("chest");
    const world = pose.byNode.get(head)!.world;
    const parent = pose.byNode.get(chest)!.world;

    const { y } = positionAxisTips(world, parent, 10);
    expect(y.x - world.tx).toBeCloseTo(10, 6);
    expect(y.y - world.ty).toBeCloseTo(0, 6);

    // In the BIND pose the head's own frame coincides with the chest's — its
    // local rotation is 0 — so there the two sets of axes sit on top of each
    // other and only one is drawn. The animation then tilts the head 4.3 deg
    // at this very frame, which is exactly when the ghost axes appear.
    const setup = evaluateSymbol(f.rig, null, 0, "setup");
    expect(framesAlign(setup.byNode.get(head)!.world, setup.byNode.get(chest)!.world)).toBe(true);
    expect(framesAlign(world, parent)).toBe(false);
  });

  it("disagrees with the node's own frame on a rotated bone", () => {
    const arm = f.node("arm_far_up");
    const world = pose.byNode.get(arm)!.world;
    const parent = pose.byNode.get(f.node("chest"))!.world;
    expect(framesAlign(world, parent)).toBe(false);
  });

  it("falls back to the scene frame for a node with no parent", () => {
    const hips = pose.byNode.get(f.node("hips"))!.world;
    const identity = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    const { x, y } = positionAxisTips(hips, identity, 10);
    expect(x.x - hips.tx).toBeCloseTo(10, 6);
    expect(y.y - hips.ty).toBeCloseTo(10, 6);
    // The hips bone points up, so its own frame is a quarter turn off.
    expect(framesAlign(hips, identity)).toBe(false);
  });
});

describe("axisTips", () => {
  it("carries the node's rotation and scale", () => {
    // A bone pointing straight up at twice the scale: +x reaches up, +y right.
    const world = matrixOf(tf(100, 200, -90, -90, 2, 2));
    const { x, y } = axisTips(world, 10);
    expect(x.x).toBeCloseTo(100, 6);
    expect(x.y).toBeCloseTo(200 - 20, 6);
    expect(y.x).toBeCloseTo(100 + 20, 6);
    expect(y.y).toBeCloseTo(200, 6);
  });
});

describe("showsPositionAxes", () => {
  it("warns when the node's own frame is not the one x/y move in", () => {
    // `hips` has no parent, so its position is scene-relative — while its own
    // axes are a quarter turn off, pointing up and across.
    const hips = pose.byNode.get(f.node("hips"))!.world;
    expect(showsPositionAxes(hips, SCENE_FRAME)).toBe(true);
  });

  it("warns when the parent frame is not the screen's, even if the node agrees with it", () => {
    // The head sits square in its parent, and both are turned a quarter of a
    // circle from the stage: without the second half of the test this case —
    // the one that makes "y + 10" move something sideways — draws nothing.
    const setup = evaluateSymbol(f.rig, null, 0, "setup");
    const head = setup.byNode.get(f.node("head"))!.world;
    const chest = setup.byNode.get(f.node("chest"))!.world;
    expect(framesAlign(head, chest)).toBe(true);
    expect(showsPositionAxes(head, chest)).toBe(true);
  });

  it("stays quiet when x and y mean right and down", () => {
    expect(showsPositionAxes(SCENE_FRAME, SCENE_FRAME)).toBe(false);
  });
});

describe("frameDirections", () => {
  it("names where a turned frame's axes point", () => {
    const chest = pose.byNode.get(f.node("chest"))!.world;
    const d = frameDirections(chest)!;
    expect(d).not.toBeNull();
    expect(d.x).toBe("up");
    expect(d.y).toBe("right");
    expect(Math.round(d.rotation)).toBe(-90);
  });

  it("has nothing to say about the scene frame itself", () => {
    expect(frameDirections(SCENE_FRAME)).toBeNull();
  });
});
