import { DEFAULT_PACK, type PackOptions, type PackPage, packRects } from "@/core/atlas/MaxRectsPacker";
import { alphaBounds, type TrimResult } from "@/core/atlas/trim";
import type { DbAtlas, DbSubTexture } from "@/core/export/dbTypes";
import type { AssetStore } from "@/app/AssetStore";
import type { ImageItem } from "@/core/doc/types";

export interface AtlasOptions extends PackOptions {
  /** Duplicate edge pixels into the padding gap to stop bilinear bleeding. */
  extrude: number;
  trim: boolean;
  /** Alpha at or below this counts as empty when trimming. */
  alphaThreshold: number;
}

export const DEFAULT_ATLAS: AtlasOptions = {
  ...DEFAULT_PACK,
  extrude: 1,
  trim: true,
  alphaThreshold: 0,
};

export interface AtlasPage {
  json: DbAtlas;
  blob: Blob;
  canvas: HTMLCanvasElement;
  /** File stem, e.g. "MyProject_tex" or "MyProject_tex_1". */
  fileStem: string;
}

interface Entry {
  item: ImageItem;
  trim: TrimResult;
  /** Content hash, so identical images share one packed region. */
  key: string;
}

/**
 * Packs the referenced library images into one or more atlas pages and
 * renders each to a PNG.
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
): Promise<AtlasPage[]> {
  if (items.length === 0) return [];

  // Trim, and deduplicate by content so a repeated image is packed once.
  const entries: Entry[] = [];
  const byKey = new Map<string, Entry>();
  for (const item of items) {
    const asset = assets.get(item.assetId);
    if (!asset) continue;

    let trim: TrimResult = { x: 0, y: 0, width: item.width, height: item.height, untrimmed: true };
    if (opts.trim && !item.noTrim) {
      const px = assets.pixels(item.assetId);
      if (px) trim = alphaBounds(px.data, item.width, item.height, opts.alphaThreshold);
    }
    const key = `${item.assetId}|${trim.x},${trim.y},${trim.width},${trim.height}`;
    const entry: Entry = { item, trim, key };
    entries.push(entry);
    if (!byKey.has(key)) byKey.set(key, entry);
  }

  const pages = packRects(
    [...byKey.values()].map((e) => ({
      id: e.key,
      width: e.trim.width + opts.extrude * 2,
      height: e.trim.height + opts.extrude * 2,
    })),
    opts,
  );

  const out: AtlasPage[] = [];
  const multi = pages.length > 1;

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p]!;
    const stem = multi ? `${fileBase}_tex_${p}` : `${fileBase}_tex`;
    const placed = new Map(page.rects.map((r) => [r.id, r]));

    const canvas = renderPage(page, placed, byKey, assets, opts);
    const blob = await toPngBlob(canvas);

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
        sub.frameWidth = entry.item.width;
        sub.frameHeight = entry.item.height;
      }
      if (rect.rotated) sub.rotated = true;
      subTextures.push(sub);
    }
    subTextures.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    out.push({
      fileStem: stem,
      canvas,
      blob,
      json: {
        name: atlasName,
        imagePath: `${stem}.png`,
        width: page.width,
        height: page.height,
        SubTexture: subTextures,
      },
    });
  }

  return out;
}

function renderPage(
  page: PackPage,
  placed: Map<string, { x: number; y: number; rotated: boolean }>,
  byKey: Map<string, Entry>,
  assets: AssetStore,
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
    const asset = assets.get(entry.item.assetId);
    if (!asset) continue;

    const src = asset.bitmap as CanvasImageSource;
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
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Could not encode the PNG"))),
      "image/png",
    );
  });
}
