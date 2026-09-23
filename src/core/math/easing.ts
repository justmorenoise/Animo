/**
 * Tween easing, replicating DragonBones 6.0.2 EXACTLY.
 *
 * This file is deliberately a port, not an improvement. If the editor
 * evaluated the "correct" cubic bezier while the runtime evaluates a sampled
 * approximation, the two would agree at every keyframe and disagree
 * everywhere in between — the worst possible failure mode, invisible to
 * casual testing. So we reproduce the runtime's sampling, including its
 * quantisation, and let the parity harness prove it.
 *
 * Sources (DragonBonesJS master):
 *   ObjectDataParser._samplingEasingCurve  — builds the sample table
 *   TweenTimelineState._getEasingValue     — scalar easing
 *   TweenTimelineState._getEasingCurveValue— evaluates the table
 *
 * The format has two encodings and nothing else: the scalar `tweenEasing`
 * (quad in / out / in-out) and `curve`. Every other ease — sine, back,
 * bounce, a hand-drawn curve — therefore travels as a `curve`, and the
 * editor evaluates it through the very bytes the exporter writes
 * (`curveToJson` → `sampleRuntimeCurve`), so the stage cannot drift from the
 * runtime.
 */

export type EaseFamily = "pow" | "sine" | "circ" | "expo" | "back" | "elastic" | "bounce";
export type EaseDir = "in" | "out" | "inOut";

export type TweenSpec =
  | { kind: "none" }                                  // hold / stepped
  | { kind: "linear" }                                // tweenEasing: 0
  | { kind: "ease"; value: number }                   // tweenEasing in [-2, 2] \ {0}
  /** Cubic bezier with implicit (0,0) and (1,1):
   *  `[c1x,c1y, c2x,c2y, (ax,ay, c1x,c1y, c2x,c2y)*]`, 4 + 6k numbers. */
  | { kind: "curve"; curve: readonly number[] }
  | { kind: "preset"; family: EaseFamily; dir: EaseDir; amount?: number };

/** An ease that tweens — what a per-property override may hold. */
export type EaseSpec = Exclude<TweenSpec, { kind: "none" }>;

export const TWEEN_NONE: TweenSpec = { kind: "none" };
export const TWEEN_LINEAR: TweenSpec = { kind: "linear" };
export const DEFAULT_CUSTOM_CURVE: readonly number[] = [0.42, 0, 0.58, 1];

/* ── Scalar easing ─────────────────────────────────────────────────────────
   The runtime stores the magnitude as round(|e| * 100) and multiplies by
   0.01 on read, so the effective value is quantised to two decimals. We
   quantise identically rather than pretending we have more precision.      */

export function easeScalar(progress: number, tweenEasing: number): number {
  if (tweenEasing === 0) return progress;

  let value: number;
  let easing: number;

  if (tweenEasing < 0) {
    // QuadIn
    value = progress * progress;
    easing = Math.round(-tweenEasing * 100) * 0.01;
  } else if (tweenEasing <= 1) {
    // QuadOut
    const inv = 1 - progress;
    value = 1 - inv * inv;
    easing = Math.round(tweenEasing * 100) * 0.01;
  } else {
    // QuadInOut
    value = 0.5 * (1 - Math.cos(progress * Math.PI));
    easing = Math.round(tweenEasing * 100 - 100) * 0.01;
  }

  return (value - progress) * easing + progress;
}

/* ── Preset families ──────────────────────────────────────────────────────*/

export interface EaseAmount {
  label: string;
  min: number;
  max: number;
  default: number;
  step: number;
}

export const EASE_FAMILIES: ReadonlyArray<{ id: EaseFamily; label: string; amount?: EaseAmount }> = [
  { id: "pow", label: "Power", amount: { label: "Power", min: 1.2, max: 8, default: 2, step: 0.1 } },
  { id: "sine", label: "Sine" },
  { id: "circ", label: "Circular" },
  { id: "expo", label: "Exponential" },
  { id: "back", label: "Back", amount: { label: "Overshoot", min: 0, max: 4, default: 1.70158, step: 0.1 } },
  { id: "elastic", label: "Elastic", amount: { label: "Oscillations", min: 1, max: 10, default: 3, step: 0.5 } },
  { id: "bounce", label: "Bounce", amount: { label: "Bounciness", min: 0.05, max: 0.7, default: 0.25, step: 0.05 } },
];

export function familyInfo(family: EaseFamily) {
  return EASE_FAMILIES.find((f) => f.id === family)!;
}

export function presetAmount(spec: { family: EaseFamily; amount?: number }): number {
  const a = familyInfo(spec.family).amount;
  if (!a) return 0;
  const v = spec.amount ?? a.default;
  return Math.min(a.max, Math.max(a.min, v));
}

/** Height of a ball above the floor, dropped from 1 with `r` of each
 *  bounce's height kept, over three bounces. r = 0.25 is Penner's bounce. */
function bounceOut(p: number, r: number): number {
  const v = Math.sqrt(r);
  const widths = [1, 2 * v, 2 * v * v, 2 * v * v * v];
  const total = widths.reduce((s, w) => s + w, 0);
  let t = p * total;
  if (t <= 1) return t * t;
  t -= 1;
  for (let k = 1; k < widths.length; k++) {
    const w = widths[k]!;
    if (t <= w || k === widths.length - 1) {
      const u = (t - w / 2) / (w / 2);
      return 1 - Math.pow(r, k) * (1 - u * u);
    }
    t -= w;
  }
  return 1;
}

/** The ideal ease-in shape of a family, 0 → 1. */
function easeIn(family: EaseFamily, amount: number, p: number): number {
  switch (family) {
    case "pow":     return Math.pow(p, amount);
    case "sine":    return 1 - Math.cos((p * Math.PI) / 2);
    case "circ":    return 1 - Math.sqrt(Math.max(0, 1 - p * p));
    case "expo": {
      const lo = Math.pow(2, -10);
      return (Math.pow(2, 10 * (p - 1)) - lo) / (1 - lo);
    }
    case "back":    return p * p * ((amount + 1) * p - amount);
    case "elastic": {
      if (p <= 0) return 0;
      if (p >= 1) return 1;
      const period = 1 / amount;
      const q = p - 1;
      return -Math.pow(2, 10 * q) * Math.sin(((q - period / 4) * 2 * Math.PI) / period);
    }
    case "bounce":  return 1 - bounceOut(1 - p, amount);
  }
}

/** The ideal curve of a preset, before the runtime samples it. */
export function easeFunction(spec: { family: EaseFamily; dir: EaseDir; amount?: number }): (p: number) => number {
  const amount = presetAmount(spec);
  const fin = (p: number) => easeIn(spec.family, amount, p);
  switch (spec.dir) {
    case "in":    return fin;
    case "out":   return (p) => 1 - fin(1 - p);
    case "inOut": return (p) => (p < 0.5 ? fin(2 * p) / 2 : 1 - fin(2 - 2 * p) / 2);
  }
}

/* ── Bezier curve ─────────────────────────────────────────────────────────*/

/** The runtime stores each sample in an Int16Array: y past ±3.2767 wraps. */
export const CURVE_Y_LIMIT = 3.2767;

function curvePoint(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number,
  t: number,
): { x: number; y: number } {
  const l = 1 - t;
  const l3 = l * l * l;
  const l2t3 = 3 * l * l * t;
  const lt23 = 3 * l * t * t;
  const t3 = t * t * t;
  return {
    x: l3 * x1 + l2t3 * x2 + lt23 * x3 + t3 * x4,
    y: l3 * y1 + l2t3 * y2 + lt23 * y3 + t3 * y4,
  };
}

/**
 * `_samplingEasingCurve`, the `length % 3 === 1` branch, verbatim — quirk
 * included: the FIRST segment is evaluated from (0,0) to (1,1) rather than to
 * its anchor, and the LAST one from (0,0) rather than from its anchor. Only
 * the middle segments are what they look like. `curveToJson` pads a
 * multi-segment curve with zero-width segments at both ends so that every
 * real segment is a middle one.
 *
 * Samples sit at t = (i+1)/(frameCount+2), `frameCount + 1` of them, each
 * `round(y * 10000)` as an Int16.
 */
export function sampleRuntimeCurve(curve: readonly number[], frameCount: number): Int32Array {
  const sampleCount = frameCount + 1;
  const out = new Int32Array(sampleCount);
  const l = curve.length;
  let r = -2;
  for (let i = 0; i < sampleCount; i++) {
    const t = (i + 1) / (sampleCount + 1);
    while ((r + 6 < l ? curve[r + 6]! : 1) < t) r += 6;
    const inCurve = r >= 0 && r + 6 < l;
    const x1 = inCurve ? curve[r]! : 0;
    const y1 = inCurve ? curve[r + 1]! : 0;
    const x4 = inCurve ? curve[r + 6]! : 1;
    const y4 = inCurve ? curve[r + 7]! : 1;
    const x2 = curve[r + 2]!, y2 = curve[r + 3]!, x3 = curve[r + 4]!, y3 = curve[r + 5]!;

    let lower = 0;
    let higher = 1;
    let p = curvePoint(x1, y1, x2, y2, x3, y3, x4, y4, 0.5);
    while (higher - lower > 0.0001) {
      const percentage = (higher + lower) * 0.5;
      p = curvePoint(x1, y1, x2, y2, x3, y3, x4, y4, percentage);
      if (t - p.x > 0) lower = percentage;
      else higher = percentage;
    }
    // Int16 truncation, as the typed array would do it.
    out[i] = (Math.round(p.y * 10000) << 16) >> 16;
  }
  return out;
}

/** Sample table of a curve in the editor's own form (see `TweenSpec`). */
export function sampleCurve(curve: readonly number[], frameCount: number): Int32Array {
  return sampleRuntimeCurve(curveToJson(curve), frameCount);
}

/** Evaluate a sample table — the piecewise-linear read the runtime does. */
export function easeCurveSampled(progress: number, samples: Int32Array): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;

  const count = samples.length;
  const segmentCount = count + 1;
  const valueIndex = Math.floor(progress * segmentCount);
  const fromValue = valueIndex === 0 ? 0 : samples[valueIndex - 1]!;
  const toValue = valueIndex === segmentCount - 1 ? 10000 : samples[valueIndex]!;

  return (fromValue + (toValue - fromValue) * (progress * segmentCount - valueIndex)) * 0.0001;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * The editor's curve as the file carries it. A single segment is already
 * safe; more than one gets a zero-width segment at each end — an anchor at
 * (0,0) and one at (1,1) — so the runtime's first/last-segment quirk only
 * ever lands on segments no sample can reach (every t is strictly inside
 * (0,1)).
 */
export function curveToJson(curve: readonly number[]): number[] {
  if (curve.length <= 4) return curve.map(round6);
  return [0, 0, 0, 0, 0, 0, ...curve.map(round6), 1, 1, 1, 1, 1, 1];
}

/**
 * A preset as a polyline through the ease at exactly the points the runtime
 * samples, so the runtime's table holds the ease's own values. Anchors that
 * lie on the line through their neighbours (within half a quantisation
 * step) are dropped, which keeps long flat tails from bloating the file.
 */
export function presetCurve(
  spec: { family: EaseFamily; dir: EaseDir; amount?: number },
  frameCount: number,
): number[] {
  const clampY = (y: number) => Math.min(CURVE_Y_LIMIT, Math.max(-CURVE_Y_LIMIT, y));
  const f = easeFunction(spec);
  const nodes = frameCount + 2;
  return polylineCurve(Array.from({ length: nodes + 1 }, (_, j) =>
    (j === 0 ? 0 : j === nodes ? 1 : clampY(f(j / nodes)))));
}

/** A polyline through `values`, evenly spaced over 0..1: the runtime's
 *  sample points when there are `frameCount + 3` of them. */
function polylineCurve(values: number[]): number[] {
  const last = values.length - 1;
  const pts = values.map((y, j): [number, number] => [j / last, y]);

  const TOL = 0.5e-4;
  const kept: Array<[number, number]> = [pts[0]!];
  let a = 0;
  while (a < pts.length - 1) {
    let b = a + 1;
    while (b + 1 < pts.length && collinear(pts, a, b + 1, TOL)) b++;
    kept.push(pts[b]!);
    a = b;
  }

  const out: number[] = [];
  for (let s = 0; s < kept.length - 1; s++) {
    const [ax, ay] = kept[s]!;
    const [bx, by] = kept[s + 1]!;
    if (s > 0) out.push(ax, ay);
    out.push(ax + (bx - ax) / 3, ay + (by - ay) / 3, ax + (2 * (bx - ax)) / 3, ay + (2 * (by - ay)) / 3);
  }
  return out;
}

function collinear(pts: Array<[number, number]>, a: number, b: number, tol: number): boolean {
  const [ax, ay] = pts[a]!;
  const [bx, by] = pts[b]!;
  for (let i = a + 1; i < b; i++) {
    const [x, y] = pts[i]!;
    if (Math.abs(ay + ((by - ay) * (x - ax)) / (bx - ax) - y) > tol) return false;
  }
  return true;
}

/* ── Evaluation ───────────────────────────────────────────────────────────
   Playback samples every tweened node on every frame; a table costs a
   binary search per sample, so tables are cached per spec object (specs
   are replaced, never mutated) and span.                                   */

const tableCache = new WeakMap<object, Map<number, Int32Array>>();

function tableFor(spec: Extract<TweenSpec, { kind: "curve" | "preset" }>, frameCount: number): Int32Array {
  let bySpan = tableCache.get(spec);
  if (!bySpan) tableCache.set(spec, (bySpan = new Map()));
  let table = bySpan.get(frameCount);
  if (!table) {
    const json = tweenToJson(spec, frameCount);
    table = sampleRuntimeCurve(json.curve!, frameCount);
    bySpan.set(frameCount, table);
  }
  return table;
}

/**
 * Map a linear 0..1 progress across a span of `frameCount` frames through a
 * tween spec, the way the runtime would. `none` holds at the start value.
 */
export function applyTween(spec: TweenSpec, progress: number, frameCount: number): number {
  switch (spec.kind) {
    case "none":   return 0;
    case "linear": return progress;
    case "ease":   return easeScalar(progress, spec.value);
    case "curve":
    case "preset": return easeCurveSampled(progress, tableFor(spec, frameCount));
  }
}

/* ── JSON mapping ─────────────────────────────────────────────────────────
   `tweenEasing` ABSENT means "no tween" — a hold. `0` means linear. Emitting
   0 where you meant absent turns every hold into a slide, which is the
   single easiest way to get an export subtly wrong.                        */

export interface TweenJson {
  tweenEasing?: number;
  curve?: number[];
}

/** `frameCount` is the span the frame governs: a preset's curve depends on it. */
export function tweenToJson(spec: TweenSpec, frameCount = 1): TweenJson {
  switch (spec.kind) {
    case "none":   return {};
    case "linear": return { tweenEasing: 0 };
    case "ease":   return { tweenEasing: spec.value };
    case "curve":  return { curve: curveToJson(spec.curve) };
    case "preset": return { curve: curveToJson(presetCurve(spec, frameCount)) };
  }
}

export function tweenFromJson(raw: TweenJson): TweenSpec {
  if (raw.curve && raw.curve.length >= 4 && raw.curve.length % 6 === 4) {
    return { kind: "curve", curve: [...raw.curve] };
  }
  if (raw.tweenEasing === undefined || raw.tweenEasing === null) return TWEEN_NONE;
  if (raw.tweenEasing === 0) return TWEEN_LINEAR;
  return { kind: "ease", value: raw.tweenEasing };
}

/* ── Cutting an interval ──────────────────────────────────────────────────*/

/**
 * The eases of the two halves of an interval of `span` frames cut `at`
 * frames in, each reproducing the part of the original motion it now
 * governs. F6 does not do this — it gives both halves the whole ease — so
 * whatever must stay put across a cut (Edit Multiple Frames) goes through
 * here.
 *
 * A quad in/out stays a scalar when the halves' scalars, which the file
 * rounds to hundredths, still land on every frame; anything else becomes a
 * curve through the displayed ease (`throughFrames`). Null when the cut
 * shows no progress on one side, or when a half needs a value past what the
 * file can hold (an elastic cut right on an overshoot).
 */
export function splitTween(spec: EaseSpec, span: number, at: number): [EaseSpec, EaseSpec] | null {
  if (spec.kind === "linear") return [spec, spec];
  const u = at / span;
  const E = (p: number) => applyTween(spec, p, span);
  const eu = E(u);
  if (Math.abs(eu) < 1e-6 || Math.abs(1 - eu) < 1e-6) return null;
  const head = (s: number) => E(s * u) / eu;
  const tail = (s: number) => (E(u + s * (1 - u)) - eu) / (1 - eu);

  const quad = spec.kind === "ease" && spec.value <= 1 ? splitQuad(spec.value, u) : null;
  if (quad && follows(quad[0], head, at) && follows(quad[1], tail, span - at)) return quad;

  const a = throughFrames(head, at);
  const b = throughFrames(tail, span - at);
  if ([...a, ...b].some((v) => Math.abs(v) > CURVE_Y_LIMIT)) return null;
  return [{ kind: "curve", curve: polylineCurve(a) }, { kind: "curve", curve: polylineCurve(b) }];
}

/** Quad in/out is `p + k·(p² − p)`, k > 0 in, k < 0 out, and so is each part
 *  of it, with k rescaled to the part covered. */
function splitQuad(value: number, u: number): [EaseSpec, EaseSpec] | null {
  const e = Math.round(Math.abs(value) * 100) * 0.01;
  const k = value < 0 ? e : -e;
  const head = quadEase((k * u) / (1 - k + k * u));
  const tail = quadEase((k * (1 - u)) / (1 + k * u));
  return head && tail ? [head, tail] : null;
}

function quadEase(k: number): EaseSpec | null {
  if (!Number.isFinite(k)) return null;
  if (Math.abs(k) < 0.005) return { kind: "linear" };
  if (k > 0 ? k <= 2 : k >= -1) return { kind: "ease", value: -k };
  return null;
}

/** Does `spec` land on `f` at every whole frame of an `m`-frame span? */
function follows(spec: EaseSpec, f: (s: number) => number, m: number): boolean {
  for (let k = 1; k < m; k++) if (Math.abs(applyTween(spec, k / m, m) - f(k / m)) > 1e-4) return false;
  return true;
}

/**
 * Sample-point values whose runtime read equals `f` at every whole frame of
 * an `m`-frame span, not merely near it. The read is linear between sample
 * points (j/(m+2), with 0 and 1 at the ends), which are closer together than
 * frames, so each frame falls between its own two points: the one with the
 * larger weight is solved for and the other keeps `f`'s value. Points solved
 * on the left go right to left, those on the right left to right, so every
 * point a solve reads is already final and no division is by less than ½.
 */
function throughFrames(f: (s: number) => number, m: number): number[] {
  const nodes = m + 2;
  const v = Array.from({ length: nodes + 1 }, (_, j) => (j === 0 ? 0 : j === nodes ? 1 : f(j / nodes)));
  const cells = Array.from({ length: Math.max(0, m - 1) }, (_, i) => {
    const x = ((i + 1) * nodes) / m;
    const j = Math.floor(x);
    return { target: f((i + 1) / m), j, w: x - j };
  });
  for (const c of [...cells].reverse()) {
    if (c.w < 0.5) v[c.j] = (c.target - c.w * v[c.j + 1]!) / (1 - c.w);
  }
  for (const c of cells) {
    if (c.w >= 0.5) v[c.j + 1] = (c.target - (1 - c.w) * v[c.j]!) / c.w;
  }
  return v;
}

/* ── Labels ───────────────────────────────────────────────────────────────*/

const DIR_LABEL: Record<EaseDir, string> = { in: "in", out: "out", inOut: "in-out" };

/** One signed scalar, the way DragonBones stores it. */
export function classicDir(value: number): EaseDir {
  if (value < 0) return "in";
  if (value > 1) return "inOut";
  return "out";
}

/** How an ease reads in the transport readout. */
export function easeLabel(spec: TweenSpec): string {
  switch (spec.kind) {
    case "none":   return "no tween";
    case "linear": return "linear";
    case "ease":   return `ease ${DIR_LABEL[classicDir(spec.value)]}`;
    case "curve":  return "custom";
    case "preset": return `${spec.family} ${DIR_LABEL[spec.dir]}`;
  }
}

/** The short tag drawn on a tweened span in the frame grid. */
export function easeTag(spec: TweenSpec): string | null {
  switch (spec.kind) {
    case "none":
    case "linear": return null;
    case "ease":   return DIR_LABEL[classicDir(spec.value)];
    case "curve":  return "~";
    case "preset": return spec.family;
  }
}

/** Quick presets offered in the frame context menu. */
export const EASE_PRESETS: ReadonlyArray<{ label: string; spec: TweenSpec }> = [
  { label: "No tween",     spec: TWEEN_NONE },
  { label: "Linear",       spec: TWEEN_LINEAR },
  { label: "Ease in",      spec: { kind: "ease", value: -1 } },
  { label: "Ease out",     spec: { kind: "ease", value: 1 } },
  { label: "Ease in-out",  spec: { kind: "ease", value: 2 } },
];

/* ── Per-property eases ───────────────────────────────────────────────────*/

export type TweenChannel = "position" | "rotation" | "scale" | "color";
export const TWEEN_CHANNELS: readonly TweenChannel[] = ["position", "rotation", "scale", "color"];
export type ChannelEases = Partial<Record<TweenChannel, EaseSpec>>;

/** The ease a channel follows over the interval leaving a key. A hold holds
 *  every channel; otherwise an override wins over the key's own ease. */
export function easeOf(key: { tween: TweenSpec; eases?: ChannelEases }, channel: TweenChannel): TweenSpec {
  if (key.tween.kind === "none") return key.tween;
  return key.eases?.[channel] ?? key.tween;
}

/** Structural equality, for "do these keys share an ease". */
export function sameEase(a: TweenSpec | undefined, b: TweenSpec | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
