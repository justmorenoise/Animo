import { describe, it, expect } from "vitest";
import { oversizeAdvice, regionFits } from "@/core/atlas/oversize";
import { DEFAULT_PACK, packRects } from "@/core/atlas/MaxRectsPacker";
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from "@/core/export/settings";

const S = (o: Partial<ExportSettings> = {}): ExportSettings => ({ ...DEFAULT_EXPORT_SETTINGS, ...o });

describe("regionFits agrees with the packer", () => {
  it.each([[2044, true], [2045, false]])("a %i px region on a 2048 page, padding 2 → %s", (w, fits) => {
    const page = { ...DEFAULT_PACK, maxWidth: 2048, maxHeight: 2048, padding: 2 };
    expect(regionFits(w, 10, page)).toBe(fits);
    const pack = () => packRects([{ id: "a", width: w, height: 10 }], page);
    if (fits) expect(pack).not.toThrow(); else expect(pack).toThrow();
  });
});

describe("oversizeAdvice", () => {
  it("names the image and suggests only fixes that fit (intro.psd's 8885 × 2871 layer)", () => {
    const a = oversizeAdvice([{ name: "s2t", width: 8885, height: 2871 }], S());
    // (2048 - 2·2 padding - 2·1 extrude) / 8885 = 22.98% → 22%.
    expect(a.fitScale).toBe(0.22);
    expect(a.fitPage).toBeNull();                    // past the 8192 maximum
    expect(a.title).toBe("Image too large for the atlas");
    expect(a.message).toContain('"s2t" is 8885 × 2871 px');
    expect(a.message).toContain("22% or less");
    expect(a.message).not.toContain("|");            // no internal region keys
    expect(a.message).not.toContain("maximum page size");
  });

  it("suggests a page size when one within the limit holds everything, rounded to a power of two", () => {
    const a = oversizeAdvice([{ name: "bg", width: 3000, height: 1000 }], S({ powerOfTwo: true }));
    expect(a.fitPage).toEqual({ w: 4096, h: 2048 });
    expect(a.message).toContain("4096 × 2048 px");
  });

  it("works from the current texture scale and lists several images", () => {
    const a = oversizeAdvice(
      [{ name: "a", width: 6000, height: 100 }, { name: "b", width: 100, height: 5000 }], S({ scale: 0.5 }),
    );
    expect(a.title).toBe("Images too large for the atlas");
    expect(a.message).toContain("• a, 6000 × 100 px (3000 × 50 at the 50% texture scale)");
    expect(a.fitScale).toBe(0.34);                   // 2042 / 6000
    expect(a.fitPage).toEqual({ w: 3006, h: 2506 });
  });
});
