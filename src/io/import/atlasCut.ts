import { type AtlasRegion, regionCut } from "@/core/atlas/region";
import { unzipFiles } from "@/io/zip";

export interface CutImage {
  name: string;
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Every region cut out of its page back to the image it was packed from:
 * untrimmed, unturned, at full size. Decoding and encoding run off the page
 * (`createImageBitmap`, `convertToBlob`); only the copy of each region is
 * drawn here, which is quick. A region whose page is not in `pages` is left
 * out; the caller says so.
 */
export async function cutRegions(
  pages: Map<string, Blob>, regions: AtlasRegion[], scale: (page: string) => number = () => 1,
  onProgress: (fraction: number) => void = () => {},
): Promise<CutImage[]> {
  const out: CutImage[] = [];
  const total = Math.max(1, regions.length);
  let done = 0;
  for (const [page, blob] of pages) {
    const mine = regions.filter((r) => r.page === page);
    if (!mine.length) continue;
    const bitmap = await createImageBitmap(blob);
    try {
      for (const r of mine) {
        const cut = regionCut(r, scale(page));
        const canvas = new OffscreenCanvas(cut.width, cut.height);
        const ctx = canvas.getContext("2d")!;
        ctx.setTransform(...cut.m);
        ctx.drawImage(bitmap, cut.src.x, cut.src.y, cut.src.w, cut.src.h, 0, 0, cut.src.w, cut.src.h);
        out.push({ name: r.name, blob: await canvas.convertToBlob({ type: "image/png" }), width: cut.width, height: cut.height });
        onProgress(++done / total);
      }
    } finally {
      bitmap.close();
    }
  }
  return out;
}

/** Each file as a path and its bytes, zips opened. */
export async function expandFiles(files: File[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (/\.zip$/i.test(f.name)) {
      for (const [path, data] of Object.entries(await unzipFiles(bytes))) if (!path.endsWith("/")) out.set(path, data);
    } else {
      out.set(f.name, bytes);
    }
  }
  return out;
}
