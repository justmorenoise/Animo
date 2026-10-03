import { describe, expect, it } from "vitest";
import { createNode } from "@/core/doc/defaults";
import { tf } from "@/core/math/Transform";
import { TWEEN_LINEAR, TWEEN_NONE } from "@/core/math/easing";
import type { Keyframe, Node, Track } from "@/core/doc/types";
import {
  emptyRange, insertFrame, insertKeyframe, isolateRange, pasteRun, removeFrame, sampleTransformRaw, showsAt,
} from "@/core/doc/timeline";

/**
 * What the frame operations promise about the frames they do not act on, over
 * seeded random tracks: blank spans, late starts, early ends, tweens. Each
 * failure prints its seed. The rules:
 *
 * - Paste and Overwrite: outside the run, every frame shows (or not) as before.
 * - Paste (insert): before the run as before; after it, what was `span` frames earlier.
 * - A frame drag's emptying (`emptyRange`): outside the range as before, inside nothing.
 * - F5 and ⇧F5 inside a track shift what follows by one frame; F6 and `isolateRange` change no frame.
 */

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const LAST = 40;
const node: Node = { ...createNode("image", "n"), itemId: "i_art" as Node["itemId"] };

function randomKeys(r: () => number, from: number, to: number): Keyframe[] {
  const keys: Keyframe[] = [];
  for (let f = from; f <= to; f++) {
    if (f !== from && r() > 0.25) continue;
    keys.push({
      frame: f,
      transform: tf(Math.round(r() * 100), Math.round(r() * 100)),
      displayIndex: r() < 0.3 ? -1 : 0,
      tween: r() < 0.5 ? TWEEN_LINEAR : TWEEN_NONE,
    });
  }
  return keys;
}

function randomTrack(r: () => number): Track {
  const first = r() < 0.4 ? Math.floor(r() * 10) : 0;
  const endFrame = first + Math.floor(r() * 25);
  return { nodeId: node.id, keys: randomKeys(r, first, endFrame), endFrame };
}

const shows = (t: Track, f: number) => showsAt(t, f);
const frames = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe("frame operations keep the frames they do not act on", () => {
  it.each(SEEDS)("Paste and Overwrite, seed %i", (seed) => {
    const r = prng(seed);
    const t = randomTrack(r);
    const span = 1 + Math.floor(r() * 6);
    const at = Math.floor(r() * 35);
    const out = pasteRun(t, randomKeys(r, 0, span - 1), span, at, "overwrite", node);
    for (const f of frames(0, LAST)) {
      if (f >= at && f < at + span) continue;
      expect(shows(out, f), `frame ${f}`).toBe(shows(t, f));
    }
  });

  it.each(SEEDS)("Paste, seed %i", (seed) => {
    const r = prng(seed);
    const t = randomTrack(r);
    const span = 1 + Math.floor(r() * 6);
    const at = Math.floor(r() * 35);
    const out = pasteRun(t, randomKeys(r, 0, span - 1), span, at, "insert", node);
    for (const f of frames(0, at - 1)) expect(shows(out, f), `frame ${f}`).toBe(shows(t, f));
    for (const f of frames(at + span, LAST)) expect(shows(out, f), `frame ${f}`).toBe(shows(t, f - span));
  });

  it.each(SEEDS)("emptying a dragged range, seed %i", (seed) => {
    const r = prng(seed);
    const t = randomTrack(r);
    const from = Math.floor(r() * 30);
    const to = from + Math.floor(r() * 8);
    const out = emptyRange(t, from, to, node) ?? t;
    for (const f of frames(0, LAST)) expect(shows(out, f), `frame ${f}`).toBe(f >= from && f <= to ? false : shows(t, f));
  });

  it.each(SEEDS)("F5, ⇧F5, F6 and isolateRange, seed %i", (seed) => {
    const r = prng(seed);
    const t = randomTrack(r);
    const at = Math.floor(r() * 30);

    // Past the end F5 reaches out to `at`, which is what it is for there.
    if (at <= t.endFrame) {
      const inserted = insertFrame(t, at);
      for (const f of frames(0, at)) expect(shows(inserted, f), `F5 frame ${f}`).toBe(shows(t, f));
      for (const f of frames(at + 2, LAST)) expect(shows(inserted, f), `F5 frame ${f}`).toBe(shows(t, f - 1));
    }

    const removed = removeFrame(t, at);
    if (removed) {
      for (const f of frames(0, at - 1)) expect(shows(removed, f), `⇧F5 frame ${f}`).toBe(shows(t, f));
      for (const f of frames(at, LAST - 1)) expect(shows(removed, f), `⇧F5 frame ${f}`).toBe(shows(t, f + 1));
    }

    if (shows(t, at) || (at <= t.endFrame && at >= t.keys[0]!.frame)) {
      const keyed = insertKeyframe(t, at, node) ?? t;
      for (const f of frames(0, LAST)) expect(shows(keyed, f), `F6 frame ${f}`).toBe(shows(t, f));
    }

    const from = Math.max(at, t.keys[0]!.frame);
    const to = Math.min(from + Math.floor(r() * 6), t.endFrame);
    if (from <= to) {
      const isolated = isolateRange(t, from, to, node);
      for (const f of frames(0, LAST)) {
        expect(shows(isolated, f), `isolate frame ${f}`).toBe(shows(t, f));
        if (shows(t, f)) expect(sampleTransformRaw(isolated, f)!.x, `isolate pose ${f}`).toBeCloseTo(sampleTransformRaw(t, f)!.x, 6);
      }
    }
  });
});
