/**
 * Onion skin: which frames lie between the markers, which of them to draw
 * behind the current one, and how faintly.
 *
 * Pure and separate from the viewport and the frame grid so the range
 * arithmetic — following vs anchored markers, clamping at both ends of the
 * animation, the three marker drags, never re-drawing the current frame — can
 * be tested without a canvas.
 */
export interface OnionFrame {
  frame: number;
  alpha: number;
  side: "past" | "future";
}

export interface OnionSpan {
  start: number;
  end: number;
}

export interface OnionRangePrefs {
  onionBefore: number;
  onionAfter: number;
}

/**
 * The frames between the markers. Following markers sit `onionBefore` /
 * `onionAfter` frames either side of the playhead; anchored ones stay where
 * they were put. Either way the span is clamped to `0..maxFrame`.
 */
export function onionSpan(
  frame: number, maxFrame: number, prefs: OnionRangePrefs, anchor: OnionSpan | null,
): OnionSpan {
  const top = Math.max(0, maxFrame);
  const clamp = (f: number) => Math.max(0, Math.min(top, Math.round(f)));
  if (anchor) {
    const a = clamp(Math.min(anchor.start, anchor.end));
    const b = clamp(Math.max(anchor.start, anchor.end));
    return { start: a, end: b };
  }
  return { start: clamp(frame - prefs.onionBefore), end: clamp(frame + prefs.onionAfter) };
}

export interface OnionFramesArgs {
  frame: number;
  span: OnionSpan;
  /** Opacity of the nearest ghost. */
  opacity: number;
  /** Fraction each further frame loses. */
  falloff: number;
  /** Given, only frames it accepts are drawn ("Keyframes only"). */
  isKey?: (frame: number) => boolean;
}

/**
 * Every frame of the span except the current one, farthest first so the
 * nearest paint on top of the fainter ones, fading with
 * distance: `opacity · (1 − falloff)^(d − 1)`. The current frame is never
 * included — it is drawn opaque by the renderer afterwards, and a ghost
 * underneath it would only darken it. With `isKey`, distance still counts
 * frames rather than keys, so a ghost's faintness says how far away it is.
 */
export function onionFrames(a: OnionFramesArgs): OnionFrame[] {
  const out: OnionFrame[] = [];
  const reach = Math.max(a.frame - a.span.start, a.span.end - a.frame);
  for (let d = reach; d >= 1; d--) {
    const alpha = a.opacity * Math.pow(1 - a.falloff, d - 1);
    for (const f of [a.frame - d, a.frame + d]) {
      if (f < a.span.start || f > a.span.end) continue;
      if (a.isKey && !a.isKey(f)) continue;
      out.push({ frame: f, alpha, side: f < a.frame ? "past" : "future" });
    }
  }
  return out;
}

export type MarkerDrag = "start" | "end" | "both" | "range";

/**
 * Where the markers go after dragging `which` by `delta` frames from `base`
 * (the span at pointer-down). `both` is ⌘-drag: the start marker moves by
 * `-delta` while the end moves by `delta`, so the range grows or shrinks
 * symmetrically. `range` is ⇧-drag: the whole span slides.
 *
 * `playhead` is given when the markers FOLLOW the playhead: a following range
 * has to keep containing it, because what it stores is two distances from it.
 */
export function dragMarkers(
  base: OnionSpan, which: MarkerDrag, delta: number, maxFrame: number, playhead?: number,
): OnionSpan {
  const top = Math.max(0, maxFrame);
  let { start, end } = base;
  switch (which) {
    case "start": start = base.start + delta; break;
    case "end": end = base.end + delta; break;
    case "both": start = base.start - delta; end = base.end + delta; break;
    case "range": {
      const width = base.end - base.start;
      let d = delta;
      d = Math.max(-base.start, Math.min(top - base.end, d));
      if (playhead !== undefined) {
        d = Math.max(playhead - base.end, Math.min(playhead - base.start, d));
      }
      return { start: base.start + d, end: base.start + d + width };
    }
  }
  start = Math.max(0, Math.min(top, start));
  end = Math.max(0, Math.min(top, end));
  if (playhead !== undefined) {
    start = Math.min(start, playhead);
    end = Math.max(end, playhead);
  }
  if (start > end) {
    if (which === "start") start = end; else end = start;
  }
  return { start, end };
}
