import type { ColorTransform, Keyframe, Node, Track } from "@/core/doc/types";
import { applyTween, easeOf, type TweenChannel, tweenToJson } from "@/core/math/easing";
import { wrapTo180 } from "@/core/math/angle";
import { rotationDelta } from "@/core/doc/timeline";
import type {
    DbBoneTimeline,
    DbColorFrame,
    DbDisplayFrame,
    DbRotateFrame,
    DbScaleFrame,
    DbSlotTimeline,
    DbTranslateFrame,
} from "./dbTypes";

const EPS = 1e-4;

/**
 * Converts the editor's ABSOLUTE keyframes into DragonBones' OFFSET frames.
 *
 * The runtime composes a bone as
 *   global = origin + offset + animationPose      (additive)
 *   scale  = origin * offset * animationPose      (multiplicative)
 * so every frame value here is a delta from the bind pose.
 *
 * Two details are the usual sources of silent breakage:
 *
 *  1. `rotateFrame.skew` is a delta in (skX − skY), NOT a delta in skX. Get
 *     it backwards and the rig looks perfect in its bind pose and shears
 *     progressively as soon as it animates.
 *
 *  2. `tweenEasing` ABSENT means "no tween"; `0` means linear. Emitting 0
 *     where you meant absent turns every hold into a slide.
 */

/** Milestone note: this is the provably lossless split — every editor
 *  keyframe is emitted into every channel that changes at all. Dropping
 *  redundant intermediate frames is an optimisation for later, and this
 *  version is its oracle. */
export function buildBoneTimeline(
  track: Track, node: Node, animDuration: number,
): DbBoneTimeline | null {
  const keys = track.keys;
  if (keys.length === 0) return null;
  const bind = node.bind;

  // Unwrapped rotation targets, accumulated interval by interval so the
  // direction and extra turns set on a key reach the file.
  const rot: number[] = [];
  const skew: number[] = [];
  keys.forEach((k, i) => {
    rot.push(i === 0
      ? k.transform.skewY - bind.skewY
      : rot[i - 1]! + rotationDelta(keys[i - 1]!, k));
    skew.push((k.transform.skewX - k.transform.skewY) - (bind.skewX - bind.skewY));
  });

  const usesTranslate = keys.some((k) =>
    Math.abs(k.transform.x - bind.x) > EPS || Math.abs(k.transform.y - bind.y) > EPS);
  const usesRotate = rot.some((v) => Math.abs(v) > EPS) || skew.some((v) => Math.abs(v) > EPS);
  const usesScale = keys.some((k) =>
    Math.abs(k.transform.scaleX / (bind.scaleX || 1) - 1) > EPS ||
    Math.abs(k.transform.scaleY / (bind.scaleY || 1) - 1) > EPS);

  if (!usesTranslate && !usesRotate && !usesScale) return null;

  const out: DbBoneTimeline = { name: node.name };

  if (usesTranslate) {
    out.translateFrame = emitFrames<DbTranslateFrame>(
      "position", keys, animDuration,
      (k) => ({
        x: round2(k.transform.x - bind.x),
        y: round2(k.transform.y - bind.y),
      }),
      (a, b, t) => ({
        x: round2(lerp(a.x ?? 0, b.x ?? 0, t)),
        y: round2(lerp(a.y ?? 0, b.y ?? 0, t)),
      }),
      dropZeros,
      undefined,
      { x: 0, y: 0 },
    );
  }

  if (usesRotate) {
    out.rotateFrame = emitFrames<DbRotateFrame>(
      "rotation", keys, animDuration,
      (_k, i) => ({ rotate: round4(rot[i]!), skew: round4(skew[i]!) }),
      (a, b, t) => ({
        rotate: round4(lerp(a.rotate ?? 0, b.rotate ?? 0, t)),
        skew: round4(lerp(a.skew ?? 0, b.skew ?? 0, t)),
      }),
      dropZeros,
      // The runtime reconstructs rotation by taking the SHORTEST path from
      // the previous frame, so any interval wider than half a turn has to be
      // subdivided or the spin silently collapses to its short way round.
      (a, b) => Math.abs((b.rotate ?? 0) - (a.rotate ?? 0)) > 170,
      { rotate: 0, skew: 0 },
    );
  }

  if (usesScale) {
    out.scaleFrame = emitFrames<DbScaleFrame>(
      "scale", keys, animDuration,
      (k) => ({
        x: round4(k.transform.scaleX / (bind.scaleX || 1)),
        y: round4(k.transform.scaleY / (bind.scaleY || 1)),
      }),
      (a, b, t) => ({
        x: round4(lerp(a.x ?? 1, b.x ?? 1, t)),
        y: round4(lerp(a.y ?? 1, b.y ?? 1, t)),
      }),
      (f) => {
        // Scale frames default to 1, not 0.
        const o = { ...f };
        if (Math.abs((o.x ?? 1) - 1) < EPS) delete o.x;
        if (Math.abs((o.y ?? 1) - 1) < EPS) delete o.y;
        return o;
      },
      undefined,
      { x: 1, y: 1 },
    );
  }

  return out;
}

/**
 * Shared frame emitter.
 *
 * Positions come from the editor keyframes, plus a terminal frame at the
 * animation's end so the sequence closes the way DragonBones Pro's output
 * does. Durations are the gaps between positions; the terminal frame has
 * duration 0.
 *
 * The runtime places frames by summing durations FROM 0, so a track whose
 * first key comes later gets a leading hold: `rest` when given (the bind
 * pose, which is what the stage composes children against before the track
 * starts), otherwise the first key's own value.
 */
function emitFrames<T extends { duration?: number; tweenEasing?: number; curve?: number[] }>(
  channel: TweenChannel,
  keys: Keyframe[],
  animDuration: number,
  valueAt: (k: Keyframe, i: number) => Omit<T, "duration" | "tweenEasing" | "curve">,
  interpolate: (a: T, b: T, t: number) => Omit<T, "duration" | "tweenEasing" | "curve">,
  prune: (f: T) => T,
  needsSplit?: (a: T, b: T) => boolean,
  rest?: Omit<T, "duration" | "tweenEasing" | "curve">,
): T[] {
  type Row = { frame: number; value: T; tween: Keyframe["tween"] | null };
  const rows: Row[] = keys.map((k, i) => ({
    frame: k.frame,
    value: { ...(valueAt(k, i) as object) } as T,
    tween: easeOf(k, channel),
  }));
  const first = rows[0]!;
  if (first.frame > 0) {
    rows.unshift({ frame: 0, value: { ...((rest ?? first.value) as object) } as T, tween: null });
  }

  // Subdivide intervals the runtime could not reconstruct. A hold has no path
  // to reconstruct — the runtime jumps to the next key — and splitting one
  // into linear pieces would make its last piece slide.
  if (needsSplit) {
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i]!, b = rows[i + 1]!;
      if (!a.tween || a.tween.kind === "none") continue;
      if (!needsSplit(a.value, b.value)) continue;
      const span = b.frame - a.frame;
      if (span <= 1) continue;

      // Enough pieces that no piece exceeds the reconstructable limit. An
      // eased interval is cut at EVERY frame: the pieces tween linearly, so
      // any frame left inside one would show a straight line where the
      // stage shows the ease.
      const tween = a.tween;
      const eased = tween.kind !== "linear";
      const pieces = eased
        ? span
        : Math.min(span, Math.max(2, Math.ceil(magnitude(a.value, b.value) / 170)));
      const inserted: Row[] = [];
      for (let p = 1; p < pieces; p++) {
        const frame = a.frame + Math.round((span * p) / pieces);
        if (frame <= a.frame || frame >= b.frame) continue;
        // Sample the ORIGINAL tween so the inserted frames sit on the curve
        // the user authored; each piece then tweens linearly between them.
        const t = applyTween(tween, (frame - a.frame) / span, span);
        inserted.push({
          frame,
          value: { ...(interpolate(a.value, b.value, t) as object) } as T,
          tween: { kind: "linear" },
        });
      }
      if (inserted.length) {
        a.tween = { kind: "linear" };
        rows.splice(i + 1, 0, ...inserted);
        i += inserted.length;
      }
    }
  }

  // Close the animation with a terminal frame when the last key stops short.
  const last = rows[rows.length - 1]!;
  if (last.frame < animDuration) {
    rows.push({ frame: animDuration, value: { ...(last.value as object) } as T, tween: null });
  }

  const out: T[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const next = rows[i + 1];
    const frame = prune(row.value);
    const duration = next ? next.frame - row.frame : 0;
    if (duration !== 1) frame.duration = duration;

    // The terminal frame governs nothing, so it carries no tween.
    if (next && row.tween) {
      const t = tweenToJson(row.tween, duration);
      if (t.tweenEasing !== undefined) frame.tweenEasing = t.tweenEasing;
      if (t.curve) frame.curve = t.curve;
    }
    out.push(frame);
  }
  return out;
}

function magnitude<T extends object>(a: T, b: T): number {
  const ar = (a as { rotate?: number }).rotate ?? 0;
  const br = (b as { rotate?: number }).rotate ?? 0;
  return Math.abs(br - ar);
}

/* ── Slot timelines ──────────────────────────────────────────────────────*/

/** `displays` maps a key's `displayIndex` to its place in the exported
 *  display list (see `exportedDisplays`); -1 and unmapped indices hide. */
export function buildSlotTimeline(
  track: Track, slotName: string, animDuration: number,
  displays?: Map<number, number>,
): DbSlotTimeline | null {
  if (track.keys.length === 0) return null;
  const keys = displays
    ? track.keys.map((k) => ({ ...k, displayIndex: k.displayIndex < 0 ? -1 : displays.get(k.displayIndex) ?? -1 }))
    : track.keys;

  // Outside its span the stage shows nothing (`pose.localAt`), so a track that
  // starts late or ends early needs a display timeline to hide the slot too.
  const startsLate = keys[0]!.frame > 0;
  const endsEarly = track.endFrame + 1 < animDuration;
  const usesDisplay = startsLate || endsEarly || keys.some((k) => k.displayIndex !== 0);
  // An AUTHORED colour anywhere means the timeline governs, even if it is the
  // identity: with a non-default `slot.color` in the setup pose, a keyframe
  // that deliberately returns to neutral must still be emitted, or the runtime
  // would keep the bind tint. `pose.sampleColorRaw` gates on the same rule.
  const usesColor = keys.some((k) => k.color !== undefined);
  if (!usesDisplay && !usesColor) return null;

  const out: DbSlotTimeline = { name: slotName };

  if (usesDisplay) {
    const frames: DbDisplayFrame[] = [];
    const rows = keys.map((k) => ({ frame: k.frame, value: k.displayIndex }));
    if (startsLate) rows.unshift({ frame: 0, value: -1 });
    if (endsEarly) rows.push({ frame: track.endFrame + 1, value: -1 });
    const lastRow = rows[rows.length - 1]!;
    if (lastRow.frame < animDuration) rows.push({ frame: animDuration, value: lastRow.value });
    for (let i = 0; i < rows.length; i++) {
      const duration = rows[i + 1] ? rows[i + 1]!.frame - rows[i]!.frame : 0;
      const f: DbDisplayFrame = {};
      if (duration !== 1) f.duration = duration;
      if (rows[i]!.value !== 0) f.value = rows[i]!.value;
      frames.push(f);
    }
    out.displayFrame = frames;
  }

  if (usesColor) {
    out.colorFrame = emitFrames<DbColorFrame>(
      "color", keys, animDuration,
      (k) => ({ color: colorToJson(k.color) }),
      (a, b, t) => ({
        color: lerpColor(
          (a.color ?? {}) as Record<string, number>,
          (b.color ?? {}) as Record<string, number>,
          t,
        ),
      }),
      (f) => f,
    );
  }

  return out;
}

function colorToJson(c: ColorTransform | undefined): Record<string, number> {
  if (!c) return {};
  const out: Record<string, number> = {};
  if (c.aM !== 100) out.aM = c.aM;
  if (c.rM !== 100) out.rM = c.rM;
  if (c.gM !== 100) out.gM = c.gM;
  if (c.bM !== 100) out.bM = c.bM;
  if (c.aO !== 0) out.aO = c.aO;
  if (c.rO !== 0) out.rO = c.rO;
  if (c.gO !== 0) out.gO = c.gO;
  if (c.bO !== 0) out.bO = c.bO;
  return out;
}

function lerpColor(
  a: Record<string, number>, b: Record<string, number>, t: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ["aM", "rM", "gM", "bM"]) {
    const va = a[k] ?? 100, vb = b[k] ?? 100;
    const v = Math.round(lerp(va, vb, t));
    if (v !== 100) out[k] = v;
  }
  for (const k of ["aO", "rO", "gO", "bO"]) {
    const va = a[k] ?? 0, vb = b[k] ?? 0;
    const v = Math.round(lerp(va, vb, t));
    if (v !== 0) out[k] = v;
  }
  return out;
}

/* ── helpers ─────────────────────────────────────────────────────────────*/

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

function dropZeros<T extends object>(f: T): T {
  const o = { ...f } as Record<string, unknown>;
  for (const k of ["x", "y", "rotate", "skew"]) {
    if (typeof o[k] === "number" && Math.abs(o[k] as number) < EPS) delete o[k];
  }
  return o as T;
}

function round2(v: number): number { const r = Math.round(v * 100) / 100; return r === 0 ? 0 : r; }
function round4(v: number): number { const r = Math.round(v * 10000) / 10000; return r === 0 ? 0 : r; }

export { wrapTo180 };
