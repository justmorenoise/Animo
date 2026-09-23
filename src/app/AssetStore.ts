import { type AssetId, newAssetId, observeId } from "@/core/doc/ids";

export interface Asset {
  id: AssetId;
  name: string;
  width: number;
  height: number;
  /** Decoded for drawing. */
  bitmap: ImageBitmap | HTMLImageElement;
  /** Raw bytes, kept for project save and atlas packing. */
  blob: Blob;
  /** Lazily decoded pixels, for alpha hit-testing and trim. */
  pixels?: ImageData;
}

/**
 * Binary assets live OUTSIDE the undoable document — the document stores only
 * an AssetId. That keeps the project JSON small and diffable, keeps undo
 * entries cheap, and means an image is decoded once no matter how many
 * instances reference it.
 */
export class AssetStore {
  private assets = new Map<AssetId, Asset>();
  /** Content hash -> id, so importing the same PNG twice reuses one asset. */
  private byHash = new Map<string, AssetId>();

  get(id: AssetId): Asset | undefined { return this.assets.get(id); }
  all(): Asset[] { return [...this.assets.values()]; }

  async addFromBlob(blob: Blob, name: string): Promise<Asset> {
    const hash = await hashBlob(blob);
    const existing = this.byHash.get(hash);
    if (existing) {
      const a = this.assets.get(existing);
      if (a) return a;
    }

    const bitmap = await decode(blob);
    const asset: Asset = {
      id: newAssetId(),
      name,
      width: bitmap.width,
      height: bitmap.height,
      bitmap,
      blob,
    };
    this.assets.set(asset.id, asset);
    this.byHash.set(hash, asset.id);
    return asset;
  }

  /**
   * Restore an asset under an id the document already refers to. Loading a
   * project must not renumber assets, or every node's reference breaks.
   */
  async addWithId(id: AssetId, blob: Blob, name: string): Promise<Asset> {
    const bitmap = await decode(blob);
    const asset: Asset = { id, name, width: bitmap.width, height: bitmap.height, bitmap, blob };
    this.assets.set(id, asset);
    this.byHash.set(await hashBlob(blob), id);
    observeId(id);
    return asset;
  }

  async addFromFile(file: File): Promise<Asset> {
    const name = file.name.replace(/\.[^.]+$/, "");
    if (file.type === "image/svg+xml") {
      return this.addFromBlob(await rasterizeSvg(file), name);
    }
    return this.addFromBlob(file, name);
  }

  /** Pixels for alpha hit-testing and atlas trimming; decoded on first ask. */
  pixels(id: AssetId): ImageData | null {
    const a = this.assets.get(id);
    if (!a) return null;
    if (a.pixels) return a.pixels;
    const c = document.createElement("canvas");
    c.width = a.width; c.height = a.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(a.bitmap as CanvasImageSource, 0, 0);
    a.pixels = ctx.getImageData(0, 0, a.width, a.height);
    return a.pixels;
  }

  /** Alpha at a pixel, 0..255, for pixel-accurate picking. */
  alphaAt(id: AssetId, x: number, y: number): number {
    const a = this.assets.get(id);
    if (!a) return 0;
    if (x < 0 || y < 0 || x >= a.width || y >= a.height) return 0;
    const px = this.pixels(id);
    if (!px) return 255;
    return px.data[((y | 0) * a.width + (x | 0)) * 4 + 3] ?? 0;
  }

  remove(id: AssetId): void {
    const a = this.assets.get(id);
    if (!a) return;
    if (a.bitmap instanceof ImageBitmap) a.bitmap.close();
    this.assets.delete(id);
    for (const [hash, aid] of this.byHash) if (aid === id) this.byHash.delete(hash);
  }

  clear(): void {
    for (const id of [...this.assets.keys()]) this.remove(id);
  }
}

async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(blob); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("Could not decode image"));
      img.src = url;
    });
    return img;
  } finally {
    // The element keeps its own decoded copy once loaded.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * SVG is rasterised on import at 2x, because DragonBones atlases are bitmap
 * only. The source stays in the project so it can be re-rasterised later at a
 * different scale.
 */
async function rasterizeSvg(file: File, scale = 2): Promise<Blob> {
  const text = await file.text();
  const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("Could not load SVG"));
      img.src = url;
    });
    const w = Math.max(1, Math.round((img.naturalWidth || 300) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || 150) * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d")!.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((res, rej) =>
      c.toBlob((b) => (b ? res(b) : rej(new Error("SVG rasterisation failed"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function hashBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  if (crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // FNV-1a fallback for non-secure contexts.
  const bytes = new Uint8Array(buf);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv${hash.toString(16)}-${bytes.length}`;
}
