import { describe, it, expect } from "vitest";
import { UI_FONT_SIZES, UI_FONT_SCALES, uiPx, uiFont } from "@/core/prefs/fonts";
import { DEFAULT_PREFS } from "@/core/prefs/prefs";

/** The bases the app actually uses: the CSS size tokens, the row heights and
 *  the canvas labels. */
const BASES = [7, 8, 9, 10, 11, 12, 13, 15, 16, 18, 19, 20, 21, 22, 23, 24, 26];

describe("the UI text scale", () => {
  it("leaves every measure untouched at the default", () => {
    expect(DEFAULT_PREFS.interface.fontSize).toBe("small");
    expect(UI_FONT_SCALES.small).toBe(1);
    for (const base of BASES) expect(uiPx(base, "small")).toBe(base);
  });

  it("grows step by step and never goes illegible", () => {
    for (const base of BASES) {
      const [tiny, small, medium, large] = UI_FONT_SIZES.map((s) => uiPx(base, s));
      expect(tiny!).toBeLessThanOrEqual(small!);
      expect(small!).toBeLessThanOrEqual(medium!);
      expect(medium!).toBeLessThanOrEqual(large!);
      expect(tiny!).toBeGreaterThanOrEqual(6);
    }
    expect(uiPx(7, "tiny")).toBe(6);
  });

  it("builds a canvas font string, with and without a weight", () => {
    expect(uiFont(9, "small")).toMatch(/^9px /);
    expect(uiFont(10, "large", 600)).toMatch(/^600 13px /);
  });
});
