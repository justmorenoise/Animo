import { describe, it, expect, beforeEach } from "vitest";
import { reseed, type NodeId } from "@/core/doc/ids";
import { createProject, createSymbol, createImageItem, createNode, createLayer } from "@/core/doc/defaults";
import {
  isSymbol, DEFAULT_COLOR,
  type Project, type SymbolItem, type Track, type ColorTransform,
} from "@/core/doc/types";
import { tf } from "@/core/math/Transform";
import { TWEEN_LINEAR, TWEEN_NONE } from "@/core/math/easing";
import { exportSkeleton } from "@/core/export/exportSkeleton";
import { buildBoneTimeline, buildSlotTimeline } from "@/core/export/frameSplit";
import { sampleColorRaw } from "@/core/doc/timeline";
import { evaluateSymbol } from "@/core/doc/pose";
import type { AssetId } from "@/core/doc/ids";

beforeEach(() => reseed());

/** A project with `n` images stacked on the root symbol. */
function scene(names: string[]): { project: Project; sym: SymbolItem } {
  const project = createProject("Test");
  const sym = project.items[project.rootSymbolId];
  if (!isSymbol(sym)) throw new Error("no root");

  names.forEach((name, i) => {
    const item = createImageItem(name, `asset_${name}` as AssetId, 100, 200);
    project.items[item.id] = item;
    project.itemOrder.push(item.id);
    const node = createNode("image", name, { itemId: item.id, x: 10 * i, y: 20 * i, pivotX: 50, pivotY: 100 });
    sym.nodes[node.id] = node;
    // Index 0 is the TOP layer, so unshifting puts each new one on top.
    sym.layers.unshift(createLayer(node.id, name, i));
  });
  return { project, sym };
}

describe("exportSkeleton", () => {
  it("emits slots in reverse layer order, so the top layer draws in front", () => {
    // DragonBones draws later slot[] entries in front; the UI's top layer is
    // layers[0]. Getting this backwards silently inverts every rig.
    const { project, sym } = scene(["back", "middle", "front"]);
    expect(sym.layers.map((l) => l.name)).toEqual(["front", "middle", "back"]);

    const { skeleton } = exportSkeleton(project);
    const root = skeleton.armature[skeleton.armature.length - 1]!;
    expect(root.slot.map((s) => s.name)).toEqual(["back", "middle", "front"]);
  });

  it("normalises the pivot against the untrimmed image size", () => {
    const { project } = scene(["a"]);
    const { skeleton } = exportSkeleton(project);
    const root = skeleton.armature[0]!;
    const display = root.skin[0]!.slot[0]!.display[0]!;
    // pivot 50,100 on a 100x200 image
    expect(display.pivot).toEqual({ x: 0.5, y: 0.5 });
  });

  it("writes 5.5 with a matching compatible version", () => {
    const { skeleton } = exportSkeleton(scene(["a"]).project);
    expect(skeleton.version).toBe("5.5");
    expect(skeleton.compatibleVersion).toBe("5.5");
  });

  it("renames colliding bones rather than emitting an ambiguous rig", () => {
    const { project, sym } = scene(["a"]);
    const dup = createNode("image", "a", { itemId: Object.values(project.items).find((i) => i.kind === "image")!.id });
    sym.nodes[dup.id] = dup;
    sym.layers.unshift(createLayer(dup.id, "a", 1));

    const { skeleton, diagnostics } = exportSkeleton(project);
    const root = skeleton.armature[0]!;
    expect(new Set(root.bone.map((b) => b.name)).size).toBe(root.bone.length);
    expect(diagnostics.some((d) => /called "a"/.test(d.message))).toBe(true);
  });

  it("reports symbols that contain each other instead of recursing", () => {
    const project = createProject("Cycle");
    const a = project.items[project.rootSymbolId] as SymbolItem;
    const b = createSymbol("B");
    project.items[b.id] = b;
    project.itemOrder.push(b.id);

    const inA = createNode("symbol", "b_instance", { itemId: b.id });
    a.nodes[inA.id] = inA;
    a.layers.unshift(createLayer(inA.id, "b_instance", 0));
    const inB = createNode("symbol", "a_instance", { itemId: a.id });
    b.nodes[inB.id] = inB;
    b.layers.unshift(createLayer(inB.id, "a_instance", 0));

    const { diagnostics } = exportSkeleton(project);
    expect(diagnostics.some((d) => d.severity === "error" && /contain each other/.test(d.message))).toBe(true);
  });

  it("gives nested symbols a default action, so they are not left frozen", () => {
    const project = createProject("Nested");
    const root = project.items[project.rootSymbolId] as SymbolItem;
    const child = createSymbol("Child");
    project.items[child.id] = child;
    project.itemOrder.push(child.id);
    const instance = createNode("symbol", "child_1", { itemId: child.id });
    root.nodes[instance.id] = instance;
    root.layers.unshift(createLayer(instance.id, "child_1", 0));

    const { skeleton } = exportSkeleton(project);
    const childArmature = skeleton.armature.find((a) => a.name === "Child")!;
    const rootArmature = skeleton.armature.find((a) => a.name === "Scene 1")!;
    expect(childArmature.defaultActions?.[0]?.gotoAndPlay).toBe("animation");
    expect(rootArmature.defaultActions).toBeUndefined();
    // Dependencies come before dependents.
    expect(skeleton.armature.indexOf(childArmature)).toBeLessThan(skeleton.armature.indexOf(rootArmature));
    // The instance's display points at the child armature.
    expect(rootArmature.skin[0]!.slot[0]!.display[0]).toMatchObject({ name: "Child", type: "armature" });
  });
});

describe("frameSplit", () => {
  const node = () => createNode("image", "bone", { x: 100, y: 50 });

  function track(keys: Array<{ f: number; t: ReturnType<typeof tf>; tween?: "linear" | "none"; turns?: number }>, end = 24): Track {
    return {
      nodeId: "n1" as NodeId,
      keys: keys.map((k) => ({
        frame: k.f,
        transform: k.t,
        displayIndex: 0,
        tween: k.tween === "none" ? TWEEN_NONE : TWEEN_LINEAR,
        ...(k.turns !== undefined ? { rotateTurns: k.turns } : {}),
      })),
      endFrame: end,
    };
  }

  it("emits offsets from the bind pose, not absolute values", () => {
    const n = node();                            // bind x=100, y=50
    const out = buildBoneTimeline(track([
      { f: 0, t: tf(100, 50) },
      { f: 12, t: tf(160, 50) },
    ]), n, 24)!;
    expect(out.translateFrame![0]).not.toHaveProperty("x");   // 0 offset, omitted
    expect(out.translateFrame![1]!.x).toBe(60);
  });

  it("puts the SHEAR delta in `skew`, not the raw skewX delta", () => {
    // The runtime composes skew as (skX - skY). Emitting a raw skX delta
    // looks right in the bind pose and shears progressively once animated.
    const n = node();
    n.bind = tf(0, 0, 20, 10);                   // shear 10, rotation 10
    const out = buildBoneTimeline(track([
      { f: 0, t: tf(0, 0, 20, 10) },
      { f: 10, t: tf(0, 0, 70, 40) },            // rotation 40, shear 30
    ]), n, 24)!;
    const k = out.rotateFrame![1]!;
    expect(k.rotate).toBeCloseTo(30, 6);         // skY: 40 - 10
    expect(k.skew).toBeCloseTo(20, 6);           // shear: 30 - 10
  });

  it("emits scale as a MULTIPLIER of the bind scale", () => {
    const n = node();
    n.bind = tf(0, 0, 0, 0, 2, 4);
    const out = buildBoneTimeline(track([
      { f: 0, t: tf(0, 0, 0, 0, 2, 4) },
      { f: 10, t: tf(0, 0, 0, 0, 3, 2) },
    ]), n, 24)!;
    expect(out.scaleFrame![1]!.x).toBeCloseTo(1.5, 6);
    expect(out.scaleFrame![1]!.y).toBeCloseTo(0.5, 6);
    // A multiplier of exactly 1 is the default and must be omitted.
    expect(out.scaleFrame![0]).not.toHaveProperty("x");
  });

  it("omits tweenEasing entirely for a hold, and writes 0 for linear", () => {
    const n = node();
    const held = buildBoneTimeline(track([
      { f: 0, t: tf(100, 50), tween: "none" },
      { f: 10, t: tf(200, 50), tween: "none" },
    ]), n, 24)!;
    expect(held.translateFrame![0]).not.toHaveProperty("tweenEasing");

    const linear = buildBoneTimeline(track([
      { f: 0, t: tf(100, 50) },
      { f: 10, t: tf(200, 50) },
    ]), n, 24)!;
    expect(linear.translateFrame![0]!.tweenEasing).toBe(0);
  });

  it("durations accumulate to the animation length and end with a zero frame", () => {
    const n = node();
    const out = buildBoneTimeline(track([
      { f: 0, t: tf(100, 50) },
      { f: 12, t: tf(200, 50) },
      { f: 23, t: tf(100, 50) },
    ]), n, 24)!;
    const frames = out.translateFrame!;
    const total = frames.reduce((sum, f) => sum + (f.duration ?? 1), 0);
    expect(total).toBe(24);
    expect(frames[frames.length - 1]!.duration).toBe(0);
  });

  it("returns null for a track that never leaves its bind pose", () => {
    const n = node();
    expect(buildBoneTimeline(track([
      { f: 0, t: tf(100, 50) },
      { f: 12, t: tf(100, 50) },
    ]), n, 24)).toBeNull();
  });

  it("subdivides a rotation wider than half a turn", () => {
    // The runtime reconstructs rotation by the shortest path from the
    // previous frame, so a 720-degree spin left as two frames would collapse
    // to no rotation at all.
    const n = node();
    n.bind = tf(0, 0, 0, 0);
    const out = buildBoneTimeline(track([
      { f: 0, t: tf(0, 0, 0, 0) },
      { f: 20, t: tf(0, 0, 720, 720) },
    ]), n, 24)!;
    const frames = out.rotateFrame!;
    expect(frames.length).toBeGreaterThan(3);
    for (let i = 1; i < frames.length; i++) {
      const step = Math.abs((frames[i]!.rotate ?? 0) - (frames[i - 1]!.rotate ?? 0));
      expect(step).toBeLessThanOrEqual(180);
    }
    // and it really does reach a full two turns
    expect(Math.max(...frames.map((f) => f.rotate ?? 0))).toBeCloseTo(720, 3);
  });

  it("exports a counter-clockwise tween as the long way round, subdivided", () => {
    const n = node();
    n.bind = tf(0, 0, 0, 0);
    const t = track([
      { f: 0, t: tf(0, 0, 0, 0) },
      { f: 20, t: tf(0, 0, 90, 90) },
    ]);
    t.keys[0]!.rotateDir = "ccw";
    const frames = buildBoneTimeline(t, n, 24)!.rotateFrame!;
    expect(Math.min(...frames.map((f) => f.rotate ?? 0))).toBeCloseTo(-270, 3);
    for (let i = 1; i < frames.length; i++) {
      expect(Math.abs((frames[i]!.rotate ?? 0) - (frames[i - 1]!.rotate ?? 0))).toBeLessThanOrEqual(180);
    }
  });

  it("never turns a held wide rotation into a slide", () => {
    // A hold needs no subdivision: the runtime jumps to the next key whatever
    // path it would have taken. Splitting it with linear pieces made the last
    // piece tween into the next key while the stage held.
    const n = node();
    n.bind = tf(0, 0, 0, 0);
    const frames = buildBoneTimeline(track([
      { f: 0, t: tf(0, 0, 0, 0), tween: "none" },
      { f: 10, t: tf(0, 0, 300, 300) },
    ]), n, 24)!.rotateFrame!;
    let at = 0;
    for (const f of frames) {
      if (at >= 10) break;
      expect(f).not.toHaveProperty("tweenEasing");
      expect(f.rotate ?? 0).toBe(0);
      at += f.duration ?? 1;
    }
    expect(at).toBe(10);
  });

  it("carries 'Rotate CW x N' through as extra whole turns", () => {
    const n = node();
    n.bind = tf(0, 0, 0, 0);
    const out = buildBoneTimeline(track([
      { f: 0, t: tf(0, 0, 0, 0), turns: 1 },
      { f: 20, t: tf(0, 0, 90, 90) },
    ]), n, 24)!;
    expect(Math.max(...out.rotateFrame!.map((f) => f.rotate ?? 0))).toBeCloseTo(450, 3);
  });
});

/* ── Colour and blend mode ───────────────────────────────────────────────
   The runtime parses `colorFrame` as a tweened slot timeline and `slot.color`
   as the setup pose, but `PixiSlot._updateColor` only ever reads the four
   MULTIPLIERS. These pin down both the wire shape and the warnings that keep
   an unrepresentable value from shipping silently.                        */

describe("colour", () => {
  const RED: ColorTransform = { ...DEFAULT_COLOR, rM: 100, gM: 0, bM: 0 };

  function colorTrack(keys: Array<{ f: number; c?: ColorTransform; tween?: "linear" | "none" }>): Track {
    return {
      nodeId: "n1" as NodeId,
      keys: keys.map((k) => ({
        frame: k.f,
        transform: tf(0, 0, 0, 0),
        displayIndex: 0,
        tween: k.tween === "none" ? TWEEN_NONE : TWEEN_LINEAR,
        ...(k.c ? { color: k.c } : {}),
      })),
      endFrame: 24,
    };
  }

  it("emits a colorFrame timeline with multipliers as 0..100 percentages", () => {
    const out = buildSlotTimeline(colorTrack([
      { f: 0, c: { ...DEFAULT_COLOR } },
      { f: 10, c: { ...DEFAULT_COLOR, aM: 0 } },
    ]), "slot", 24)!;
    expect(out.colorFrame).toBeDefined();
    // A neutral colour omits every channel; only the changed one is written.
    expect(out.colorFrame![0]!.color).toEqual({});
    expect(out.colorFrame![1]!.color).toEqual({ aM: 0 });
  });

  it("emits a timeline even when every authored colour is neutral", () => {
    // With a non-default slot.color in the setup pose, a keyframe that
    // deliberately returns to neutral MUST still be emitted or the runtime
    // keeps the bind tint. `sampleColorRaw` gates on the same rule.
    const out = buildSlotTimeline(colorTrack([
      { f: 0, c: { ...DEFAULT_COLOR } },
      { f: 10, c: { ...DEFAULT_COLOR } },
    ]), "slot", 24);
    expect(out?.colorFrame).toBeDefined();
  });

  it("emits nothing when no keyframe carries a colour at all", () => {
    expect(buildSlotTimeline(colorTrack([{ f: 0 }, { f: 10 }]), "slot", 24)).toBeNull();
  });

  it("tweens colour on the stage the same way the export does", () => {
    // The exporter writes colorFrame WITH tweenEasing, so a stepwise read in
    // the editor would cut where the runtime fades — the exact stage/preview
    // divergence the preview-is-ground-truth rule exists to catch.
    const t = colorTrack([
      { f: 0, c: { ...DEFAULT_COLOR } },
      { f: 10, c: { ...DEFAULT_COLOR, aM: 0 } },
    ]);
    expect(sampleColorRaw(t, 5)!.aM).toBeCloseTo(50, 6);
    expect(sampleColorRaw(t, 0)!.aM).toBeCloseTo(100, 6);
    expect(sampleColorRaw(t, 10)!.aM).toBeCloseTo(0, 6);
  });

  it("holds colour across a span with no tween", () => {
    const t = colorTrack([
      { f: 0, c: { ...DEFAULT_COLOR, aM: 40 }, tween: "none" },
      { f: 10, c: { ...DEFAULT_COLOR, aM: 0 } },
    ]);
    expect(sampleColorRaw(t, 5)!.aM).toBe(40);
  });

  it("falls back to the bind colour when the track carries none", () => {
    // No colorFrame is emitted, so the runtime keeps slot.color; the editor
    // must agree rather than showing neutral.
    expect(sampleColorRaw(colorTrack([{ f: 0 }, { f: 10 }]), 5)).toBeNull();
  });

  it("writes a non-neutral bind colour as slot.color", () => {
    const { project, sym } = scene(["a"]);
    Object.values(sym.nodes)[0]!.color = { ...RED };
    const { skeleton } = exportSkeleton(project);
    const root = skeleton.armature[skeleton.armature.length - 1]!;
    expect(root.slot[0]!.color).toEqual({ gM: 0, bM: 0 });
  });

  it("warns that colour offsets are dropped by the Pixi runtime", () => {
    // They are parsed and tweened, but _updateColor never reads them.
    const { project, sym } = scene(["a"]);
    Object.values(sym.nodes)[0]!.color = { ...DEFAULT_COLOR, rO: 120 };
    const { diagnostics } = exportSkeleton(project);
    expect(diagnostics.some((d) => /offset/i.test(d.message))).toBe(true);
  });

  it("exports a blend mode on an image slot", () => {
    const { project, sym } = scene(["a"]);
    Object.values(sym.nodes)[0]!.blendMode = "screen";
    const { skeleton } = exportSkeleton(project);
    const root = skeleton.armature[skeleton.armature.length - 1]!;
    expect(root.slot[0]!.blendMode).toBe("screen");
  });
});

/* ── Spans that do not cover the whole animation ─────────────────────────
   The stage shows nothing before a track's first key and nothing after its
   `endFrame` (`pose.localAt`). DragonBones frames are positioned by summing
   durations from 0, so a timeline that starts at its first KEY is shifted
   earlier by that many frames, and one that stops short keeps its last
   display on screen to the end of the animation.                          */

describe("partial spans", () => {
  /** Where each emitted frame starts, the way the runtime sums durations. */
  function positions(frames: Array<{ duration?: number }>): number[] {
    const out: number[] = [];
    let at = 0;
    for (const f of frames) { out.push(at); at += f.duration ?? 1; }
    return out;
  }

  /** The display index the runtime shows at `frame`. */
  function displayAt(frames: Array<{ duration?: number; value?: number }>, frame: number): number {
    const at = positions(frames);
    let value = 0;
    frames.forEach((f, i) => { if (at[i]! <= frame) value = f.value ?? 0; });
    return value;
  }

  function spanTrack(keys: number[], endFrame: number): Track {
    return {
      nodeId: "n1" as NodeId,
      keys: keys.map((f) => ({
        frame: f, transform: tf(f * 10, 0), displayIndex: 0, tween: TWEEN_LINEAR,
      })),
      endFrame,
    };
  }

  it("keeps a late track's keys on their own frames, holding the bind pose before them", () => {
    const n = createNode("image", "late");
    const frames = buildBoneTimeline(spanTrack([5, 10], 23), n, 24)!.translateFrame!;
    expect(positions(frames)).toEqual([0, 5, 10, 24]);
    expect(frames[0]).not.toHaveProperty("x");
    expect(frames[0]).not.toHaveProperty("tweenEasing");
    expect(frames[1]!.x).toBe(50);
    expect(frames[1]!.tweenEasing).toBe(0);
  });

  it("hides the slot before the first key and after the span ends, as the stage does", () => {
    const out = buildSlotTimeline(spanTrack([5, 10], 15), "late", 24)!;
    const frames = out.displayFrame!;
    for (let f = 0; f < 24; f++) {
      expect(displayAt(frames, f)).toBe(f >= 5 && f <= 15 ? 0 : -1);
    }
    const total = frames.reduce((s, f) => s + (f.duration ?? 1), 0);
    expect(total).toBe(24);
  });

  it("emits no display timeline for a track that covers the whole animation", () => {
    expect(buildSlotTimeline(spanTrack([0, 10], 23), "full", 24)).toBeNull();
  });

  it("agrees with the stage frame by frame on a layer that ends early", () => {
    const { project, sym } = scene(["short", "long"]);
    const [shortNode, longNode] = sym.layers.map((l) => sym.nodes[l.nodeId]!).reverse();
    const anim = sym.animations[0]!;
    anim.tracks[longNode!.id] = spanTrack([0], 29);
    anim.tracks[shortNode!.id] = { ...spanTrack([3], 11), nodeId: shortNode!.id };
    anim.duration = 30;

    const { skeleton } = exportSkeleton(project);
    const slotTl = skeleton.armature[0]!.animation[0]!.slot!.find((s) => s.name === "short")!;
    for (let f = 0; f < 30; f++) {
      const stage = evaluateSymbol(sym, anim, f).byNode.get(shortNode!.id)!.visible;
      expect(displayAt(slotTl.displayFrame!, f) >= 0).toBe(stage);
    }
  });
});

describe("library names the runtime looks things up by", () => {
  it("refuses two images with one name, which would share one SubTexture", () => {
    const { project } = scene(["arm", "leg"]);
    const leg = Object.values(project.items).find((i) => i.name === "leg")!;
    leg.name = "arm";
    const { diagnostics } = exportSkeleton(project);
    expect(diagnostics.some((d) => d.severity === "error" && /"arm"/.test(d.message))).toBe(true);
  });

  it("refuses two exported symbols with one name, which would share one armature", () => {
    const project = createProject("Twins");
    const root = project.items[project.rootSymbolId] as SymbolItem;
    for (const _ of [0, 1]) {
      const child = createSymbol("Part");
      project.items[child.id] = child;
      const instance = createNode("symbol", "part", { itemId: child.id });
      root.nodes[instance.id] = instance;
      root.layers.unshift(createLayer(instance.id, "part", 0));
    }
    const { diagnostics } = exportSkeleton(project);
    expect(diagnostics.some((d) => d.severity === "error" && /"Part"/.test(d.message))).toBe(true);
  });

  it("says nothing about a clash nothing on the stage uses", () => {
    const { project } = scene(["arm"]);
    const spare = createImageItem("arm", "asset_spare" as AssetId, 10, 10);
    project.items[spare.id] = spare;
    expect(exportSkeleton(project).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});
