import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EASE_FAMILIES, applyTween, curveToJson, easeFunction, easeLabel, easeOf, presetCurve,
  sampleCurve, sampleRuntimeCurve, splitTween, tweenToJson, type EaseDir, type EaseSpec,
  type TweenSpec,
} from "@/core/math/easing";
import {
  anchorsOf, constrain, curveValueAt, insertAnchor, moveAnchor, moveHandle, removeAnchor, toCorner,
} from "@/core/math/easeCurve";
import { reseed } from "@/core/doc/ids";
import { tf } from "@/core/math/Transform";
import type { Track } from "@/core/doc/types";
import { sampleTransformRaw, insertKeyframe } from "@/core/doc/timeline";
import { buildBoneTimeline } from "@/core/export/frameSplit";
import { migrate, validateProject } from "@/core/doc/schema";
import { createProject, createLayer, createNode } from "@/core/doc/defaults";

beforeEach(() => reseed());

/**
 * The runtime's own `_samplingEasingCurve` and `_getCurvePoint`, cut out of
 * the vendored build and run as they are — so the port in easing.ts is
 * checked against the bytes that ship, not against a re-reading of them.
 */
function vendoredSampler(): (curve: number[], samples: number[]) => void {
  const src = readFileSync(resolve(__dirname, "../public/vendor/dragonBones.min.js"), "utf8");
  const method = (name: string, params: string) => {
    const start = src.indexOf(`${name}(${params}){`);
    if (start < 0) throw new Error(`${name} not found in the vendored runtime`);
    let i = src.indexOf("{", start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    return src.slice(start, i + 1);
  };
  const body = `return class { constructor(){ this._helpPoint = {x:0,y:0}; } ${method("_getCurvePoint", "t,e,a,i,s,r,n,o,l,h")} ${method("_samplingEasingCurve", "n,o")} }`;
  const Cls = new Function(body)() as new () => { _samplingEasingCurve(c: number[], s: number[]): boolean };
  const inst = new Cls();
  return (curve, samples) => { inst._samplingEasingCurve(curve, samples); };
}

function runtimeTable(json: number[], frameCount: number): number[] {
  const samples = new Array<number>(frameCount + 1).fill(0);
  vendoredSampler()(json, samples);
  return samples.map((v) => (Math.round(v * 1e4) << 16) >> 16);
}

const DIRS: EaseDir[] = ["in", "out", "inOut"];

describe("the runtime's curve sampler", () => {
  it("the port matches the vendored build on a single segment", () => {
    const curve = [0.42, 0, 0.58, 1];
    expect([...sampleRuntimeCurve(curve, 12)]).toEqual(runtimeTable(curve, 12));
  });

  it("the port matches the vendored build on a padded multi-segment curve", () => {
    const json = curveToJson([0.1, 0.4, 0.2, 0.6, 0.3, 0.7, 0.45, 0.8, 0.6, 0.9]);
    for (const n of [3, 10, 47]) {
      expect([...sampleRuntimeCurve(json, n)]).toEqual(runtimeTable(json, n));
    }
  });

  it("the padding is what makes a multi-segment curve read correctly", () => {
    // Unpadded, the runtime evaluates the first segment towards (1,1) and
    // the last one from (0,0): the samples land nowhere near the curve.
    const curve = [0.1, 0.4, 0.2, 0.6, 0.3, 0.7, 0.45, 0.8, 0.6, 0.9];
    const padded = sampleRuntimeCurve(curveToJson(curve), 20);
    const n = padded.length;
    for (let i = 0; i < n; i++) {
      expect(padded[i]! / 1e4).toBeCloseTo(curveValueAt(curve, (i + 1) / (n + 1)), 2);
    }
    const raw = sampleRuntimeCurve(curve, 20);
    expect(raw.some((v, i) => Math.abs(v / 1e4 - curveValueAt(curve, (i + 1) / (n + 1))) > 0.05)).toBe(true);
  });

  it("wraps past the Int16 range exactly as the typed array does", () => {
    expect([...sampleRuntimeCurve([0.3, 5, 0.6, 5], 4)]).toEqual(runtimeTable([0.3, 5, 0.6, 5], 4));
  });
});

describe("preset eases", () => {
  it("start at 0 and end at 1 in every family and direction", () => {
    for (const fam of EASE_FAMILIES) {
      for (const dir of DIRS) {
        const f = easeFunction({ family: fam.id, dir });
        expect(f(0)).toBeCloseTo(0, 2);
        expect(f(1)).toBeCloseTo(1, 2);
      }
    }
  });

  it("bounce at the default bounciness is Penner's bounce", () => {
    const penner = (p: number) => {
      if (p < 1 / 2.75) return 7.5625 * p * p;
      if (p < 2 / 2.75) { p -= 1.5 / 2.75; return 7.5625 * p * p + 0.75; }
      if (p < 2.5 / 2.75) { p -= 2.25 / 2.75; return 7.5625 * p * p + 0.9375; }
      p -= 2.625 / 2.75; return 7.5625 * p * p + 0.984375;
    };
    const f = easeFunction({ family: "bounce", dir: "out" });
    for (let p = 0; p <= 1; p += 0.05) expect(f(p)).toBeCloseTo(penner(p), 6);
  });

  it("the runtime's table holds the ease's own values at its sample points", () => {
    for (const fam of EASE_FAMILIES) {
      for (const dir of DIRS) {
        const spec = { family: fam.id, dir };
        const f = easeFunction(spec);
        for (const n of [5, 24, 90]) {
          const table = runtimeTable(tweenToJson({ kind: "preset", ...spec }, n).curve!, n);
          table.forEach((v, i) => {
            expect(Math.abs(v / 1e4 - f((i + 1) / (n + 2)))).toBeLessThan(1.5e-3);
          });
        }
      }
    }
  });

  it("keeps y inside the Int16 range even at extreme settings", () => {
    const curve = presetCurve({ family: "back", dir: "inOut", amount: 4 }, 30);
    for (let i = 1; i < curve.length; i += 2) expect(Math.abs(curve[i]!)).toBeLessThanOrEqual(3.2767);
  });

  it("drops collinear anchors, so a flat tail costs nothing", () => {
    expect(presetCurve({ family: "pow", dir: "in", amount: 8 }, 400).length)
      .toBeLessThan(4 + 6 * 401);
    expect(tweenToJson({ kind: "linear" })).toEqual({ tweenEasing: 0 });
  });

  it("the stage evaluates a preset through the exported curve", () => {
    const spec: TweenSpec = { kind: "preset", family: "elastic", dir: "out" };
    const n = 18;
    const table = runtimeTable(tweenToJson(spec, n).curve!, n);
    for (let i = 0; i <= 50; i++) {
      const p = i / 50;
      const seg = n + 2;
      const k = Math.min(seg - 1, Math.floor(p * seg));
      const a = k === 0 ? 0 : table[k - 1]!;
      const b = k === seg - 1 ? 10000 : table[k]!;
      const expected = p >= 1 ? 1 : (a + (b - a) * (p * seg - k)) * 1e-4;
      expect(applyTween(spec, p, n)).toBeCloseTo(expected, 9);
    }
  });

  it("labels", () => {
    expect(easeLabel({ kind: "preset", family: "bounce", dir: "inOut" })).toBe("bounce in-out");
    expect(easeLabel({ kind: "curve", curve: [0.4, 0, 0.6, 1] })).toBe("custom");
    expect(easeLabel({ kind: "ease", value: -0.5 })).toBe("ease in");
  });
});

describe("cutting an eased interval", () => {
  /** The original ease at every whole frame, against the two halves joined. */
  function worstFrame(spec: EaseSpec, span: number, at: number): number {
    const [a, b] = splitTween(spec, span, at)!;
    const eu = applyTween(spec, at / span, span);
    let worst = 0;
    for (let f = 0; f <= span; f++) {
      const joined = f <= at
        ? eu * applyTween(a, f / at, at)
        : eu + (1 - eu) * applyTween(b, (f - at) / (span - at), span - at);
      worst = Math.max(worst, Math.abs(joined - applyTween(spec, f / span, span)));
    }
    return worst;
  }

  it("lands on the original ease at every frame, for every kind", () => {
    const specs: EaseSpec[] = [
      { kind: "ease", value: -1 }, { kind: "ease", value: 0.6 }, { kind: "ease", value: 2 },
      { kind: "preset", family: "back", dir: "out" }, { kind: "preset", family: "bounce", dir: "out" },
      { kind: "curve", curve: [0.1, 0.8, 0.3, 1] },
    ];
    for (const spec of specs) {
      for (const [span, at] of [[20, 5], [20, 9], [12, 3], [40, 17], [3, 1]] as const) {
        expect(worstFrame(spec, span, at), `${easeLabel(spec)} ${span}/${at}`).toBeLessThan(1e-4);
      }
    }
  });

  it("keeps a quad a scalar when the file's hundredths can carry it", () => {
    expect(splitTween({ kind: "ease", value: -1 }, 20, 5)).toEqual([
      { kind: "ease", value: -1 },
      { kind: "ease", value: -0.6 },
    ]);
    expect(splitTween({ kind: "ease", value: -1 }, 20, 9)!.map((e) => e.kind)).toEqual(["curve", "curve"]);
    expect(splitTween({ kind: "linear" }, 20, 9)).toEqual([{ kind: "linear" }, { kind: "linear" }]);
  });

  it("refuses a cut the file cannot express", () => {
    // Elastic out has already overshot 1 here: the second half would need
    // values far past the Int16 table's ±3.27.
    expect(splitTween({ kind: "preset", family: "elastic", dir: "out" }, 20, 5)).toBeNull();
    // Anticipation back to the start: no progress at all in the first half.
    expect(splitTween({ kind: "ease", value: -2 }, 2, 1)).toBeNull();
  });
});

describe("custom curve editing", () => {
  const base = [0.42, 0, 0.58, 1];

  it("inserting an anchor leaves the curve's shape unchanged", () => {
    const { curve, index } = insertAnchor(base, 0.3);
    expect(index).toBe(1);
    expect(curve.length).toBe(10);
    for (let x = 0.02; x < 1; x += 0.05) {
      expect(curveValueAt(curve, x)).toBeCloseTo(curveValueAt(base, x), 4);
    }
    expect([...sampleCurve(curve, 30)].every((v, i) => Math.abs(v - sampleCurve(base, 30)[i]!) <= 3)).toBe(true);
  });

  it("removing it goes back to one segment", () => {
    const { curve } = insertAnchor(base, 0.5);
    expect(removeAnchor(curve, 1).length).toBe(4);
    expect(removeAnchor(curve, 0)).toEqual(curve);
  });

  it("keeps anchors ordered and every segment's x monotone", () => {
    let { curve } = insertAnchor(base, 0.3);
    curve = insertAnchor(curve, 0.7).curve;
    curve = moveAnchor(curve, 1, 0.95, 2);
    curve = moveHandle(curve, 2, "in", -1, 0.5, true);
    const a = anchorsOf(curve);
    for (let i = 0; i < a.length - 1; i++) {
      expect(a[i + 1]!.x).toBeGreaterThan(a[i]!.x);
      expect(a[i]!.x).toBeLessThanOrEqual(a[i]!.outX);
      expect(a[i]!.outX).toBeLessThanOrEqual(a[i + 1]!.inX);
      expect(a[i + 1]!.inX).toBeLessThanOrEqual(a[i + 1]!.x);
    }
    expect(constrain(a)).toEqual(a);
  });

  it("a mirrored handle drags its partner round; a corner has none", () => {
    const { curve } = insertAnchor(base, 0.5);
    const moved = anchorsOf(moveHandle(curve, 1, "out", 0.7, 0.9, true))[1]!;
    const cross = (moved.outX - moved.x) * (moved.inY - moved.y) - (moved.outY - moved.y) * (moved.inX - moved.x);
    expect(cross).toBeCloseTo(0, 6);
    const corner = anchorsOf(toCorner(curve, 1))[1]!;
    expect([corner.inX, corner.inY, corner.outX, corner.outY]).toEqual([corner.x, corner.y, corner.x, corner.y]);
  });
});

describe("per-property eases", () => {
  function tweenTrack(): Track {
    return {
      nodeId: "n1" as Track["nodeId"],
      keys: [
        {
          frame: 0, transform: tf(0, 0, 0, 0, 1, 1), displayIndex: 0,
          tween: { kind: "linear" },
          eases: { rotation: { kind: "preset", family: "back", dir: "in" } },
        },
        { frame: 20, transform: tf(100, 0, 90, 90, 2, 2), displayIndex: 0, tween: { kind: "linear" } },
      ],
      endFrame: 20,
    };
  }

  it("the stage eases each channel on its own", () => {
    const s = sampleTransformRaw(tweenTrack(), 5)!;
    expect(s.x).toBeCloseTo(25, 6);
    expect(s.scaleX).toBeCloseTo(1.25, 6);
    expect(s.skewY).toBeCloseTo(90 * applyTween({ kind: "preset", family: "back", dir: "in" }, 0.25, 20), 6);
    expect(s.skewY).toBeLessThan(0);   // back in starts by pulling away
  });

  it("a hold holds every channel, whatever the overrides say", () => {
    const t = tweenTrack();
    t.keys[0]!.tween = { kind: "none" };
    expect(easeOf(t.keys[0]!, "rotation")).toEqual({ kind: "none" });
    const out = buildBoneTimeline(t, createNode("image", "n"), 21)!;
    expect(out.translateFrame![0]).not.toHaveProperty("tweenEasing");
    expect(out.translateFrame![0]).not.toHaveProperty("curve");
  });

  it("the override reaches only its own timeline", () => {
    const n = createNode("image", "n");
    n.bind = tf(0, 0, 0, 0);
    const out = buildBoneTimeline(tweenTrack(), n, 21)!;
    expect(out.translateFrame![0]!.tweenEasing).toBe(0);
    expect(out.scaleFrame![0]!.tweenEasing).toBe(0);
    expect(out.rotateFrame![0]).not.toHaveProperty("tweenEasing");
    expect(out.rotateFrame![0]!.curve!.length % 3).toBe(1);
  });

  it("an eased turn past half a revolution is cut at every frame, on the stage's values", () => {
    const n = createNode("image", "n");
    n.bind = tf(0, 0, 0, 0);
    const t: Track = {
      nodeId: "n1" as Track["nodeId"],
      keys: [
        { frame: 0, transform: tf(0, 0, 0, 0), displayIndex: 0, tween: { kind: "preset", family: "sine", dir: "inOut" } },
        { frame: 12, transform: tf(0, 0, 400, 400), displayIndex: 0, tween: { kind: "linear" } },
      ],
      endFrame: 12,
    };
    const frames = buildBoneTimeline(t, n, 12)!.rotateFrame!;
    expect(frames.length).toBe(13);
    frames.slice(0, 12).forEach((f, i) => {
      expect(f.rotate ?? 0).toBeCloseTo(sampleTransformRaw(t, i)!.skewY, 3);
    });
  });

  it("F6 inside a tween keeps the overrides on both halves", () => {
    const t = insertKeyframe(tweenTrack(), 10, createNode("image", "n"))!;
    expect(t.keys[1]!.eases?.rotation).toEqual({ kind: "preset", family: "back", dir: "in" });
  });
});

describe("schema", () => {
  it("keeps valid eases and drops what it cannot evaluate", () => {
    const project = createProject("T") as unknown as Record<string, unknown>;
    const { project: p0 } = validateProject(migrate(project));
    const sym = p0.items[p0.rootSymbolId] as unknown as { animations: Array<{ tracks: Record<string, unknown> }>; nodes: Record<string, unknown>; layers: unknown[] };
    const node = createNode("image", "n");
    sym.nodes[node.id] = node;
    sym.layers.unshift(createLayer(node.id, "n", 0));
    sym.animations[0]!.tracks[node.id] = {
      nodeId: node.id,
      endFrame: 10,
      keys: [
        {
          frame: 0, transform: tf(), displayIndex: 0,
          tween: { kind: "preset", family: "back", dir: "out", amount: 99 },
          eases: {
            position: { kind: "curve", curve: [0.1, 0.2, 0.3] },
            rotation: { kind: "wobble" },
            scale: { kind: "curve", curve: [0.2, 0, 0.8, 1] },
            bogus: { kind: "linear" },
          },
        },
        { frame: 10, transform: tf(), displayIndex: 0, tween: { kind: "sideways" } },
      ],
    };
    const { project: out } = validateProject(migrate(JSON.parse(JSON.stringify(p0))));
    const keys = (out.items[out.rootSymbolId] as unknown as typeof sym).animations[0]!.tracks[node.id] as Track;
    expect(keys.keys[0]!.tween).toEqual({ kind: "preset", family: "back", dir: "out", amount: 4 });
    expect(keys.keys[0]!.eases).toEqual({ scale: { kind: "curve", curve: [0.2, 0, 0.8, 1] } });
    expect(keys.keys[1]!.tween).toEqual({ kind: "linear" });
  });
});
