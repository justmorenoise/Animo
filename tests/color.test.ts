import { describe, it, expect } from "vitest";
import {
  parseColor, formatColor, withAlpha, rgbTriplet, shade, inkOn,
} from "@/core/prefs/color";
import { DEFAULT_PREFS } from "@/core/prefs/prefs";

/**
 * One parser for the whole app. Half the palette is translucent by design, so
 * the thing that must never happen is an `rgba()` silently passing through a
 * function that only understands hex — which is exactly what the old
 * `withAlpha` in `overlayColors.ts` did.
 */
describe("colour notations", () => {
  it("round-trips both notations", () => {
    expect(formatColor(parseColor("#0bd"))).toBe("#00bbdd");
    expect(formatColor(parseColor("#00bcd9"))).toBe("#00bcd9");
    expect(formatColor(parseColor("rgb(0, 188, 217)"))).toBe("#00bcd9");
    expect(formatColor(parseColor("rgba(0,188,217,0.45)"))).toBe("rgba(0,188,217,0.45)");
  });

  it("comes back opaque black rather than throwing", () => {
    expect(formatColor(parseColor("not a colour"))).toBe("#000000");
  });

  it("applies an alpha to a colour that already has one", () => {
    expect(withAlpha("rgba(255,214,102,0.9)", 0.42)).toBe("rgba(255,214,102,0.42)");
    expect(withAlpha("#00bcd9", 0.8)).toBe("rgba(0,188,217,0.8)");
    expect(withAlpha("#00bcd9", 1)).toBe("#00bcd9");
  });

  it("gives the triplet `rgba(var(--accent-rgb), a)` needs", () => {
    expect(rgbTriplet(DEFAULT_PREFS.interface.accent)).toBe("0, 188, 217");
    expect(rgbTriplet(DEFAULT_PREFS.interface.accentHot)).toBe("44, 205, 230");
  });
});

describe("shade", () => {
  it("darkens and lightens around the accent", () => {
    const accent = DEFAULT_PREFS.interface.accent;
    expect(shade(accent, -0.38)).toBe("#007587");
    expect(shade(accent, 0.18)).toBe("#2ec8e0");
  });

  it("lands near the hand-picked derived accents", () => {
    const near = (a: string, b: string, tol: number) => {
      const x = parseColor(a), y = parseColor(b);
      return Math.max(Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b)) <= tol;
    };
    const { accent, accentRow, accentHot } = DEFAULT_PREFS.interface;
    expect(near(shade(accent, -0.38), accentRow, 12)).toBe(true);
    expect(near(shade(accent, 0.18), accentHot, 12)).toBe(true);
  });

  it("keeps the alpha and clamps the amount", () => {
    expect(shade("rgba(0,188,217,0.45)", -0.38)).toBe("rgba(0,117,135,0.45)");
    expect(shade("#00bcd9", -2)).toBe("#000000");
    expect(shade("#00bcd9", 2)).toBe("#ffffff");
    expect(shade("#00bcd9", 0)).toBe("#00bcd9");
  });
});

describe("inkOn", () => {
  it("picks the text colour the CSS used to hardcode", () => {
    expect(inkOn(DEFAULT_PREFS.interface.accent)).toBe("#1c1c1c");
    expect(inkOn(DEFAULT_PREFS.interface.accentRow)).toBe("#ffffff");
  });

  it("flips on an accent the other way round", () => {
    expect(inkOn("#ffe08a")).toBe("#1c1c1c");
    expect(inkOn("#1a2b4c")).toBe("#ffffff");
  });
});
