import { describe, it, expect } from "vitest";
import { packRects, DEFAULT_PACK, type PackInput, type PackPage } from "@/core/atlas/MaxRectsPacker";
import { alphaBounds } from "@/core/atlas/trim";

function rects(n: number, w: number, h: number, prefix = "r"): PackInput[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, width: w, height: h }));
}

/** No two placed rects may overlap, and all must sit inside the page. */
function assertValid(page: PackPage, padding: number): void {
  for (const r of page.rects) {
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    const w = r.rotated ? r.height : r.width;
    const h = r.rotated ? r.width : r.height;
    expect(r.x + w).toBeLessThanOrEqual(page.width);
    expect(r.y + h).toBeLessThanOrEqual(page.height);
  }
  for (let i = 0; i < page.rects.length; i++) {
    for (let j = i + 1; j < page.rects.length; j++) {
      const a = page.rects[i]!, b = page.rects[j]!;
      const aw = (a.rotated ? a.height : a.width) + padding;
      const ah = (a.rotated ? a.width : a.height) + padding;
      const bw = b.rotated ? b.height : b.width;
      const bh = b.rotated ? b.width : b.height;
      const overlap = a.x < b.x + bw && b.x < a.x + aw && a.y < b.y + bh && b.y < a.y + ah;
      expect(overlap).toBe(false);
    }
  }
}

describe("MaxRects packer", () => {
  it("places everything on one page without overlaps", () => {
    const items = [
      ...rects(6, 90, 130, "big"),
      ...rects(20, 26, 96, "thin"),
      ...rects(30, 12, 12, "tiny"),
    ];
    const pages = packRects(items, DEFAULT_PACK);
    expect(pages.length).toBe(1);
    expect(pages[0]!.rects.length).toBe(items.length);
    assertValid(pages[0]!, DEFAULT_PACK.padding);
  });

  it("produces a compact page rather than a thin strip", () => {
    // The failure this guards: packing into a full-size page and cropping
    // afterwards lays everything out in one column.
    const items = [
      { id: "torso", width: 90, height: 130 },
      { id: "head", width: 74, height: 74 },
      { id: "arm", width: 26, height: 96 },
      { id: "leg", width: 30, height: 110 },
    ];
    const page = packRects(items, DEFAULT_PACK)[0]!;
    const aspect = Math.max(page.width, page.height) / Math.min(page.width, page.height);
    expect(aspect).toBeLessThan(2);

    const used = items.reduce((n, i) => n + i.width * i.height, 0);
    expect(used / (page.width * page.height)).toBeGreaterThan(0.5);
  });

  it("is deterministic across runs and input order", () => {
    const items = [
      ...rects(10, 40, 55, "a"),
      ...rects(10, 17, 90, "b"),
      ...rects(10, 63, 21, "c"),
    ];
    const key = (p: PackPage[]) =>
      JSON.stringify(p.map((x) => [x.width, x.height, [...x.rects].map((r) => [r.id, r.x, r.y])]));
    const first = key(packRects(items, DEFAULT_PACK));
    expect(key(packRects(items, DEFAULT_PACK))).toBe(first);
    expect(key(packRects([...items].reverse(), DEFAULT_PACK))).toBe(first);
  });

  it("opens a second page when one is full", () => {
    const items = rects(40, 200, 200, "big");
    const pages = packRects(items, { ...DEFAULT_PACK, maxWidth: 512, maxHeight: 512 });
    expect(pages.length).toBeGreaterThan(1);
    const total = pages.reduce((n, p) => n + p.rects.length, 0);
    expect(total).toBe(items.length);
    for (const p of pages) assertValid(p, DEFAULT_PACK.padding);
  });

  it("explains itself when a single image cannot fit a page", () => {
    expect(() => packRects(
      [{ id: "huge", width: 900, height: 40 }],
      { ...DEFAULT_PACK, maxWidth: 256, maxHeight: 256 },
    )).toThrow(/huge.*does not fit/);
  });

  it("honours the power-of-two option", () => {
    const page = packRects(rects(5, 50, 50), { ...DEFAULT_PACK, powerOfTwo: true })[0]!;
    expect(Math.log2(page.width) % 1).toBe(0);
    expect(Math.log2(page.height) % 1).toBe(0);
  });
});

describe("alpha trimming", () => {
  /** RGBA buffer with an opaque rect inside a transparent field. */
  function image(w: number, h: number, box: { x: number; y: number; w: number; h: number }) {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = box.y; y < box.y + box.h; y++) {
      for (let x = box.x; x < box.x + box.w; x++) {
        d[(y * w + x) * 4 + 3] = 255;
      }
    }
    return d;
  }

  it("finds an asymmetric bounding box", () => {
    // Deliberately off-centre: a symmetric fixture would pass even with the
    // trim offsets swapped or sign-flipped.
    const d = image(64, 48, { x: 3, y: 11, w: 20, h: 7 });
    expect(alphaBounds(d, 64, 48)).toEqual({ x: 3, y: 11, width: 20, height: 7, untrimmed: false });
  });

  it("reports a full-bleed image as untrimmed", () => {
    const d = image(8, 8, { x: 0, y: 0, w: 8, h: 8 });
    expect(alphaBounds(d, 8, 8).untrimmed).toBe(true);
  });

  it("keeps a 1x1 region for a fully transparent image", () => {
    const d = new Uint8ClampedArray(4 * 4 * 4);
    expect(alphaBounds(d, 4, 4)).toEqual({ x: 0, y: 0, width: 1, height: 1, untrimmed: false });
  });

  it("respects the alpha threshold", () => {
    const d = new Uint8ClampedArray(4 * 4 * 4);
    d[(1 * 4 + 1) * 4 + 3] = 5;
    expect(alphaBounds(d, 4, 4, 10).width).toBe(1);
    expect(alphaBounds(d, 4, 4, 0)).toMatchObject({ x: 1, y: 1, width: 1, height: 1 });
  });

  it("fits an image as wide as the page less its padding on both sides", () => {
    const opts = { ...DEFAULT_PACK, maxWidth: 256, maxHeight: 256, padding: 2 };
    const pages = packRects([{ id: "wide", width: 252, height: 252 }], opts);
    expect(pages).toHaveLength(1);
    assertValid(pages[0]!, opts.padding);
    const r = pages[0]!.rects[0]!;
    expect(r.x).toBeGreaterThanOrEqual(opts.padding);
    expect(r.x + r.width + opts.padding).toBeLessThanOrEqual(pages[0]!.width);
    expect(() => packRects([{ id: "wider", width: 253, height: 10 }], { ...opts, allowRotation: false }))
      .toThrow(/does not fit/);
  });
});


describe("atlasKey", () => {
  it("changes with what the pages depend on, and only that", async () => {
    const { atlasKey, DEFAULT_ATLAS } = await import("@/io/atlas/AtlasBuilder");
    const { createImageItem } = await import("@/core/doc/defaults");
    const a = createImageItem("a", "s1" as never, 10, 20);
    const b = createImageItem("b", "s2" as never, 30, 40);
    const k = atlasKey([a, b], "rig", "rig", DEFAULT_ATLAS);
    expect(atlasKey([{ ...a }, { ...b }], "rig", "rig", { ...DEFAULT_ATLAS })).toBe(k);
    for (const other of [
      atlasKey([a], "rig", "rig", DEFAULT_ATLAS),
      atlasKey([{ ...a, name: "a2" }, b], "rig", "rig", DEFAULT_ATLAS),        // SubTexture names
      atlasKey([{ ...a, assetId: "s9" as never }, b], "rig", "rig", DEFAULT_ATLAS),
      atlasKey([{ ...a, noTrim: true }, b], "rig", "rig", DEFAULT_ATLAS),
      atlasKey([a, b], "rig2", "rig", DEFAULT_ATLAS),
      atlasKey([a, b], "rig", "rig", { ...DEFAULT_ATLAS, padding: 4 }),
    ]) expect(other).not.toBe(k);
  });
});
