/**
 * Flash frame algebra — the semantics behind F5/F6/F7/Shift+F5/Shift+F6.
 *
 * All functions here are pure and operate on a Track, returning a NEW track
 * (or null when the operation is a no-op). Commands wrap them; the UI never
 * calls them directly. Keeping them pure is what lets the whole F-key
 * behaviour be pinned down by a table-driven test rather than discovered by
 * clicking around.
 *
 * Vocabulary, matching Flash:
 *   keyframe  a frame that stores state
 *   span      a keyframe plus the frames that hold its content until the
 *             next keyframe (or `endFrame`)
 *   frame     any position inside a span
 */

import { cloneTf, type Transform } from "@/core/math/Transform";
import {
    applyTween,
    type ChannelEases,
    easeOf,
    type EaseSpec,
    splitTween,
    TWEEN_NONE,
    type TweenChannel
} from "@/core/math/easing";
import type { ColorTransform, Keyframe, Node, Track } from "./types";
import { DEFAULT_COLOR } from "./types";
import { createKeyframe } from "./defaults";

/**
 * The highest frame index a timeline can hold, Flash's own limit (16000
 * frames, numbered 1..16000). Nothing in DragonBones imposes it — it is here
 * so the ruler, the scrollbar and the playhead agree on where the timeline
 * stops instead of each inventing an end from the current animation's length.
 */
export const MAX_FRAMES = 16000;

/** `frame` brought inside `0..MAX_FRAMES-1`. */
export function clampFrame(frame: number): number {
  return Math.max(0, Math.min(MAX_FRAMES - 1, Math.round(frame)));
}

/** Index of the keyframe at exactly `frame`, or -1. */
export function keyIndexAt(track: Track, frame: number): number {
  for (let i = 0; i < track.keys.length; i++) {
    const k = track.keys[i]!;
    if (k.frame === frame) return i;
    if (k.frame > frame) break;
  }
  return -1;
}

export function keyAt(track: Track, frame: number): Keyframe | null {
  const i = keyIndexAt(track, frame);
  return i < 0 ? null : track.keys[i]!;
}

/** Index of the keyframe governing `frame` (at or before it), or -1. */
export function spanIndexAt(track: Track, frame: number): number {
  let found = -1;
  for (let i = 0; i < track.keys.length; i++) {
    if (track.keys[i]!.frame <= frame) found = i;
    else break;
  }
  return found;
}

export function spanKeyAt(track: Track, frame: number): Keyframe | null {
  const i = spanIndexAt(track, frame);
  return i < 0 ? null : track.keys[i]!;
}

/** The half-open frame range [start, end) a keyframe governs. */
export function spanRange(track: Track, keyIndex: number): { start: number; end: number } {
  const k = track.keys[keyIndex]!;
  const nextK = track.keys[keyIndex + 1];
  return { start: k.frame, end: nextK ? nextK.frame : track.endFrame + 1 };
}

/** True when the track shows content at `frame`. */
export function occupiesFrame(track: Track, frame: number): boolean {
  return frame >= 0 && frame <= track.endFrame && spanIndexAt(track, frame) >= 0;
}

/** Does the keyframe governing `frame` tween into the next one? */
export function isTweened(track: Track, frame: number): boolean {
  const i = spanIndexAt(track, frame);
  if (i < 0 || i >= track.keys.length - 1) return false;
  return track.keys[i]!.tween.kind !== "none";
}

function sorted(keys: Keyframe[]): Keyframe[] {
  return [...keys].sort((a, b) => a.frame - b.frame);
}

function withKeys(track: Track, keys: Keyframe[], endFrame = track.endFrame): Track {
  return { nodeId: track.nodeId, keys: sorted(keys), endFrame };
}

/* ── F6 — Insert Keyframe ─────────────────────────────────────────────────
   Duplicates the state currently showing at `frame` and makes it explicit.
   Already a keyframe? No-op.                                              */

export function insertKeyframe(track: Track, frame: number, node: Node): Track | null {
  if (keyIndexAt(track, frame) >= 0) return null;

  const govern = spanKeyAt(track, frame);
  // Mid-tween F6 must capture what is actually on screen, colour included —
  // also when only the NEXT key carries one and this span fades out of neutral.
  const color = govern ? sampleColorRaw(track, frame) : null;
  const key: Keyframe = govern
    ? {
        ...govern,
        frame,
        transform: cloneTf(sampleTransformRaw(track, frame) ?? govern.transform),
        ...(color ? { color } : {}),
      }
    : createKeyframe(frame, node);

  let keys = [...track.keys, key];
  const next = govern ? track.keys.find((k) => k.frame > frame) : undefined;
  if (govern && next && (govern.rotateDir || govern.rotateTurns)) {
    // Cutting a directed or multi-turn tween. The sample already lies on the
    // chosen path, so the first half becomes a plain keyed interval; the
    // second keeps whatever whole turns are left, or both halves would spin
    // the full amount.
    const remaining = rotationDelta(govern, next) - (key.transform.skewY - govern.transform.skewY);
    const turns = Math.round((remaining - (next.transform.skewY - key.transform.skewY)) / 360);
    delete key.rotateDir;
    delete key.rotateTurns;
    if (turns) key.rotateTurns = turns;
    const first: Keyframe = { ...govern };
    delete first.rotateDir;
    delete first.rotateTurns;
    keys = keys.map((k) => (k === govern ? first : k));
  }

  // A new keyframe cut into a tween must not inherit "tween into the next"
  // if it lands on the very end of the track.
  return withKeys(track, keys, Math.max(track.endFrame, frame));
}

/* ── F7 — Insert Blank Keyframe ───────────────────────────────────────────*/

export function insertBlankKeyframe(track: Track, frame: number, node: Node): Track | null {
  const existing = keyIndexAt(track, frame);
  const blank: Keyframe = {
    frame,
    transform: cloneTf(node.bind),
    displayIndex: -1,
    tween: TWEEN_NONE,
  };
  const keys = existing >= 0
    ? track.keys.map((k, i) => (i === existing ? blank : k))
    : [...track.keys, blank];
  return withKeys(track, keys, Math.max(track.endFrame, frame));
}

/* ── F5 — Insert Frame ────────────────────────────────────────────────────
   Extends the span at `frame` by one, pushing every LATER keyframe right.  */

export function insertFrame(track: Track, frame: number): Track {
  const keys = track.keys.map((k) => (k.frame > frame ? { ...k, frame: k.frame + 1 } : k));
  return withKeys(track, keys, Math.max(track.endFrame + 1, frame));
}

/* ── Shift+F5 — Remove Frame ──────────────────────────────────────────────
   Shrinks the span, pulling later keyframes left. A keyframe whose span is
   this one frame goes with it, as the frame's content does in Flash; keeping
   it instead left a key past `endFrame` whenever the last frame was a key.
   Past the end of the track there is nothing to remove: a range widened to
   every layer must not shorten the layers that end before it.              */

export function removeFrame(track: Track, frame: number): Track | null {
  if (track.endFrame <= 0 || frame < 0 || frame > track.endFrame) return null;
  const i = keyIndexAt(track, frame);
  const gone = i >= 0 && spanRange(track, i).end === frame + 1 ? i : -1;
  const moved = track.keys
    .filter((_, n) => n !== gone)
    .map((k) => (k.frame > frame ? { ...k, frame: k.frame - 1 } : k));
  if (moved.length === 0) return null;
  return withKeys(track, moved, Math.max(0, track.endFrame - 1));
}

/* ── Shift+F6 — Clear Keyframe ────────────────────────────────────────────
   Removes the keyframe, so the previous span extends through it. Frame 0's
   keyframe is the track's anchor and cannot be cleared.                    */

export function clearKeyframe(track: Track, frame: number): Track | null {
  const i = keyIndexAt(track, frame);
  if (i <= 0) return null;
  return withKeys(track, track.keys.filter((_, n) => n !== i));
}

/* ── Paste Frames ─────────────────────────────────────────────────────────
   A copied run of `span` frames, its keys rebased to 0, dropped in at `at`.
   "insert" is Flash's Paste Frames: everything from `at` on moves right by
   `span`, after an F6 there when `at` falls mid-span, so what moves starts
   with the pose it had. "overwrite" is Paste and Overwrite Frames: what lies
   under the run is replaced and nothing moves.                           */

export function pasteRun(
  track: Track, keys: Keyframe[], span: number, at: number,
  mode: "insert" | "overwrite", node: Node,
): Track {
  let base = track;
  if (mode === "insert") {
    if (at <= base.endFrame && keyIndexAt(base, at) < 0 && spanIndexAt(base, at) >= 0) {
      base = insertKeyframe(base, at, node) ?? base;
    }
    base = withKeys(
      base,
      base.keys.map((k) => (k.frame >= at ? { ...k, frame: k.frame + span } : k)),
      at <= base.endFrame ? base.endFrame + span : base.endFrame,
    );
  }
  const end = at + span - 1;
  const kept = base.keys.filter((k) => k.frame < at || k.frame > end);
  const pasted = keys.map((k) => ({ ...k, frame: k.frame + at }));
  return withKeys(base, [...kept, ...pasted], Math.max(base.endFrame, end));
}

/* ── Frame span editing ───────────────────────────────────────────────────*/

/** Drag the end of the track's span. */
export function setEndFrame(track: Track, endFrame: number): Track {
  const last = track.keys[track.keys.length - 1]?.frame ?? 0;
  return withKeys(track, track.keys, Math.max(endFrame, last));
}

/**
 * The length of an animation with no tracks at all after inserting
 * (`delta` > 0) or removing (`delta` < 0) frames at `from`. Inserting past the
 * end reaches out to `from`, as F5 on frame 100 of a fresh timeline makes a
 * hundred frames; removing takes only the frames that exist, the way
 * `removeFrame` stops at a track's end.
 */
export function resizedEmptyLength(duration: number, from: number, delta: number): number {
  if (delta > 0) return Math.max(duration, from) + delta;
  const removable = Math.max(0, Math.min(-delta, duration - from));
  return Math.max(1, duration - removable);
}

/**
 * Where a track's span ends once the animation goes from `from` to `to` frames.
 * A span that reached the old end follows the new one; a span that stopped
 * earlier keeps its end unless the new end cuts it — a layer that leaves the
 * stage at frame 10 must not come back because the animation grew. Never
 * before the last key.
 */
export function endAfterResize(track: Track, from: number, to: number): number {
  const lastKey = track.keys[track.keys.length - 1]?.frame ?? 0;
  const end = Math.max(lastKey, to - 1);
  return track.endFrame >= from - 1 ? end : Math.min(track.endFrame, end);
}

/** Move one keyframe, refusing collisions and never moving frame 0's anchor. */
export function moveKeyframe(track: Track, from: number, to: number): Track | null {
  if (from === to || to < 0) return null;
  const i = keyIndexAt(track, from);
  if (i < 0) return null;
  if (keyIndexAt(track, to) >= 0) return null;
  const keys = track.keys.map((k, n) => (n === i ? { ...k, frame: to } : k));
  return withKeys(track, keys, Math.max(track.endFrame, to));
}

/** Shift a whole run of keyframes — used by keyframe drags in the frame grid. */
export function moveRange(track: Track, from: number, to: number, delta: number): Track | null {
  if (delta === 0) return null;
  const inRange = (f: number) => f >= from && f <= to;
  const moving = track.keys.filter((k) => inRange(k.frame));
  if (moving.length === 0 || moving.some((k) => k.frame + delta < 0)) return null;
  // Anything the moved run lands on is overwritten, as in Flash. The run is
  // told apart by identity: testing `frame - delta` against the range also
  // matched the key being landed on, and both survived on one frame.
  const landed = new Set(moving.map((k) => k.frame + delta));
  const staying = track.keys.filter((k) => !inRange(k.frame) && !landed.has(k.frame));
  const keys = [...staying, ...moving.map((k) => ({ ...k, frame: k.frame + delta }))];
  return withKeys(track, keys, Math.max(track.endFrame, to + delta));
}

/**
 * `from..to` of a track emptied, which is what a frame drag leaves behind and
 * not what Cut Frames does: a row showing something from before the range
 * gets a blank key at `from` rather than holding that pose across the gap,
 * and a range that reached the end takes the span with it. The frames AFTER
 * the range keep what they showed — a key goes in at `to + 1` first, cut like
 * Edit Multiple Frames cuts, or the blank key would govern them too. Null
 * when the range lies past the track.
 */
export function emptyRange(track: Track, from: number, to: number, node: Node): Track | null {
  if (from > track.endFrame) return null;
  const t = to + 1 <= track.endFrame ? cutKeepingEase(track, to + 1, node) ?? track : track;
  const keys = t.keys.filter((k) => k.frame < from || k.frame > to);
  const before = keys.some((k) => k.frame < from);
  const after = keys.some((k) => k.frame > to);
  let endFrame = t.endFrame;
  if (before && after) {
    keys.push({ frame: from, transform: cloneTf(node.bind), displayIndex: -1, tween: TWEEN_NONE });
  } else if (!after) {
    endFrame = before ? from - 1 : -1;
  }
  return withKeys(t, keys, endFrame);
}

/* ── Edit Multiple Frames ────────────────────────────────────────────────*/

/**
 * The part of `from..to` the track actually shows: from its first key (before
 * it the layer is not on stage, and a key there would make it appear) to its
 * `endFrame`. Null when the two do not overlap.
 */
export function editableSpan(track: Track, from: number, to: number): { from: number; to: number } | null {
  const first = track.keys[0]?.frame ?? 0;
  const a = Math.max(from, first, 0);
  const b = Math.min(to, track.endFrame);
  return a <= b ? { from: a, to: b } : null;
}

/**
 * Keyframes at the edges of `from..to` so that changing every key inside it
 * leaves every frame OUTSIDE it as it was. Each is an F6 (`insertKeyframe`
 * samples what is showing), so the track looks identical afterwards:
 *
 * - `from` and `to`, so the frames inside the range are all governed by keys
 *   that will move;
 * - `to + 1`, because the interval leaving `to` otherwise reaches out of the
 *   range — a hold would show the moved key, a tween would slide towards it;
 * - `from − 1` when the interval before `from` tweens INTO it; a hold there
 *   shows the key it starts from, which does not move.
 *
 * An eased interval is cut with `cutKeepingEase`: F6 alone gives both halves
 * the whole ease, which moves every frame of the interval on either side.
 *
 * `from..to` must already be clipped by `editableSpan`.
 */
export function isolateRange(track: Track, from: number, to: number, node: Node): Track {
  let t = track;
  const cut = (f: number) => {
    const next = cutKeepingEase(t, f, node);
    if (next) t = next;
  };
  cut(from);
  cut(to);
  if (to + 1 <= t.endFrame) cut(to + 1);
  if (from > 0 && keyIndexAt(t, from - 1) < 0) {
    const before = spanKeyAt(t, from - 1);
    if (before && before.tween.kind !== "none") cut(from - 1);
  }
  return t;
}

/** F6 at `frame`, with the interval it cuts eased in two parts that together
 *  run the original curve (`splitTween`). Plain F6 where that cannot be done. */
function cutKeepingEase(track: Track, frame: number, node: Node): Track | null {
  const next = insertKeyframe(track, frame, node);
  const i = spanIndexAt(track, frame);
  const a = track.keys[i];
  const b = track.keys[i + 1];
  if (!next || !a || !b || a.tween.kind === "none") return next;

  const split = (spec: EaseSpec) => splitTween(spec, b.frame - a.frame, frame - a.frame);
  const tween = split(a.tween);
  const eases = a.eases ? Object.entries(a.eases).map(([ch, spec]) => [ch, split(spec)] as const) : [];
  if (!tween || eases.some(([, halves]) => !halves)) return next;
  const halfEases = (n: 0 | 1): ChannelEases | undefined => (a.eases
    ? Object.fromEntries(eases.map(([ch, halves]) => [ch, halves![n]]))
    : undefined);

  return {
    ...next,
    keys: next.keys.map((k) => {
      if (k.frame !== a.frame && k.frame !== frame) return k;
      const n = k.frame === a.frame ? 0 : 1;
      const out: Keyframe = { ...k, tween: tween[n] };
      const e = halfEases(n);
      if (e) out.eases = e;
      return out;
    }),
  };
}

/** Replace the transform of every key in `from..to` with `fn` of it. New key
 *  and transform objects: an earlier `EditTracks` may still hold the old ones. */
export function mapKeyTransforms(
  track: Track, from: number, to: number, fn: (t: Transform) => Transform,
): Track {
  return {
    ...track,
    keys: track.keys.map((k) =>
      (k.frame >= from && k.frame <= to ? { ...k, transform: fn(k.transform) } : k)),
  };
}

const TURN_EPS = 1e-6;

/**
 * Degrees the rotation travels over the interval from `from` to `to`.
 *
 * The one place direction and extra turns are interpreted: the stage sampler
 * and the exporter both go through it, or the preview would spin one way and
 * the stage the other.
 */
export function rotationDelta(from: Keyframe, to: Keyframe): number {
  const keyed = to.transform.skewY - from.transform.skewY;
  const turns = from.rotateTurns ?? 0;
  if (!from.rotateDir) return keyed + 360 * turns;

  let m = ((keyed % 360) + 360) % 360;
  if (m < TURN_EPS || 360 - m < TURN_EPS) m = 0;
  const extra = 360 * Math.abs(Math.round(turns));
  return from.rotateDir === "cw" ? m + extra : (m === 0 ? 0 : m - 360) - extra;
}

/**
 * Raw sample of a track's transform at `frame`, honouring the governing
 * keyframe's tween. Kept here (rather than in interpolate.ts) because
 * insertKeyframe needs it to duplicate mid-tween state faithfully — pressing
 * F6 halfway through a tween must capture what is actually on screen.
 */
export function sampleTransformRaw(track: Track, frame: number) {
  const i = spanIndexAt(track, frame);
  if (i < 0) return null;
  const from = track.keys[i]!;
  const to = track.keys[i + 1];
  if (!to || from.tween.kind === "none" || frame === from.frame) return from.transform;

  const span = to.frame - from.frame;
  if (span <= 0) return from.transform;

  // Each channel follows its own ease, exactly as the exporter splits them
  // into translateFrame / rotateFrame / scaleFrame.
  const progress = (frame - from.frame) / span;
  const pos = easeFor(from, "position", progress, span);
  const rot = easeFor(from, "rotation", progress, span);
  const scl = easeFor(from, "scale", progress, span);
  const a = from.transform, b = to.transform;
  // The same whole-turn offset on both angles: it turns the object and leaves
  // the shear (skewX − skewY) exactly as keyed.
  const offset = rotationDelta(from, to) - (b.skewY - a.skewY);
  const skewYEnd = b.skewY + offset;
  const skewXEnd = b.skewX + offset;
  return {
    x: a.x + (b.x - a.x) * pos,
    y: a.y + (b.y - a.y) * pos,
    skewX: a.skewX + (skewXEnd - a.skewX) * rot,
    skewY: a.skewY + (skewYEnd - a.skewY) * rot,
    scaleX: a.scaleX + (b.scaleX - a.scaleX) * scl,
    scaleY: a.scaleY + (b.scaleY - a.scaleY) * scl,
  };
}

/**
 * Raw sample of a track's colour at `frame`, honouring the same tween as the
 * transform.
 *
 * The exporter emits `colorFrame` WITH `tweenEasing` (see
 * `core/export/frameSplit.ts`), so taking the governing keyframe's colour
 * stepwise here would show a hard cut on the stage where the runtime plays a
 * fade — the one divergence the preview-is-ground-truth rule exists to catch.
 *
 * An absent `color` means DEFAULT_COLOR, matching `colorToJson`'s omissions.
 */
export function sampleColorRaw(track: Track, frame: number): ColorTransform | null {
  // Mirror the exporter's own gate: `buildSlotTimeline` only emits a
  // colorFrame when some keyframe carries a colour, and without one the
  // runtime keeps `slot.color` — the bind colour. Returning null here lets
  // the caller fall back to exactly that.
  if (!track.keys.some((k) => k.color)) return null;

  const i = spanIndexAt(track, frame);
  if (i < 0) return null;
  const from = track.keys[i]!;
  const fromColor = from.color ?? DEFAULT_COLOR;
  const to = track.keys[i + 1];
  if (!to || from.tween.kind === "none" || frame === from.frame) return { ...fromColor };

  const span = to.frame - from.frame;
  if (span <= 0) return { ...fromColor };

  const toColor = to.color ?? DEFAULT_COLOR;
  const eased = easeFor(from, "color", (frame - from.frame) / span, span);
  const out = {} as ColorTransform;
  for (const ch of COLOR_CHANNELS) {
    out[ch] = fromColor[ch] + (toColor[ch] - fromColor[ch]) * eased;
  }
  return out;
}

const COLOR_CHANNELS = ["aM", "rM", "gM", "bM", "aO", "rO", "gO", "bO"] as const;

function easeFor(k: Keyframe, channel: TweenChannel, progress: number, span: number): number {
  return applyTween(easeOf(k, channel), progress, span);
}
