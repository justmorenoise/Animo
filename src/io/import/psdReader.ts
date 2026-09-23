import type { PsdDocument } from "./psdParse";
import { parsePsd } from "./psdParse";
import { canUseWorkers, WorkerCrashed, WorkerPool } from "@/io/workers/WorkerPool";

export type { PsdDocument, PsdRaw, PsdRawGroup, PsdRawImage } from "./psdParse";
export { resolveAlpha } from "./psdParse";

/**
 * Reads a PSD on a worker: ag-psd decodes synchronously, and a large file
 * froze the editor for seconds. The page parses it itself when a worker (or
 * OffscreenCanvas in one) is not available, or the worker dies.
 */
export async function readPsdFile(
  file: File, onProgress: (fraction: number) => void = () => {},
): Promise<PsdDocument> {
  const name = file.name.replace(/\.psd$/i, "") || "Photoshop document";
  if (canUseWorkers() && typeof OffscreenCanvas === "function") {
    const worker = new WorkerPool<ArrayBuffer, Omit<PsdDocument, "name">>(
      () => new Worker(new URL("../workers/psd.worker.ts", import.meta.url), { type: "module" }), 1);
    try {
      const buffer = await file.arrayBuffer();
      return { name, ...(await worker.run(buffer, [buffer], onProgress)) };
    } catch (err) {
      if (!(err instanceof WorkerCrashed)) throw err;
    } finally {
      worker.dispose();
    }
  }
  const { readPsd } = await import("ag-psd");
  return { name, ...(await parsePsd(await file.arrayBuffer(), readPsd, encodeOnCanvas, onProgress)) };
}

async function encodeOnCanvas(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get a 2D context to decode the PSD layer.");
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not encode a PSD layer as PNG.");
  return blob;
}
