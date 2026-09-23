/**
 * Export settings: what File ▸ Export writes, per document.
 *
 * Stored in the project (`Project.exportSettings`, schema v7) because the
 * atlas a game needs — its page size, its resolution — belongs to that game,
 * not to the editor. Absent means `DEFAULT_EXPORT_SETTINGS`, which is exactly
 * what the exporter wrote before the settings existed, so an older file
 * exports byte for byte as it did.
 *
 * The preview builds with the same settings: it is the ground truth, so a
 * half-resolution atlas shows its softness there too.
 */

/** The runtime a bundle is written for. One today; the field exists so a
 *  second format is a new value rather than a new setting. */
export type ExportFormat = "dragonbones-pixi";

/** How artwork is resized when `scale` is below 1. */
export type Resample = "nearest" | "bilinear" | "lanczos";

/**
 * `packed`: as few pages as fit. `perImage`: one page per image, named after
 * it — the closest the format comes to a folder of loose images, since the
 * factory only finds textures through an atlas.
 */
export type AtlasLayout = "packed" | "perImage";

export type ImageFormat = "png" | "webp";

export interface ExportSettings {
  format: ExportFormat;
  maxWidth: number;
  maxHeight: number;
  powerOfTwo: boolean;
  square: boolean;
  /** Gap between regions and around the page edge, in page pixels. */
  padding: number;
  /** Edge pixels repeated around each region, against bilinear bleeding;
   *  they are part of the region, not of the padding. */
  extrude: number;
  trim: boolean;
  /** Alpha at or below this is empty when trimming. */
  alphaThreshold: number;
  layout: AtlasLayout;
  /** Texture resolution, 1 = as imported. The atlas JSON carries it, and the
   *  runtime scales every sprite back up, so the rig keeps its size. */
  scale: number;
  resample: Resample;
  image: ImageFormat;
  /** 0..1, WebP only. */
  imageQuality: number;
  /** Skeleton and atlas JSON without indentation. */
  minifyJson: boolean;
}

export const DEFAULT_EXPORT_SETTINGS: Readonly<ExportSettings> = Object.freeze({
  format: "dragonbones-pixi",
  maxWidth: 2048,
  maxHeight: 2048,
  powerOfTwo: false,
  square: false,
  padding: 2,
  extrude: 1,
  trim: true,
  alphaThreshold: 0,
  layout: "packed",
  scale: 1,
  resample: "lanczos",
  image: "png",
  imageQuality: 0.9,
  minifyJson: false,
});

/** Ranges for the numbers, shared by the sanitizer and the dialog's fields. */
export const EXPORT_LIMITS = {
  maxWidth: { min: 64, max: 8192 },
  maxHeight: { min: 64, max: 8192 },
  padding: { min: 0, max: 32 },
  extrude: { min: 0, max: 8 },
  alphaThreshold: { min: 0, max: 254 },
  scale: { min: 0.05, max: 1 },
  imageQuality: { min: 0.1, max: 1 },
} as const satisfies Partial<Record<keyof ExportSettings, { min: number; max: number }>>;

export const EXPORT_CHOICES = {
  format: ["dragonbones-pixi"],
  resample: ["nearest", "bilinear", "lanczos"],
  layout: ["packed", "perImage"],
  image: ["png", "webp"],
} as const satisfies Partial<Record<keyof ExportSettings, readonly string[]>>;

/**
 * Settings read from a file or a dialog, key by key: a wrong type, an
 * unknown choice or a non-finite number falls back to the default, numbers
 * are clamped. Integers stay integers.
 */
export function sanitizeExportSettings(raw: unknown): ExportSettings {
  const out: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS };
  if (!raw || typeof raw !== "object") return out;
  const src = raw as Record<string, unknown>;
  const target = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(out) as (keyof ExportSettings)[]) {
    const v = src[key];
    const def = DEFAULT_EXPORT_SETTINGS[key];
    if (typeof v !== typeof def) continue;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) continue;
      const lim = (EXPORT_LIMITS as Record<string, { min: number; max: number }>)[key];
      const n = lim ? Math.max(lim.min, Math.min(lim.max, v)) : v;
      target[key] = Number.isInteger(def) && key !== "scale" && key !== "imageQuality" ? Math.round(n) : n;
    } else if (typeof v === "string") {
      const choices = (EXPORT_CHOICES as Record<string, readonly string[]>)[key];
      if (choices && !choices.includes(v)) continue;
      target[key] = v;
    } else {
      target[key] = v;
    }
  }
  return out;
}

/** True when nothing differs from the defaults — the file then stays clean. */
export function isDefaultExport(s: ExportSettings): boolean {
  return (Object.keys(DEFAULT_EXPORT_SETTINGS) as (keyof ExportSettings)[])
    .every((k) => s[k] === DEFAULT_EXPORT_SETTINGS[k]);
}

/** The largest power of two not above `n`. */
export function floorPow2(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/**
 * The page limit actually used. Power of two with a maximum that is not one
 * used to round a page up to the next power and then clamp it back to the
 * maximum — a 2000px limit gave 2000px pages, silently not a power of two.
 * The limit is rounded DOWN instead, and `exportNotes` says so.
 */
export function pageLimit(s: ExportSettings): { w: number; h: number } {
  let w = s.maxWidth, h = s.maxHeight;
  if (s.powerOfTwo) { w = floorPow2(w); h = floorPow2(h); }
  if (s.square) w = h = Math.min(w, h);
  return { w, h };
}

/** What the dialog should tell the user about a combination of settings. */
export function exportNotes(s: ExportSettings): string[] {
  const notes: string[] = [];
  const lim = pageLimit(s);
  if (s.powerOfTwo && (lim.w !== s.maxWidth || lim.h !== s.maxHeight) && !s.square) {
    notes.push(`Power of two: pages are at most ${lim.w}×${lim.h}, the largest powers of two within the maximum.`);
  } else if (lim.w !== s.maxWidth || lim.h !== s.maxHeight) {
    notes.push(`Pages are at most ${lim.w}×${lim.h}.`);
  }
  if (s.scale < 1) {
    notes.push(`Textures at ${Math.round(s.scale * 100)}%: the atlas JSON records the scale and the runtime draws them at full size, softer.`);
  }
  if (s.resample === "nearest" && s.scale < 1) {
    notes.push("Nearest drops pixels rather than averaging them: right for pixel art, jagged for anything else.");
  }
  if (s.image === "webp") {
    notes.push("WebP is smaller than PNG and every current browser decodes it; some older engines and tools do not.");
  }
  return notes;
}
