import { beforeEach, describe, expect, it } from "vitest";
import { type AssetId, reseed } from "@/core/doc/ids";
import { buildDbImport, type DbImageRef, longestDecreasing } from "@/core/doc/dbImport";
import { channelFrames, placed, translateChannel } from "@/core/doc/dbTimeline";
import { validateProject } from "@/core/doc/schema";
import { evaluateSymbol } from "@/core/doc/pose";
import type { Project, SymbolItem } from "@/core/doc/types";
import {
  applyTween, curveFromJson, curveToJson, easeCurveSampled, easeScalar, sampleRuntimeCurve, subTween, tweenFromFile,
} from "@/core/math/easing";
import { createProject } from "@/core/doc/defaults";
import { exportSkeleton } from "@/core/export/exportSkeleton";

beforeEach(() => reseed());

/** The ease at every whole frame of a span, as the editor plays it. */
const frames = (spec: Parameters<typeof applyTween>[0], span: number) =>
  Array.from({ length: span + 1 }, (_, k) => applyTween(spec, k / span, span));

describe("tweenFromFile: a frame's ease as the runtime reads it", () => {
  it.each([
    [{}, "none"], [{ tweenEasing: -2 }, "none"], [{ tweenEasing: 0 }, "linear"], [{ tweenEasing: -1 }, "ease"], [{ tweenEasing: 2 }, "ease"],
  ] as const)("%j is %s", (raw, kind) => expect(tweenFromFile(raw, 10).kind).toBe(kind));

  it("a frame of no length does not tween", () => expect(tweenFromFile({ tweenEasing: 0 }, 0).kind).toBe("none"));

  it("a scalar past what a document keeps becomes a curve through it", () => {
    for (const e of [-1.5, 3]) {
      const spec = tweenFromFile({ tweenEasing: e }, 10);
      expect(spec.kind).toBe("curve");
      frames(spec, 10).forEach((v, k) => expect(v).toBeCloseTo(easeScalar(k / 10, e), 3));
    }
  });

  it("a multi-segment curve Animo did not pad plays as the runtime plays it, not as drawn", () => {
    const raw = [0.2, 0, 0.3, 0.5, 0.5, 0.5, 0.7, 0.5, 0.8, 1];
    const spec = tweenFromFile({ curve: raw }, 10);
    const runtime = sampleRuntimeCurve(raw, 10);
    frames(spec, 10).forEach((v, k) => expect(v).toBeCloseTo(easeCurveSampled(k / 10, runtime), 3));
    // Animo's own (padded) curves come back as they were.
    const own = [0.1, 0.2, 0.3, 0.4, 0.5, 0.5, 0.6, 0.6, 0.7, 0.8];
    expect(tweenFromFile({ curve: curveToJson(own) }, 10)).toEqual({ kind: "curve", curve: own });
    expect(tweenFromFile({ curve: [0.4, 0, 0.6, 1] }, 10)).toEqual({ kind: "curve", curve: [0.4, 0, 0.6, 1] });
  });
});

describe("curveFromJson", () => {
  it("takes off the padding curveToJson puts on, however many times", () => {
    const c = [0.1, 0.2, 0.3, 0.4, 0.5, 0.5, 0.6, 0.6, 0.7, 0.8];
    expect(curveFromJson(curveToJson(c))).toEqual(c);
    expect(curveFromJson(curveToJson(curveToJson(c)))).toEqual(c);
    expect(curveFromJson([0.4, 0, 0.6, 1])).toEqual([0.4, 0, 0.6, 1]);
  });
});

describe("subTween", () => {
  it("passes holds and linear through, and the whole interval as it is", () => {
    expect(subTween({ kind: "none" }, 10, 2, 5)).toEqual({ kind: "none" });
    expect(subTween({ kind: "linear" }, 10, 2, 5)).toEqual({ kind: "linear" });
    expect(subTween({ kind: "ease", value: -1 }, 10, 0, 10)).toEqual({ kind: "ease", value: -1 });
  });

  it("a part of a quad in plays that part of it", () => {
    const whole = { kind: "ease" as const, value: -1 };
    const part = subTween(whole, 10, 4, 10)!;
    const a = easeScalar(0.4, -1), b = 1;
    for (let k = 0; k <= 6; k++) expect(applyTween(part, k / 6, 6)).toBeCloseTo((easeScalar((4 + k) / 10, -1) - a) / (b - a), 3);
  });

  it("a part that moves and comes back cannot be one ease", () => {
    const back = { kind: "preset" as const, family: "back" as const, dir: "out" as const };
    // Back out overshoots past 1 and returns: find a part ending where it began.
    const at = (f: number) => applyTween(back, f / 20, 20);
    const peak = Array.from({ length: 21 }, (_, f) => f).reduce((m, f) => (at(f) > at(m) ? f : m), 0);
    const from = peak - 1, to = 20;
    if (Math.abs(at(from) - at(to)) < 1e-9) expect(subTween(back, 20, from, to)).toBeNull();
    else expect(subTween(back, 20, from, to)).not.toBeNull();
  });
});

describe("placed: frames as `_parseTimeline` places them", () => {
  const at = (raw: unknown[], duration: number) => placed(raw, duration).map((f) => [f.at, f.length]);
  it.each([
    ["durations default to 1", [{}, {}, {}], 3, [[0, 1], [1, 1], [2, 1]]],
    ["the last lasts to the end, whatever it says", [{ duration: 2 }, { duration: 0 }], 10, [[0, 2], [2, 8]]],
    ["a frame of no length still takes a tick", [{ duration: 0 }, { duration: 5 }, { duration: 5 }], 10, [[0, 0], [1, 5], [6, 4]]],
    // Not the last in the list, the second keeps its own length; the third would start past the end.
    ["a frame past the end is never placed", [{ duration: 6 }, { duration: 6 }, { duration: 6 }], 10, [[0, 6], [6, 6]]],
    ["one frame does not tween", [{ duration: 5 }], 10, [[0, 0]]],
    ["the terminal frame sits at the end", [{ duration: 10 }, { duration: 0 }], 10, [[0, 10], [10, 0]]],
  ] as const)("%s", (_, raw, duration, expected) => expect(at([...raw], duration)).toEqual(expected));
});

describe("channelFrames", () => {
  const keys = (raw: unknown[], duration: number, wrap: boolean) => channelFrames(translateChannel(raw, duration, wrap)!, duration);
  it.each([
    ["a frame at the end gives the last frame shown a key", [{ duration: 10, tweenEasing: 0 }, { duration: 0, x: 1 }], 10, false, [0, 9]],
    ["a loop tweening back to its first gives it one too", [{ duration: 5 }, { duration: 5, tweenEasing: 0 }], 10, true, [0, 5, 9]],
    ["not when it holds", [{ duration: 5 }, { duration: 5 }], 10, true, [0, 5]],
    ["nor for a single frame", [{ x: 3 }], 10, true, [0]],
    ["nor when the last tweening frame is the last shown", [{ duration: 9 }, { duration: 1, tweenEasing: 0 }], 10, true, [0, 9]],
  ] as const)("%s", (_, raw, duration, wrap, expected) => expect(keys([...raw], duration, wrap)).toEqual(expected));
});

describe("longestDecreasing", () => {
  it.each([
    [[5, 4, 3], 3],
    [[2, 0, 1], 2],
    [[0, 2, 1], 2],
    [[3, 0, 2, 1], 3],
    [[], 0],
  ])("%j keeps a run of %i", (values, size) => {
    const kept = longestDecreasing(values);
    expect(kept.size).toBe(size);
    const run = values.filter((v) => kept.has(v));
    expect(run.every((v, i) => i === 0 || v < run[i - 1]!)).toBe(true);
  });
});

/* ── Whole files ───────────────────────────────────────────────────────────*/

const images = new Map<string, DbImageRef>([["hand", { assetId: "s1" as AssetId, width: 30, height: 30 }]]);
const rig = (animation: Record<string, unknown>, slot: Record<string, unknown> = {}) => buildDbImport({
  name: "x", images, skeleton: {
    version: "5.5", armature: [{
      name: "rig", bone: [{ name: "b" }], slot: [{ name: "b", parent: "b", ...slot }],
      skin: [{ slot: [{ name: "b", display: [{ name: "hand", pivot: { x: 0, y: 0 } }] }] }], animation: [animation],
    }],
  },
});
const sym = (p: Project) => p.items[p.rootSymbolId] as SymbolItem;
const entry = (p: Project, f: number) => evaluateSymbol(sym(p), sym(p).animations[0]!, f).entries[0]!;

describe("whole files read as the runtime reads them", () => {
  it("tweenEasing -2 holds", () => {
    const { project } = rig({ name: "a", duration: 10, playTimes: 1, bone: [{ name: "b", translateFrame: [{ duration: 10, tweenEasing: -2, x: 0 }, { duration: 0, x: 100 }] }] });
    expect(entry(project, 8).world.tx).toBe(0);
  });

  it("a last frame of no length before the end tweens back to the first in a loop", () => {
    const { project } = rig({ name: "a", duration: 10, playTimes: 0, bone: [{ name: "b", translateFrame: [{ duration: 5, x: 0 }, { duration: 0, tweenEasing: 0, x: 50 }] }] });
    expect(entry(project, 8).world.tx).toBeCloseTo(20);
  });

  it("a frame of no length in the middle moves the rest along a tick", () => {
    const { project } = rig({ name: "a", duration: 10, playTimes: 1, bone: [{ name: "b", translateFrame: [{ duration: 0, x: 0 }, { duration: 5, tweenEasing: 0, x: 50 }, { duration: 5, x: 100 }] }] });
    expect(entry(project, 0).world.tx).toBe(0);
    expect(entry(project, 1).world.tx).toBe(50);
    expect(entry(project, 6).world.tx).toBe(100);
  });

  it("an ease past the document's range survives saving", () => {
    const { project } = rig({ name: "a", duration: 10, playTimes: 1, bone: [{ name: "b", translateFrame: [{ duration: 6, tweenEasing: -1.5, x: 0 }, { duration: 4, x: 100 }] }] });
    const before = entry(project, 3).world.tx;
    const { project: saved } = validateProject(JSON.parse(JSON.stringify(project)));
    expect(entry(saved, 3).world.tx).toBeCloseTo(before, 3);
    expect(before).toBeCloseTo(100 * easeScalar(0.5, -1.5), 1);
  });

  it("a 5.0 slot frame list sets the plain colour where its frames name none", () => {
    const { project } = rig({ name: "a", duration: 2, slot: [{ name: "b", frame: [{ duration: 2, displayIndex: 0 }] }] }, { color: { aM: 50 } });
    expect(entry(project, 1).color.aM).toBe(100);
  });

  it("a slot behind something under its bone stays a node of its own, so the order holds", () => {
    const { project, warnings } = buildDbImport({
      name: "x", images, skeleton: {
        version: "5.5", armature: [{
          name: "rig", bone: [{ name: "arm" }, { name: "hand", parent: "arm" }],
          // "arm" behind "hand": merged, the arm would draw in front of its child.
          slot: [{ name: "arm", parent: "arm" }, { name: "hand", parent: "hand" }],
          skin: [{ slot: ["arm", "hand"].map((n) => ({ name: n, display: [{ name: "hand" }] })) }], animation: [],
        }],
      },
    });
    expect(warnings).toEqual([expect.stringMatching(/slot "arm" shares its name with a bone/)]);
    const s = sym(project);
    expect(Object.values(s.nodes).find((n) => n.name === "arm")!.kind).toBe("group");
    const order = evaluateSymbol(s, null, 0).entries.filter((e) => e.node.kind === "image").map((e) => e.node.name);
    // Back to front.
    expect(order).toEqual(["arm_2", "hand"]);
  });

  it("a slot renamed in Animo keeps its mask link", () => {
    const { project } = buildDbImport({
      name: "x", images,
      extensions: { format: "animo-extensions", extensions: { ANIMO_masks: { version: 1, masks: [{ armature: "rig", mask: "eye", targets: ["lid"] }] } } },
      skeleton: {
        version: "5.5", armature: [{
          name: "rig", bone: [{ name: "eye", length: 10 }, { name: "lid" }],
          slot: [{ name: "lid", parent: "lid" }, { name: "eye", parent: "eye" }],
          // Placed off its bone's origin, so the slot is a node of its own and needs another name.
          skin: [{ slot: [{ name: "lid", display: [{ name: "hand" }] }, { name: "eye", display: [{ name: "hand", transform: { x: 5 } }] }] }], animation: [],
        }],
      },
    });
    const s = sym(project);
    const mask = s.layers.find((l) => l.isMask)!;
    expect(s.nodes[mask.nodeId]!.name).toBe("eye_2");
    expect(s.layers.find((l) => s.nodes[l.nodeId]!.name === "lid")!.maskedBy).toBe(mask.id);
  });
});

describe("the export's canvas", () => {
  it.each([["#336699", 0x336699], ["#fff", 0xffffff], ["red", undefined]])("background %s", (bg, color) => {
    const p = createProject("x", { width: 300, height: 200, frameRate: 24, background: bg });
    const arm = exportSkeleton(p).skeleton.armature[0]!;
    expect(arm.canvas).toEqual({ x: 0, y: 0, width: 300, height: 200, ...(color === undefined ? {} : { color }) });
  });
});
