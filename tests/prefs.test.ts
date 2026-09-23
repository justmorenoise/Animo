import { describe, it, expect } from "vitest";
import {
  DEFAULT_PREFS, mergePrefs, resetCategory, clampPref,
} from "@/core/prefs/prefs";

/**
 * The preferences live in localStorage, so the blob being read back is
 * whatever an older build — or a hand edit — left there. `mergePrefs` is the
 * migration: it must never refuse to start, and never let one bad value cost
 * the user every other setting.
 */
describe("mergePrefs", () => {
  it("returns the defaults for nothing at all", () => {
    expect(mergePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(mergePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(mergePrefs("not an object")).toEqual(DEFAULT_PREFS);
    expect(mergePrefs(42)).toEqual(DEFAULT_PREFS);
  });

  it("fills in categories and keys a stored blob does not have", () => {
    const p = mergePrefs({ stage: { gridSize: 32 } });
    expect(p.stage.gridSize).toBe(32);
    expect(p.stage.gridSubdivisions).toBe(DEFAULT_PREFS.stage.gridSubdivisions);
    expect(p.snap).toEqual(DEFAULT_PREFS.snap);
  });

  it("ignores unknown keys and categories rather than carrying them", () => {
    const p = mergePrefs({ stage: { gridSize: 32, wobble: 3 }, nonsense: { a: 1 } });
    expect(p.stage.gridSize).toBe(32);
    expect(Object.keys(p)).toEqual(Object.keys(DEFAULT_PREFS));
    expect("wobble" in p.stage).toBe(false);
  });

  it("drops values of the wrong type", () => {
    const p = mergePrefs({ stage: { gridSize: "big" }, snap: { enabled: 1 } });
    expect(p.stage.gridSize).toBe(DEFAULT_PREFS.stage.gridSize);
    expect(p.snap.enabled).toBe(DEFAULT_PREFS.snap.enabled);
  });

  it("clamps numbers into a range the UI can get back out of", () => {
    const p = mergePrefs({
      stage: { gridSize: 0 },
      snap: { tolerancePx: 10_000 },
      timeline: { onionAfter: 500 },
    });
    expect(p.stage.gridSize).toBe(1);
    expect(p.snap.tolerancePx).toBe(64);
    expect(p.timeline.onionAfter).toBe(100);
  });

  it("keeps a choice inside its list", () => {
    expect(mergePrefs({ interface: { fontSize: "large" } }).interface.fontSize).toBe("large");
    // A colour is free text — a bad one costs that swatch — but a font size
    // outside the four steps has no UI to get back out of.
    expect(mergePrefs({ interface: { fontSize: "huge" } }).interface.fontSize).toBe("small");
    expect(mergePrefs({ interface: { accent: "nonsense" } }).interface.accent).toBe("nonsense");
  });

  it("gives an older blob the accents it was saved without", () => {
    const p = mergePrefs({ interface: { accent: "#7a3fd0" } });
    expect(p.interface.accent).toBe("#7a3fd0");
    expect(p.interface.accentRow).toBe(DEFAULT_PREFS.interface.accentRow);
    expect(p.interface.accentHot).toBe(DEFAULT_PREFS.interface.accentHot);
    expect(p.interface.warn).toBe(DEFAULT_PREFS.interface.warn);
    expect(p.interface.fontSize).toBe("small");
  });

  it("migrates the symmetric onionRange of older builds onto both markers", () => {
    const p = mergePrefs({ timeline: { onionRange: 5 } });
    expect(p.timeline.onionBefore).toBe(5);
    expect(p.timeline.onionAfter).toBe(5);
    const q = mergePrefs({ timeline: { onionRange: 5, onionAfter: 1 } });
    expect(q.timeline.onionBefore).toBe(5);
    expect(q.timeline.onionAfter).toBe(1);
    expect(mergePrefs({ timeline: { onionRange: -4 } }).timeline.onionBefore).toBe(0);
  });

  it("drops NaN and Infinity", () => {
    const p = mergePrefs({ stage: { gridSize: NaN }, snap: { tolerancePx: Infinity } });
    expect(p.stage.gridSize).toBe(DEFAULT_PREFS.stage.gridSize);
    expect(p.snap.tolerancePx).toBe(DEFAULT_PREFS.snap.tolerancePx);
  });

  it("does not alias the defaults", () => {
    const p = mergePrefs(null);
    p.stage.gridSize = 999;
    expect(DEFAULT_PREFS.stage.gridSize).toBe(20);
  });
});

describe("resetCategory", () => {
  it("restores one category and leaves the others alone", () => {
    const edited = mergePrefs({
      stage: { gridSize: 32 },
      snap: { tolerancePx: 20 },
    });
    const p = resetCategory(edited, "stage");
    expect(p.stage).toEqual(DEFAULT_PREFS.stage);
    expect(p.snap.tolerancePx).toBe(20);
  });
});

describe("clampPref", () => {
  it("passes through anything with no declared range", () => {
    expect(clampPref("stage.gridColor", 12)).toBe(12);
  });
});

describe("the IK re-parent guard preference", () => {
  it("is on by default and survives a stored false", async () => {
    const { mergePrefs, DEFAULT_PREFS } = await import("@/core/prefs/prefs");
    expect(DEFAULT_PREFS.general.guardIkReparent).toBe(true);
    expect(mergePrefs({ general: { guardIkReparent: false } }).general.guardIkReparent).toBe(false);
    expect(mergePrefs({ general: {} }).general.guardIkReparent).toBe(true);
  });
});
