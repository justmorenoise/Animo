import { DEFAULT_PACK, type PackOptions, type PackPage, packRects } from "@/core/atlas/MaxRectsPacker";
import type { ItemId } from "@/core/doc/ids";
import { AtlasTooSmall, type Oversized, regionFits } from "@/core/atlas/oversize";
import { alphaBounds, type TrimResult } from "@/core/atlas/trim";
import type { DbAtlas, DbSubTexture } from "@/core/export/dbTypes";
import type { Asset, AssetStore } from "@/app/AssetStore";
import type { ImageItem } from "@/core/doc/types";
import { type AtlasLayout, type ExportSettings, type ImageFormat, pageLimit, type Resample } from "@/core/export/settings";
import { scaledSize } from "@/core/atlas/resample";
import { resampleOffThread } from "@/io/workers/resample";

export interface AtlasOptions extends PackOptions {
  /** Duplicate edge pixels into the padding gap to stop bilinear bleeding. */
  extrude: number;
  trim: boolean;
  /** Alpha at or below this counts as empty when trimming. */
  alphaThreshold: number;
  /** Texture resolution; below 1 the artwork is resampled and the atlas JSON
   *  carries the scale, which the runtime multiplies every sprite by. */
  scale: number;
  resample: Resample;
  layout: AtlasLayout;
  image: ImageFormat;
  imageQuality: number;
}

export const DEFAULT_ATLAS: AtlasOptions = {
  ...DEFAULT_PACK,
  extrude: 1,
  trim: true,
  alphaThreshold: 0,
  scale: 1,
  resample: "lanczos",
  layout: "packed",
  image: "png",
  imageQuality: 0.9,
};

/** The atlas options a document's export settings ask for. Pure. */
export function atlasOptionsFor(s: ExportSettings): AtlasOptions {
  const limit = pageLimit(s);
  return {
    ...DEFAULT_PACK,
    maxWidth: limit.w,
    maxHeight: limit.h,
    padding: s.padding,
    powerOfTwo: s.powerOfTwo,
    square: s.square,
    extrude: s.extrude,
    trim: s.trim,
    alphaThreshold: s.alphaThreshold,
    scale: s.scale,
    resample: s.resample,
    layout: s.layout,
    image: s.image,
    imageQuality: s.imageQuality,
  };
}

export interface AtlasPage {
  json: DbAtlas;
  blob: Blob;
  canvas: HTMLCanvasElement;
  /** File stem, e.g. "MyProject_tex" or "MyProject_tex_1". */
  fileStem: string;
  /** The image file's extension, "png" or "webp". */
  ext: ImageFormat;
}

interface Entry {
  item: ImageItem;
  /** What is drawn onto the page: the decoded asset, or its resampled copy. */
  source: CanvasImageSource;
  /** The untrimmed size at the export's resolution. */
  width: number;
  height: number;
  trim: TrimResult;
  /** Content hash, so identical images share one packed region. */
  key: string;
}

/**
 * Everything the atlas depends on except the pixels, as one string: the
 * images in order (id, name, asset, size, trim switch), the names the pages
 * carry and the options. Pure. Two builds with the same key and the same
 * asset objects produce the same pages.
 */
export function atlasKey(
  items: readonly ImageItem[], atlasName: string, fileBase: string, opts: AtlasOptions,
): string {
  return JSON.stringify([
    items.map((i) => [i.id, i.name, i.assetId, i.width, i.height, i.noTrim === true]),
    atlasName, fileBase, opts,
  ]);
}

/** The last build. The preview rebuilds the export on every edit, and a
 *  transform edit leaves the atlas exactly as it was: trimming, packing and
 *  PNG-encoding it again was nearly all of the rebuild's time. */
let lastBuild: { key: string; assets: (Asset | undefined)[]; pages: AtlasPage[] } | null = null;

/** Trim boxes per decoded asset; an asset's pixels never change (a replaced
 *  image is a new asset). */
const trimCache = new WeakMap<Asset, Map<string, TrimResult>>();

function trimOf(
  asset: Asset, pixels: () => ImageData | null, w: number, h: number, scaleKey: string, threshold: number,
): TrimResult | null {
  const key = `${threshold}|${w}x${h}|${scaleKey}`;
  let byKey = trimCache.get(asset);
  const hit = byKey?.get(key);
  if (hit) return hit;
  const px = pixels();
  if (!px) return null;
  const trim = alphaBounds(px.data, w, h, threshold);
  if (!byKey) trimCache.set(asset, (byKey = new Map()));
  byKey.set(key, trim);
  return trim;
}

/** Resampled copies per asset, per size and filter, as promises: the
 *  resampling runs on workers, and two builds asking at once share one. */
type Scaled = { canvas: HTMLCanvasElement; data: ImageData } | null;
const scaledCache = new WeakMap<Asset, Map<string, Promise<Scaled>>>();

function scaledCopy(
  asset: Asset, assets: AssetStore, w: number, h: number, filter: Resample,
): Promise<Scaled> {
  const key = `${w}x${h}|${filter}`;
  let byKey = scaledCache.get(asset);
  const hit = byKey?.get(key);
  if (hit) return hit;
  const px = assets.pixels(asset.id);
  if (!px) return Promise.resolve(null);
  const made = resampleOffThread(px.data, px.width, px.height, w, h, filter).then((out) => {
    const data = new ImageData(out, w, h);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.putImageData(data, 0, 0);
    return { canvas, data };
  });
  if (!byKey) scaledCache.set(asset, (byKey = new Map()));
  byKey.set(key, made);
  made.catch(() => byKey!.delete(key));
  return made;
}

/**
 * Packs the referenced library images into one or more atlas pages and
 * renders each to a PNG. Reuses the previous pages when nothing they depend
 * on changed (`atlasKey`, and the very same asset objects: ids restart with
 * every document).
 *
 * Two details the runtime depends on:
 *  - `frameWidth`/`frameHeight` are the UNTRIMMED size and `frameX`/`frameY`
 *    are the NEGATIVE of the trim offset. The runtime computes the display
 *    anchor as `pivot * frameWidth + frameX`, so both signs matter.
 *  - Every page's atlas `name` must equal the skeleton's `name`, or the
 *    factory will not pair them and nothing renders.
 */
export async function buildAtlas(
  items: ImageItem[],
  assets: AssetStore,
  atlasName: string,
  fileBase: string,
  opts: AtlasOptions = DEFAULT_ATLAS,
  /** 0..1: the resampled copies are the first half when the scale is below 1,
   *  the page encoding the rest. */
  onProgress: (fraction: number) => void = () => {},
): Promise<AtlasPage[]> {
  if (items.length === 0) return [];
  const key = atlasKey(items, atlasName, fileBase, opts);
  const used = items.map((i) => assets.get(i.assetId));
  if (lastBuild && lastBuild.key === key && lastBuild.assets.length === used.length
      && lastBuild.assets.every((a, n) => a === used[n])) {
    return lastBuild.pages;
  }

  // Every resampled copy first, so the workers run them side by side.
  const scaling = opts.scale < 1;
  if (scaling) {
    let done = 0;
    await Promise.all(items.map(async (item) => {
      const asset = assets.get(item.assetId);
      const { w, h } = scaledSize(item.width, item.height, opts.scale);
      if (asset) await scaledCopy(asset, assets, w, h, opts.resample);
      onProgress((0.5 * ++done) / items.length);
    }));
  }

  // Trim, and deduplicate by content so a repeated image is packed once.
  const entries: Entry[] = [];
  const byKey = new Map<string, Entry>();
  for (const item of items) {
    const asset = assets.get(item.assetId);
    if (!asset) continue;

    let source: CanvasImageSource = asset.bitmap as CanvasImageSource;
    let { width, height } = item;
    let pixels = () => assets.pixels(asset.id);
    if (opts.scale < 1) {
      ({ w: width, h: height } = scaledSize(item.width, item.height, opts.scale));
      const copy = await scaledCopy(asset, assets, width, height, opts.resample);
      if (copy) {
        source = copy.canvas;
        pixels = () => copy.data;
      } else {
        ({ width, height } = item);
      }
    }
    const scaleKey = width === item.width && height === item.height ? "1" : opts.resample;
    let trim: TrimResult = { x: 0, y: 0, width, height, untrimmed: true };
    if (opts.trim && !item.noTrim) {
      trim = trimOf(asset, pixels, width, height, scaleKey, opts.alphaThreshold) ?? trim;
    }
    const key = `${item.assetId}|${width}x${height}|${trim.x},${trim.y},${trim.width},${trim.height}`;
    const entry: Entry = { item, source, width, height, trim, key };
    entries.push(entry);
    if (!byKey.has(key)) byKey.set(key, entry);
  }

  // Checked here rather than left to the packer, which only knows region
  // keys: the user needs the images by name, and every one of them at once.
  const oversized = new Map<ItemId, Oversized>();
  for (const e of byKey.values()) {
    if (regionFits(e.trim.width + opts.extrude * 2, e.trim.height + opts.extrude * 2, opts)) continue;
    oversized.set(e.item.id, { name: e.item.name, width: e.item.width, height: e.item.height });
  }
  if (oversized.size) throw new AtlasTooSmall([...oversized.values()], { w: opts.maxWidth, h: opts.maxHeight });

  const regions = [...byKey.values()].map((e) => ({
    id: e.key,
    width: e.trim.width + opts.extrude * 2,
    height: e.trim.height + opts.extrude * 2,
  }));
  // One page per image, named after it, or as few pages as fit.
  const pages = opts.layout === "perImage"
    ? regions.flatMap((r) => packRects([r], opts))
    : packRects(regions, opts);
  const stems = pageStems(pages.map((pg) => byKey.get(pg.rects[0]!.id)!.item.name), fileBase, opts.layout);

  const out: AtlasPage[] = [];

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p]!;
    const stem = stems[p]!;
    const placed = new Map(page.rects.map((r) => [r.id, r]));

    const canvas = renderPage(page, placed, byKey, opts);
    const blob = await encodePage(canvas, opts);
    onProgress((scaling ? 0.5 : 0) + ((scaling ? 0.5 : 1) * (p + 1)) / pages.length);

    // Every entry whose region landed on THIS page gets a SubTexture, even
    // when several entries share one region.
    const subTextures: DbSubTexture[] = [];
    for (const entry of entries) {
      const rect = placed.get(entry.key);
      if (!rect) continue;
      const sub: DbSubTexture = {
        name: entry.item.name,
        x: rect.x + opts.extrude,
        y: rect.y + opts.extrude,
        width: entry.trim.width,
        height: entry.trim.height,
      };
      if (!entry.trim.untrimmed) {
        sub.frameX = -entry.trim.x;
        sub.frameY = -entry.trim.y;
        sub.frameWidth = entry.width;
        sub.frameHeight = entry.height;
      }
      if (rect.rotated) sub.rotated = true;
      subTextures.push(sub);
    }
    subTextures.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const json: DbAtlas = {
      name: atlasName,
      imagePath: `${stem}.${opts.image}`,
      width: page.width,
      height: page.height,
      SubTexture: subTextures,
    };
    // The runtime reads it as `1 / scale` and multiplies every sprite by that.
    if (opts.scale < 1) json.scale = opts.scale;
    out.push({ fileStem: stem, canvas, blob, json, ext: opts.image });
  }

  lastBuild = { key, assets: used, pages: out };
  return out;
}

/**
 * The file stem of each page. Packed: `<base>_tex`, or `<base>_tex_<n>` when
 * there are several — what the exporter always wrote. One page per image:
 * `<base>_tex_<image>`, made file-safe and unique. Pure.
 */
export function pageStems(firstImageNames: readonly string[], fileBase: string, layout: AtlasLayout): string[] {
  if (layout === "packed") {
    return firstImageNames.length > 1
      ? firstImageNames.map((_, p) => `${fileBase}_tex_${p}`)
      : firstImageNames.map(() => `${fileBase}_tex`);
  }
  const taken = new Set<string>();
  return firstImageNames.map((name) => {
    const safe = name.trim().replace(/[^\w.-]+/g, "_").replace(/^[_.]+|[_.]+$/g, "") || "image";
    let stem = `${fileBase}_tex_${safe}`;
    for (let n = 2; taken.has(stem); n++) stem = `${fileBase}_tex_${safe}_${n}`;
    taken.add(stem);
    return stem;
  });
}

function encodePage(canvas: HTMLCanvasElement, opts: AtlasOptions): Promise<Blob> {
  return opts.image === "webp" ? toBlob(canvas, "image/webp", opts.imageQuality) : toPngBlob(canvas);
}

function renderPage(
  page: PackPage,
  placed: Map<string, { x: number; y: number; rotated: boolean }>,
  byKey: Map<string, Entry>,
  opts: AtlasOptions,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = page.width;
  canvas.height = page.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create the atlas canvas");
  ctx.imageSmoothingEnabled = false;

  for (const [key, rect] of placed) {
    const entry = byKey.get(key);
    if (!entry) continue;
    const src = entry.source;
    const t = entry.trim;
    const dx = rect.x + opts.extrude;
    const dy = rect.y + opts.extrude;

    ctx.save();
    if (rect.rotated) {
      ctx.translate(dx + t.height, dy);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(src, t.x, t.y, t.width, t.height, 0, 0, t.width, t.height);
    } else {
      ctx.drawImage(src, t.x, t.y, t.width, t.height, dx, dy, t.width, t.height);
    }
    ctx.restore();

    // Extrusion: duplicate the outer row/column outward so bilinear sampling
    // at non-integer scale cannot pull in a neighbour's pixels.
    if (opts.extrude > 0 && !rect.rotated) {
      const e = opts.extrude;
      // Left / right
      ctx.drawImage(src, t.x, t.y, 1, t.height, dx - e, dy, e, t.height);
      ctx.drawImage(src, t.x + t.width - 1, t.y, 1, t.height, dx + t.width, dy, e, t.height);
      // Top / bottom (including the corners just written)
      ctx.drawImage(canvas, dx - e, dy, t.width + e * 2, 1, dx - e, dy - e, t.width + e * 2, e);
      ctx.drawImage(canvas, dx - e, dy + t.height - 1, t.width + e * 2, 1,
                    dx - e, dy + t.height, t.width + e * 2, e);
    }
  }

  return canvas;
}

/** Exported because exporting one library item as a PNG needs exactly this. */
export function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return toBlob(canvas, "image/png");
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b && b.type === type ? resolve(b) : reject(new Error(`This browser cannot encode ${type}`))),
      type, quality,
    );
  });
}
