import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXPORT_SETTINGS, exportNotes, floorPow2, isDefaultExport, pageLimit, sanitizeExportSettings,
} from "@/core/export/settings";
import { resampleRgba, scaledSize } from "@/core/atlas/resample";
import { DEFAULT_ATLAS } from "@/io/atlas/AtlasBuilder";

describe("export settings", () => {
  it("default to exactly what the exporter wrote before they existed", () => {
    const d = DEFAULT_EXPORT_SETTINGS;
    expect([d.maxWidth, d.maxHeight, d.padding, d.extrude, d.trim, d.alphaThreshold, d.powerOfTwo, d.square])
      .toEqual([DEFAULT_ATLAS.maxWidth, DEFAULT_ATLAS.maxHeight, DEFAULT_ATLAS.padding, DEFAULT_ATLAS.extrude,
        DEFAULT_ATLAS.trim, DEFAULT_ATLAS.alphaThreshold, DEFAULT_ATLAS.powerOfTwo, DEFAULT_ATLAS.square]);
    expect(d.scale).toBe(1);
    expect(isDefaultExport(sanitizeExportSettings(undefined))).toBe(true);
  });

  it("keep what is valid, key by key", () => {
    const s = sanitizeExportSettings({
      maxWidth: 99999, maxHeight: "big", padding: 3.6, scale: 0.5, resample: "sinc",
      image: "webp", imageQuality: Infinity, layout: "perImage", minifyJson: true, bogus: 1,
    });
    expect(s.maxWidth).toBe(8192);                 // clamped
    expect(s.maxHeight).toBe(2048);                // wrong type: default
    expect(s.padding).toBe(4);                     // integer
    expect(s.scale).toBe(0.5);
    expect(s.resample).toBe("lanczos");            // unknown choice: default
    expect(s.image).toBe("webp");
    expect(s.imageQuality).toBe(0.9);
    expect(s.layout).toBe("perImage");
    expect(s.minifyJson).toBe(true);
    expect("bogus" in s).toBe(false);
  });

  it.each([[2000, 1024], [2048, 2048], [4095, 2048], [64, 64], [100, 64]])("floorPow2(%i) = %i", (n, p) => {
    expect(floorPow2(n)).toBe(p);
  });

  it("rounds a non-power-of-two limit DOWN when pages must be powers of two, and says so", () => {
    const s = sanitizeExportSettings({ maxWidth: 2000, maxHeight: 3000, powerOfTwo: true });
    expect(pageLimit(s)).toEqual({ w: 1024, h: 2048 });
    expect(exportNotes(s).join(" ")).toMatch(/1024×2048/);
    expect(pageLimit({ ...s, square: true })).toEqual({ w: 1024, h: 1024 });
    expect(exportNotes(DEFAULT_EXPORT_SETTINGS)).toEqual([]);
  });
});

describe("resampleRgba", () => {
  const solid = (w: number, h: number, rgba: number[]) =>
    Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => rgba[i % 4]!);

  it.each(["nearest", "bilinear", "lanczos"] as const)("%s keeps a flat colour flat", (f) => {
    const out = resampleRgba(solid(10, 6, [200, 40, 90, 255]), 10, 6, 5, 3, f);
    for (let i = 0; i < out.length; i += 4) expect([...out.slice(i, i + 4)]).toEqual([200, 40, 90, 255]);
  });

  it("does not darken an edge against transparency (premultiplied)", () => {
    // Left half opaque red, right half transparent BLACK.
    const w = 8, src = new Uint8ClampedArray(w * 4 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) src.set([255, 0, 0, 255], (y * w + x) * 4);
    for (const f of ["bilinear", "lanczos"] as const) {
      const out = resampleRgba(src, w, 4, 4, 2, f);
      for (let i = 0; i < out.length; i += 4) {
        if (out[i + 3]! > 0) expect(out[i]).toBe(255);       // red stays red, only alpha falls
      }
    }
  });

  it("averages when shrinking, so a checkerboard halves to grey", () => {
    const w = 8, src = new Uint8ClampedArray(w * w * 4);
    for (let i = 0; i < w * w; i++) {
      const v = ((i % w) + Math.floor(i / w)) % 2 ? 255 : 0;
      src.set([v, v, v, 255], i * 4);
    }
    const out = resampleRgba(src, w, w, 4, 4, "bilinear");
    // The border repeats its edge pixel, so only the interior is a pure average.
    for (const y of [1, 2]) for (const x of [1, 2]) expect(Math.abs(out[(y * 4 + x) * 4]! - 128)).toBeLessThanOrEqual(1);
  });

  it("scaledSize never reaches zero", () => {
    expect(scaledSize(100, 3, 0.1)).toEqual({ w: 10, h: 1 });
    expect(scaledSize(7, 7, 0.5)).toEqual({ w: 4, h: 4 });
  });
});

describe("export settings in the document", () => {
  it("migrate from v6, survive a load, and stay absent when default", async () => {
    const { createProject } = await import("@/core/doc/defaults");
    const { validateProject, migrate } = await import("@/core/doc/schema");
    const { DOC_VERSION } = await import("@/core/doc/types");
    const p = createProject("E");
    const v6 = JSON.parse(JSON.stringify({ ...p, version: 6 }));
    expect(validateProject(migrate(v6)).project.version).toBe(DOC_VERSION);

    const withSettings = JSON.parse(JSON.stringify({ ...p, exportSettings: { scale: 0.5, image: "gif" } }));
    const loaded = validateProject(withSettings).project;
    expect(loaded.exportSettings?.scale).toBe(0.5);
    expect(loaded.exportSettings?.image).toBe("png");

    const defaults = JSON.parse(JSON.stringify({ ...p, exportSettings: {} }));
    expect("exportSettings" in validateProject(defaults).project).toBe(false);
  });

  it("are set and undone as one step", async () => {
    const { createProject } = await import("@/core/doc/defaults");
    const { History } = await import("@/core/history/History");
    const { SetExportSettings } = await import("@/core/history/commands");
    const p = createProject("E");
    const h = new History(p);
    h.apply(new SetExportSettings({ ...DEFAULT_EXPORT_SETTINGS, scale: 0.5 }));
    expect(p.exportSettings?.scale).toBe(0.5);
    h.apply(new SetExportSettings({ ...DEFAULT_EXPORT_SETTINGS }));
    expect(p.exportSettings).toBeUndefined();
    h.undo();
    expect(p.exportSettings?.scale).toBe(0.5);
    h.undo();
    expect(p.exportSettings).toBeUndefined();
  });
});

describe("atlas options and page names", () => {
  it("atlasOptionsFor the defaults is what the exporter always used", async () => {
    const { atlasOptionsFor } = await import("@/io/atlas/AtlasBuilder");
    expect(atlasOptionsFor(DEFAULT_EXPORT_SETTINGS)).toEqual(DEFAULT_ATLAS);
  });

  it("feeds the rounded-down page limit to the packer", async () => {
    const { atlasOptionsFor } = await import("@/io/atlas/AtlasBuilder");
    const o = atlasOptionsFor(sanitizeExportSettings({ maxWidth: 2000, maxHeight: 2000, powerOfTwo: true }));
    expect([o.maxWidth, o.maxHeight, o.powerOfTwo]).toEqual([1024, 1024, true]);
  });

  it("names pages as before when packed, after the image when one per image", async () => {
    const { pageStems } = await import("@/io/atlas/AtlasBuilder");
    expect(pageStems(["a"], "rig", "packed")).toEqual(["rig_tex"]);
    expect(pageStems(["a", "b"], "rig", "packed")).toEqual(["rig_tex_0", "rig_tex_1"]);
    expect(pageStems(["arm left", "arm/left", "..head"], "rig", "perImage"))
      .toEqual(["rig_tex_arm_left", "rig_tex_arm_left_2", "rig_tex_head"]);
  });
});
