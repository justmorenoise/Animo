import { describe, it, expect, beforeEach } from "vitest";
import { reseed } from "@/core/doc/ids";
import { createNode } from "@/core/doc/defaults";
import { tf } from "@/core/math/Transform";
import { TWEEN_LINEAR, TWEEN_NONE, type TweenSpec } from "@/core/math/easing";
import type { Track, Keyframe, Node } from "@/core/doc/types";
import {
  endAfterResize, resizedEmptyLength,
  insertFrame, insertKeyframe, insertBlankKeyframe, removeFrame, clearKeyframe,
  keyIndexAt, spanIndexAt, occupiesFrame, isTweened, moveKeyframe, moveRange, setEndFrame,
  sampleTransformRaw, sampleColorRaw, spanRange, rotationDelta,
  isolateRange, mapKeyTransforms, editableSpan,
  pasteRun,
} from "@/core/doc/timeline";

let node: Node;
beforeEach(() => { reseed(); node = createNode("image", "img"); });

/** Compact fixture: keyframes at the given frames, span to `endFrame`. */
function track(frames: number[], endFrame: number, tweened = true): Track {
  const keys: Keyframe[] = frames.map((frame) => ({
    frame,
    transform: tf(frame * 10, 0),
    displayIndex: 0,
    tween: tweened ? TWEEN_LINEAR : TWEEN_NONE,
  }));
  return { nodeId: "n1" as Track["nodeId"], keys, endFrame };
}

const at = (t: Track) => t.keys.map((k) => k.frame);

describe("F6 — insert keyframe", () => {
  it("adds a keyframe mid-span, capturing what is on screen", () => {
    const t = insertKeyframe(track([0, 20], 24), 10, node)!;
    expect(at(t)).toEqual([0, 10, 20]);
    // linear tween from x=0 to x=200 over 20 frames -> x=100 at frame 10
    expect(t.keys[1]!.transform.x).toBeCloseTo(100, 9);
  });

  it("captures the held value when the span does not tween", () => {
    const t = insertKeyframe(track([0, 20], 24, false), 10, node)!;
    expect(t.keys[1]!.transform.x).toBe(0);
  });

  it("captures the tweened colour when only the next key carries one", () => {
    const t = track([0, 20], 24);
    t.keys[1]!.color = { aM: 0, rM: 100, gM: 100, bM: 100, aO: 0, rO: 0, gO: 0, bO: 0 };
    const split = insertKeyframe(t, 10, node)!;
    expect(split.keys[1]!.color?.aM).toBeCloseTo(50, 9);
    // The fade itself is unchanged by the cut.
    expect(sampleColorRaw(split, 5)!.aM).toBeCloseTo(sampleColorRaw(t, 5)!.aM, 9);
  });

  it("is a no-op on an existing keyframe", () => {
    expect(insertKeyframe(track([0, 10], 24), 10, node)).toBeNull();
  });

  it("extends the span when placed past the end", () => {
    const t = insertKeyframe(track([0], 5), 12, node)!;
    expect(t.endFrame).toBe(12);
    expect(at(t)).toEqual([0, 12]);
  });
});

describe("F7 — insert blank keyframe", () => {
  it("marks the frame blank with displayIndex -1", () => {
    const t = insertBlankKeyframe(track([0], 24), 8, node)!;
    expect(t.keys[1]!.displayIndex).toBe(-1);
    expect(t.keys[1]!.tween).toEqual(TWEEN_NONE);
  });

  it("replaces an existing keyframe in place rather than duplicating it", () => {
    const t = insertBlankKeyframe(track([0, 8], 24), 8, node)!;
    expect(at(t)).toEqual([0, 8]);
    expect(t.keys[1]!.displayIndex).toBe(-1);
  });
});

describe("F5 — insert frame", () => {
  it("pushes later keyframes right and grows the span", () => {
    const t = insertFrame(track([0, 10, 20], 24), 5);
    expect(at(t)).toEqual([0, 11, 21]);
    expect(t.endFrame).toBe(25);
  });

  it("leaves a keyframe at the insertion point where it is", () => {
    const t = insertFrame(track([0, 10], 24), 10);
    expect(at(t)).toEqual([0, 10]);
    expect(t.endFrame).toBe(25);
  });
});

describe("Shift+F5 — remove frame", () => {
  it("pulls later keyframes left and shrinks the span", () => {
    const t = removeFrame(track([0, 10, 20], 24), 5)!;
    expect(at(t)).toEqual([0, 9, 19]);
    expect(t.endFrame).toBe(23);
  });

  it("absorbs a keyframe that collides with its predecessor", () => {
    const t = removeFrame(track([0, 1, 10], 24), 0)!;
    expect(at(t)).toEqual([0, 9]);
  });

  it("refuses to shrink an already-empty track", () => {
    expect(removeFrame(track([0], 0), 0)).toBeNull();
  });

  it("takes a keyframe on the last frame with it, never leaving a key past the end", () => {
    const t = removeFrame(track([0, 10], 10), 10)!;
    expect(at(t)).toEqual([0]);
    expect(t.endFrame).toBe(9);
  });

  it("removes the content of a one-frame span, not the key after it", () => {
    const t = removeFrame(track([0, 5, 6, 10], 24), 5)!;
    expect(at(t)).toEqual([0, 5, 9]);
    expect(t.keys[1]!.transform.x).toBe(60);   // the key that was at 6
  });

  it("keeps a longer span's keyframe and shrinks the span instead", () => {
    const t = removeFrame(track([0, 5, 10], 24), 5)!;
    expect(at(t)).toEqual([0, 5, 9]);
    expect(t.keys[1]!.transform.x).toBe(50);
  });

  it("leaves a track alone when the frame is past its end", () => {
    expect(removeFrame(track([0, 5], 10), 11)).toBeNull();
    expect(removeFrame(track([0, 5], 10), 30)).toBeNull();
  });
});

describe("Shift+F6 — clear keyframe", () => {
  it("removes the keyframe so the previous span extends through", () => {
    const t = clearKeyframe(track([0, 10, 20], 24), 10)!;
    expect(at(t)).toEqual([0, 20]);
  });

  it("never clears the frame-0 anchor", () => {
    expect(clearKeyframe(track([0, 10], 24), 0)).toBeNull();
  });

  it("is a no-op on a non-keyframe", () => {
    expect(clearKeyframe(track([0, 10], 24), 7)).toBeNull();
  });
});

describe("queries", () => {
  const t = () => track([0, 10, 20], 30);

  it("keyIndexAt finds exact keyframes only", () => {
    expect(keyIndexAt(t(), 10)).toBe(1);
    expect(keyIndexAt(t(), 11)).toBe(-1);
  });

  it("spanIndexAt finds the governing keyframe", () => {
    expect(spanIndexAt(t(), 0)).toBe(0);
    expect(spanIndexAt(t(), 9)).toBe(0);
    expect(spanIndexAt(t(), 10)).toBe(1);
    expect(spanIndexAt(t(), 25)).toBe(2);
  });

  it("spanRange is half-open and the last span runs to endFrame inclusive", () => {
    expect(spanRange(t(), 0)).toEqual({ start: 0, end: 10 });
    expect(spanRange(t(), 2)).toEqual({ start: 20, end: 31 });
  });

  it("occupiesFrame respects the span end", () => {
    expect(occupiesFrame(t(), 30)).toBe(true);
    expect(occupiesFrame(t(), 31)).toBe(false);
    expect(occupiesFrame(t(), -1)).toBe(false);
  });

  it("the final keyframe never reports as tweening", () => {
    expect(isTweened(t(), 0)).toBe(true);
    expect(isTweened(t(), 20)).toBe(false);
  });
});

describe("keyframe moves", () => {
  it("moves a keyframe and refuses collisions", () => {
    expect(at(moveKeyframe(track([0, 10, 20], 24), 10, 14)!)).toEqual([0, 14, 20]);
    expect(moveKeyframe(track([0, 10, 20], 24), 10, 20)).toBeNull();
    expect(moveKeyframe(track([0, 10], 24), 10, -1)).toBeNull();
  });

  it("moveRange overwrites the key it lands on instead of doubling up", () => {
    const t = moveRange(track([0, 10, 20], 24), 10, 10, 10)!;
    expect(at(t)).toEqual([0, 20]);
    expect(t.keys[1]!.transform.x).toBe(100);
  });

  it("moveRange keeps keys that only share a frame with the run's old place", () => {
    const t = moveRange(track([0, 5, 10, 15], 24), 5, 10, 5)!;
    expect(at(t)).toEqual([0, 10, 15]);
    expect(t.keys.map((k) => k.transform.x)).toEqual([0, 50, 100]);
  });

  it("setEndFrame cannot cut below the last keyframe", () => {
    expect(setEndFrame(track([0, 20], 30), 5).endFrame).toBe(20);
  });
});

describe("sampling", () => {
  it("holds through a 'none' tween and interpolates through a linear one", () => {
    expect(sampleTransformRaw(track([0, 10], 24, false), 5)!.x).toBe(0);
    expect(sampleTransformRaw(track([0, 10], 24, true), 5)!.x).toBeCloseTo(50, 9);
  });

  it("adds whole turns from rotateTurns so multi-turn spins interpolate the long way", () => {
    const t = track([0, 12], 24);
    t.keys[0]!.transform = tf(0, 0, 0, 0);
    t.keys[1]!.transform = tf(0, 0, 90, 90);
    t.keys[0]!.rotateTurns = 1;                 // one extra full clockwise turn
    const mid = sampleTransformRaw(t, 6)!;
    expect(mid.skewY).toBeCloseTo((90 + 360) / 2, 9);
  });

  it("turns the way rotateDir says, whatever the keyed angles are", () => {
    const key = (skew: number, extra: Partial<Keyframe> = {}): Keyframe => ({
      frame: 0, transform: tf(0, 0, skew, skew), displayIndex: 0, tween: TWEEN_LINEAR, ...extra,
    });
    expect(rotationDelta(key(10), key(350))).toBeCloseTo(340, 9);
    expect(rotationDelta(key(10, { rotateDir: "cw" }), key(350))).toBeCloseTo(340, 9);
    expect(rotationDelta(key(10, { rotateDir: "ccw" }), key(350))).toBeCloseTo(-20, 9);
    expect(rotationDelta(key(350, { rotateDir: "cw" }), key(10))).toBeCloseTo(20, 9);
    expect(rotationDelta(key(0, { rotateDir: "ccw", rotateTurns: 2 }), key(90))).toBeCloseTo(-270 - 720, 9);
    // A whole number of turns apart is no rotation at all, in either direction.
    expect(rotationDelta(key(0, { rotateDir: "cw" }), key(720))).toBe(0);
    expect(rotationDelta(key(0, { rotateDir: "ccw" }), key(-360))).toBe(0);
    // Files written before rotateDir: signed extra turns on the keyed path.
    expect(rotationDelta(key(0, { rotateTurns: -1 }), key(90))).toBeCloseTo(-270, 9);
  });

  it("samples a counter-clockwise tween the long way round, shear untouched", () => {
    const t = track([0, 12], 24);
    t.keys[0]!.transform = tf(0, 0, 0, 0);
    t.keys[1]!.transform = tf(0, 0, 100, 90);        // 10° of shear at the end
    t.keys[0]!.rotateDir = "ccw";
    const mid = sampleTransformRaw(t, 6)!;
    expect(mid.skewY).toBeCloseTo(-135, 9);
    expect(mid.skewX - mid.skewY).toBeCloseTo(5, 9);
  });

  it("splits a directed multi-turn tween without doubling its turns", () => {
    const t = track([0, 20], 24);
    t.keys[0]!.transform = tf(0, 0, 0, 0);
    t.keys[1]!.transform = tf(0, 0, 90, 90);
    t.keys[0]!.rotateDir = "cw";
    t.keys[0]!.rotateTurns = 1;                      // 450° in total
    const before = [5, 10, 15].map((f) => sampleTransformRaw(t, f)!.skewY);

    const split = insertKeyframe(t, 10, node)!;
    expect(split.keys[0]!.rotateDir).toBeUndefined();
    expect(split.keys[0]!.rotateTurns).toBeUndefined();
    const after = [5, 10, 15].map((f) => sampleTransformRaw(split, f)!.skewY);
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i]!, 9));
  });

  it("returns null before the track's first keyframe", () => {
    const t = track([5, 10], 24);
    expect(sampleTransformRaw(t, 2)).toBeNull();
  });
});

describe("animation length follows the timeline", () => {
  it("grows when a span is extended and shrinks when it is pulled back", async () => {
    const { durationFor } = await import("@/core/history/timelineCommands");
    const anim = { id: "a1" as never, name: "a", duration: 24, playTimes: 0, tracks: {} as Record<string, Track> };

    // Nothing keyed: the stored value stands, because there is nothing to measure.
    expect(durationFor(anim)).toBe(24);

    anim.tracks["n1"] = track([0, 12], 38);
    expect(durationFor(anim)).toBe(39);

    anim.tracks["n2"] = track([0], 10);
    expect(durationFor(anim)).toBe(39);        // the LONGEST layer wins

    anim.tracks["n1"]!.endFrame = 15;
    expect(durationFor(anim)).toBe(16);        // pulled back, so the animation shortens
  });

  it("never reports a zero-length animation", async () => {
    const { durationFor } = await import("@/core/history/timelineCommands");
    const anim = { id: "a1" as never, name: "a", duration: 24, playTimes: 0,
                   tracks: { n1: track([0], 0) } as Record<string, Track> };
    expect(durationFor(anim)).toBe(1);
  });
});

describe("Edit Multiple Frames — isolating a range", () => {
  const shift = (t: Track, from: number, to: number) =>
    mapKeyTransforms(isolateRange(t, from, to, node), from, to, (x) => ({ ...x, x: x.x + 200 }));

  /** x at every frame of the track, the way the stage samples it. */
  const xs = (t: Track) => Array.from({ length: t.endFrame + 1 }, (_, f) => sampleTransformRaw(t, f)!.x);

  it("moves every frame inside the range and none outside it", () => {
    for (const tweened of [true, false]) {
      const base = track([0, 6, 12, 18], 24, tweened);
      const before = xs(base);
      const after = xs(shift(base, 4, 14));
      for (let f = 0; f <= 24; f++) {
        const expected = f >= 4 && f <= 14 ? before[f]! + 200 : before[f]!;
        expect(after[f]).toBeCloseTo(expected, 9);
      }
    }
  });

  it("over the whole animation needs no new keys", () => {
    const base = track([0, 6, 12], 12);
    const moved = shift(base, 0, 12);
    expect(at(moved)).toEqual([0, 6, 12]);
    expect(moved.keys.map((k) => k.transform.x)).toEqual([200, 260, 320]);
  });

  it("does not mutate the keys it replaces", () => {
    const base = track([0, 6], 6);
    shift(base, 0, 6);
    expect(base.keys.map((k) => k.transform.x)).toEqual([0, 60]);
  });

  it("clips to what the track shows", () => {
    const late = track([5, 10], 20);
    expect(editableSpan(late, 0, 30)).toEqual({ from: 5, to: 20 });
    expect(editableSpan(late, 21, 30)).toBeNull();
  });

  it("leaves an eased tween outside the range as it was", () => {
    const eases: TweenSpec[] = [
      { kind: "ease", value: -1 },
      { kind: "ease", value: 0.6 },
      { kind: "ease", value: 2 },
      { kind: "preset", family: "back", dir: "out" },
      { kind: "curve", curve: [0.1, 0.8, 0.3, 1] },
    ];
    for (const tween of eases) {
      const base = track([0, 20], 20);
      base.keys[0]!.tween = tween;
      base.keys[1]!.transform = tf(500, 0);
      const before = xs(base);
      const after = xs(shift(base, 5, 8));
      for (let f = 0; f <= 20; f++) {
        const expected = f >= 5 && f <= 8 ? before[f]! + 200 : before[f]!;
        expect(Math.abs(after[f]! - expected), `${tween.kind} at ${f}`).toBeLessThan(0.05);
      }
    }
  });

  it("splits a per-channel ease like the tween it overrides", () => {
    const base = track([0, 20], 20);
    base.keys[0]!.eases = { position: { kind: "ease", value: -1 } };
    base.keys[1]!.transform = tf(500, 0);
    const before = xs(base);
    const after = xs(shift(base, 5, 8));
    for (const f of [2, 12, 16]) expect(Math.abs(after[f]! - before[f]!)).toBeLessThan(0.05);
  });

  it("keeps a directed tween turning the same way outside the range", () => {
    const base = track([0, 10, 20], 20);
    base.keys[0]!.rotateDir = "cw";
    base.keys[0]!.rotateTurns = 1;
    const angles = (t: Track) => Array.from({ length: 21 }, (_, f) => sampleTransformRaw(t, f)!.skewY);
    const before = angles(base);
    const isolated = isolateRange(base, 12, 20, node);
    const after = angles(isolated);
    for (let f = 0; f <= 20; f++) expect(after[f]).toBeCloseTo(before[f]!, 6);
  });
});

describe("pasteRun", () => {
  const node = createNode("group", "n", { x: 0, y: 0 });
  const run = (y: number): Keyframe[] => [{ frame: 0, transform: tf(0, y), displayIndex: 0, tween: TWEEN_LINEAR }];
  const line = (): Track => ({
    nodeId: node.id, endFrame: 10,
    keys: [
      { frame: 0, transform: tf(0, 0), displayIndex: 0, tween: TWEEN_LINEAR },
      { frame: 10, transform: tf(0, 100), displayIndex: 0, tween: TWEEN_LINEAR },
    ],
  });

  it("inserts: what was there moves right, cut with an F6 so it keeps its pose", () => {
    const out = pasteRun(line(), run(500), 2, 5, "insert", node);
    expect(at(out)).toEqual([0, 5, 7, 12]);
    expect(out.endFrame).toBe(12);
    expect(out.keys[1]!.transform.y).toBe(500);
    expect(out.keys[2]!.transform.y).toBeCloseTo(50, 6);    // what frame 5 showed
  });

  it("inserts past the end without moving anything", () => {
    const out = pasteRun(line(), run(500), 3, 11, "insert", node);
    expect(at(out)).toEqual([0, 10, 11]);
    expect(out.endFrame).toBe(13);
  });

  it("overwrites: what lies under the run is replaced and nothing moves", () => {
    const out = pasteRun(line(), run(500), 2, 9, "overwrite", node);
    expect(at(out)).toEqual([0, 9]);
    expect(out.endFrame).toBe(10);
  });
});

describe("endAfterResize", () => {
  it.each([
    // [keys, endFrame, from, to, expected]
    [[0], 50, 51, 60, 59],          // reached the end: follows it out
    [[0], 50, 51, 30, 29],          // and in
    [[0, 40], 50, 51, 30, 40],      // never before the last key
    [[0], 10, 51, 60, 10],          // ended early: stays where it was
    [[0], 10, 51, 5, 4],            // unless the new end cuts it
    [[0, 8], 10, 51, 5, 8],
  ])("keys %j ending %i, %i → %i frames: %i", (keys, end, from, to, want) => {
    expect(endAfterResize(track(keys, end), from, to)).toBe(want);
  });
});

describe("resizedEmptyLength", () => {
  it.each([
    // [duration, from, delta, expected]
    [1, 99, 1, 100],     // F5 far past the end reaches out to it
    [10, 3, 2, 12],      // inside: grows by the count
    [10, 8, -5, 8],      // removing 8..12 takes only 8 and 9
    [10, 2, -3, 7],
    [10, 10, -3, 10],    // wholly past the end: nothing to take
    [2, 0, -5, 1],       // never below one frame
  ])("%i frames, %i, %i → %i", (duration, from, delta, want) => {
    expect(resizedEmptyLength(duration, from, delta)).toBe(want);
  });
});
