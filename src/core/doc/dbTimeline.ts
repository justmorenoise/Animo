/**
 * DragonBones timelines read back into Animo keyframes: the inverse of
 * `core/export/frameSplit.ts`, and as faithful to the runtime as the export.
 *
 * A DragonBones bone has a timeline per channel (translate, rotate, scale),
 * a slot one for its display and one for its colour, each with its own
 * frames and eases. An Animo keyframe holds them all at one frame. So every
 * channel is sampled at the union of every channel's frames, and each
 * channel's ease is cut where another channel has a key (`subTween`), which
 * keeps the motion the same between the keys too. Where a cut cannot be
 * eased (a curve past the file's range) that stretch gets a key every frame.
 *
 * Read out of the vendored runtime's parser, not documentation:
 * - Frames are placed by summing `duration` (default 1) from 0.
 * - A frame's ease governs the interval to the next frame; the last frame's
 *   runs to the animation's end and tweens back to the first frame when the
 *   animation repeats (`TweenTimelineState._onArriveAtFrame`).
 * - Rotation is unwrapped as `_parseBoneRotateFrame` does: each frame takes
 *   the short way from the previous one, unless that one asked for whole
 *   turns (`clockwise`).
 */
import { applyTween, subTween, tweenFromFile, TWEEN_NONE, type TweenChannel, type TweenSpec } from "@/core/math/easing";
import type { Transform } from "@/core/math/Transform";
import type { ColorTransform, Keyframe } from "./types";

export type Raw = Record<string, unknown>;

export const asObj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Raw : null);
export const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
export const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** One frame of a channel: its value from `at`, eased by `tween` to the next. */
export interface ChannelFrame<V> { at: number; value: V; tween: TweenSpec }

export interface Channel<V> {
  frames: ChannelFrame<V>[];
  lerp: (a: V, b: V, t: number) => V;
  /** The last frame tweens back to the first when the animation repeats. */
  wrap: boolean;
}

export interface Translate { x: number; y: number }
export interface Rotate { rotate: number; skew: number }
export interface Scale { x: number; y: number }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpXY = (a: Translate, b: Translate, t: number): Translate => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
const lerpRot = (a: Rotate, b: Rotate, t: number): Rotate => ({ rotate: lerp(a.rotate, b.rotate, t), skew: lerp(a.skew, b.skew, t) });
const COLOR_KEYS = ["aM", "rM", "gM", "bM", "aO", "rO", "gO", "bO"] as const;
const lerpColor = (a: ColorTransform, b: ColorTransform, t: number): ColorTransform =>
  Object.fromEntries(COLOR_KEYS.map((k) => [k, lerp(a[k], b[k], t)])) as unknown as ColorTransform;
const holdNumber = (a: number) => a;

/** The runtime's `Transform.normalizeRadian`, in degrees: into (−180, 180]. */
export function normalizeDeg(deg: number): number {
  let v = (deg + 180) % 360;
  v += v > 0 ? -180 : 180;
  return v;
}

/** A frame's ease over the `length` frames it governs, as `_parseTweenFrame` reads it. */
function tweenOf(raw: Raw, length: number): TweenSpec {
  const curve = Array.isArray(raw.curve) && raw.curve.every((v) => typeof v === "number") ? raw.curve as number[] : undefined;
  const tweenEasing = typeof raw.tweenEasing === "number" ? raw.tweenEasing : undefined;
  return tweenFromFile({ curve, tweenEasing }, length);
}

/**
 * Where each frame starts and how long it lasts, as `_parseTimeline` places
 * them: one frame per tick at most, so a frame of no length in the middle
 * still takes a tick and moves the rest along; the last frame lasts to the
 * end of the animation whatever it says; a frame that would start past the
 * end is never placed; a timeline of one frame does not tween.
 */
export function placed(raw: unknown[], duration: number): Array<{ raw: Raw; at: number; length: number }> {
  const out: Array<{ raw: Raw; at: number; length: number }> = [];
  if (raw.length === 1) return [{ raw: asObj(raw[0]) ?? {}, at: 0, length: 0 }];
  let a = 0, i = 0, e = 0;
  for (let t = 0; t <= duration && e < raw.length; t++) {
    if (a + i > t) continue;
    const r = asObj(raw[e]) ?? {};
    a = t;
    i = e === raw.length - 1 ? duration - a : Math.max(0, num(r.duration, 1));
    out.push({ raw: r, at: a, length: i });
    e++;
  }
  return out;
}

function channel<V>(raw: unknown[], duration: number, value: (r: Raw) => V, lerpFn: (a: V, b: V, t: number) => V, wrap: boolean, tweens = true): Channel<V> | null {
  const frames = placed(raw, duration).map((f) => ({ at: f.at, value: value(f.raw), tween: tweens ? tweenOf(f.raw, f.length) : TWEEN_NONE }));
  return frames.length ? { frames, lerp: lerpFn, wrap: wrap && frames.length > 1 } : null;
}

export const translateChannel = (raw: unknown[], duration: number, wrap: boolean) =>
  channel<Translate>(raw, duration, (r) => ({ x: num(r.x, 0), y: num(r.y, 0) }), lerpXY, wrap);

export const scaleChannel = (raw: unknown[], duration: number, wrap: boolean) =>
  channel<Scale>(raw, duration, (r) => ({ x: num(r.x, 1), y: num(r.y, 1) }), lerpXY, wrap);

/** `rotateFrame`: `rotate` unwrapped as the runtime does, `skew` as written. */
export function rotateChannel(raw: unknown[], duration: number, wrap: boolean): Channel<Rotate> | null {
  const frames = placed(raw, duration);
  let prev = 0, clockwise = 0;
  const values = frames.map((f, i) => {
    const rotate = unwrap(num(f.raw.rotate, 0), i, prev, clockwise);
    clockwise = num(f.raw.clockwise, 0);
    prev = rotate;
    return { rotate, skew: num(f.raw.skew, 0) };
  });
  return frames.length
    ? { frames: frames.map((f, i) => ({ at: f.at, value: values[i]!, tween: tweenOf(f.raw, f.length) })), lerp: lerpRot, wrap: wrap && frames.length > 1 }
    : null;
}

function unwrap(deg: number, index: number, prev: number, clockwise: number): number {
  if (index === 0) return deg;
  if (clockwise === 0) return prev + normalizeDeg(deg - prev);
  let turns = clockwise;
  if (turns > 0 ? deg >= prev : deg <= prev) turns = turns > 0 ? turns - 1 : turns + 1;
  return prev + (deg - prev) + 360 * turns;
}

/** A DragonBones transform's angles, as `_parseTransform` reads them: skY is
 *  the rotation, skX − skY the skew, or `rotate` and `skew` themselves. */
export function anglesOf(t: Raw): { rotate: number; skew: number } {
  if ("rotate" in t || "skew" in t) return { rotate: normalizeDeg(num(t.rotate, 0)), skew: normalizeDeg(num(t.skew, 0)) };
  const rotate = normalizeDeg(num(t.skY, 0));
  return { rotate, skew: normalizeDeg(num(t.skX, 0)) - rotate };
}

/** The 5.0 bone timeline, one `frame` list with a whole `transform` each, as three channels. */
export function allFrameChannels(raw: unknown[], duration: number, wrap: boolean): { translate: Channel<Translate>; rotate: Channel<Rotate>; scale: Channel<Scale> } | null {
  const frames = placed(raw, duration);
  if (!frames.length) return null;
  wrap = wrap && frames.length > 1;
  let prev = 0, clockwise = 0;
  const rows = frames.map((f, i) => {
    const t = asObj(f.raw.transform) ?? {};
    const { rotate: r, skew } = anglesOf(t);
    const rotate = unwrap(r, i, prev, clockwise);
    clockwise = num(f.raw.tweenRotate, 0);
    prev = rotate;
    return { f, t, rotate, skew, tween: tweenOf(f.raw, f.length) };
  });
  return {
    translate: { frames: rows.map((r) => ({ at: r.f.at, value: { x: num(r.t.x, 0), y: num(r.t.y, 0) }, tween: r.tween })), lerp: lerpXY, wrap },
    rotate: { frames: rows.map((r) => ({ at: r.f.at, value: { rotate: r.rotate, skew: r.skew }, tween: r.tween })), lerp: lerpRot, wrap },
    scale: { frames: rows.map((r) => ({ at: r.f.at, value: { x: num(r.t.scX, 1), y: num(r.t.scY, 1) }, tween: r.tween })), lerp: lerpXY, wrap },
  };
}

/** `displayFrame` (`value`, or the older `displayIndex`): which display, no tween. */
export const displayChannel = (raw: unknown[], duration: number) =>
  channel<number>(raw, duration, (r) => Math.round(num(r.value, num(r.displayIndex, 0))), holdNumber, false, false);

export function colorOf(raw: unknown): ColorTransform {
  const c = asObj(raw) ?? {};
  return {
    aM: num(c.aM, 100), rM: num(c.rM, 100), gM: num(c.gM, 100), bM: num(c.bM, 100),
    aO: num(c.aO, 0), rO: num(c.rO, 0), gO: num(c.gO, 0), bO: num(c.bO, 0),
  };
}

/** `colorFrame` (`value`, or the older `color`). */
export const colorChannel = (raw: unknown[], duration: number, wrap: boolean) =>
  channel<ColorTransform>(raw, duration, (r) => colorOf(r.value ?? r.color), lerpColor, wrap);

/** Where the frame governing `frame` starts, and where its interval ends. */
function intervalAt<V>(ch: Channel<V>, frame: number, duration: number): { i: number; end: number; endValue: V } {
  let i = 0;
  while (i + 1 < ch.frames.length && ch.frames[i + 1]!.at <= frame) i++;
  const next = ch.frames[i + 1];
  const own = ch.frames[i]!;
  if (next) return { i, end: next.at, endValue: next.value };
  return { i, end: Math.max(duration, own.at + 1), endValue: ch.wrap ? ch.frames[0]!.value : own.value };
}

/** The channel's value at a whole frame, as the runtime shows it. */
export function sampleChannel<V>(ch: Channel<V>, frame: number, duration: number): V {
  const { i, end, endValue } = intervalAt(ch, frame, duration);
  const f = ch.frames[i]!;
  if (frame <= f.at || f.tween.kind === "none") return f.value;
  const span = end - f.at;
  return ch.lerp(f.value, endValue, applyTween(f.tween, (frame - f.at) / span, span));
}

/** The ease of the channel from `from` to `to`, both inside one of its intervals; null when it cannot be eased. */
export function easeBetween<V>(ch: Channel<V>, from: number, to: number, duration: number): TweenSpec | null {
  const { i, end } = intervalAt(ch, from, duration);
  const f = ch.frames[i]!;
  return subTween(f.tween, end - f.at, from - f.at, to - f.at);
}

/**
 * Frames at which the channel needs a key of its own: where a frame starts,
 * and the animation's last frame when the channel is still tweening there —
 * toward a frame at the very end, or back to the first. Animo shows frames
 * 0 to duration − 1, so a frame AT the end is never keyed itself: the last
 * one shown takes the value on the way to it.
 */
export function channelFrames<V>(ch: Channel<V>, duration: number): number[] {
  const inside = ch.frames.filter((f) => f.at < duration);
  const out = inside.map((f) => f.at);
  const last = inside[inside.length - 1];
  const goesOn = last && (ch.frames.length > inside.length || ch.wrap);
  if (last && goesOn && last.tween.kind !== "none" && last.at < duration - 1) out.push(duration - 1);
  return out;
}

export interface NodeChannels {
  translate?: Channel<Translate>;
  rotate?: Channel<Rotate>;
  scale?: Channel<Scale>;
  display?: Channel<number>;
  color?: Channel<ColorTransform>;
}

const EASED: Array<[keyof NodeChannels, TweenChannel]> = [
  ["translate", "position"], ["rotate", "rotation"], ["scale", "scale"], ["color", "color"],
];

/**
 * Keyframes for one node over an animation of `duration` frames: a key
 * wherever any channel has a frame, each holding every channel's value
 * there, and each channel eased to the next key as the file eases it.
 * `display` maps the file's display index to the node's (-1 hides);
 * `hidden`: the slot shows nothing unless a display frame says otherwise.
 */
export function keysFor(
  channels: NodeChannels, bind: Transform, duration: number,
  display: (index: number) => number = (i) => i, hidden = false,
): Keyframe[] {
  const frames = new Set<number>([0]);
  for (const ch of Object.values(channels)) if (ch) for (const f of channelFrames(ch as Channel<unknown>, duration)) frames.add(f);

  // A stretch no ease can reproduce gets a key every frame; each new key may
  // cut another channel's interval, so repeat until nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    const sorted = [...frames].sort((a, b) => a - b);
    for (const [name] of EASED) {
      const ch = channels[name] as Channel<unknown> | undefined;
      if (!ch) continue;
      sorted.forEach((at, j) => {
        const next = sorted[j + 1];
        if (next === undefined || easeBetween(ch, at, next, duration)) return;
        for (let f = at + 1; f < next; f++) if (!frames.has(f)) { frames.add(f); changed = true; }
      });
    }
  }

  const sorted = [...frames].sort((a, b) => a - b);
  return sorted.map((at, j) => {
    const next = sorted[j + 1];
    const tr = channels.translate ? sampleChannel(channels.translate, at, duration) : { x: 0, y: 0 };
    const ro = channels.rotate ? sampleChannel(channels.rotate, at, duration) : { rotate: 0, skew: 0 };
    const sc = channels.scale ? sampleChannel(channels.scale, at, duration) : { x: 1, y: 1 };
    const skewY = bind.skewY + ro.rotate;
    const transform: Transform = {
      x: bind.x + tr.x,
      y: bind.y + tr.y,
      skewY,
      skewX: skewY + (bind.skewX - bind.skewY) + ro.skew,
      scaleX: bind.scaleX * sc.x,
      scaleY: bind.scaleY * sc.y,
    };
    const shown = channels.display ? display(sampleChannel(channels.display, at, duration)) : hidden ? -1 : 0;
    const key: Keyframe = { frame: at, transform, displayIndex: shown, tween: TWEEN_NONE };
    if (channels.color) {
      const c = sampleChannel(channels.color, at, duration);
      key.color = c;
    }
    if (next !== undefined) {
      const eases: Partial<Record<TweenChannel, TweenSpec>> = {};
      for (const [name, tc] of EASED) {
        const ch = channels[name] as Channel<unknown> | undefined;
        if (ch) eases[tc] = easeBetween(ch, at, next, duration) ?? { kind: "linear" };
      }
      // The key's own ease is the first channel's that tweens; channels that
      // differ from it, a hold included, override it.
      const tween = Object.values(eases).find((e) => e.kind !== "none") ?? TWEEN_NONE;
      key.tween = tween;
      if (tween.kind !== "none") {
        const overrides = Object.fromEntries(Object.entries(eases).filter(([, e]) => JSON.stringify(e) !== JSON.stringify(tween)));
        if (Object.keys(overrides).length) key.eases = overrides;
      }
    }
    return key;
  });
}

