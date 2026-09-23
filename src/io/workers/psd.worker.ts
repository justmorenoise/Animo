import { initializeCanvas, readPsd } from "ag-psd";
import { parsePsd } from "@/io/import/psdParse";
import { serveWorker } from "./WorkerPool";

// ag-psd reaches for `document` to make canvases; a worker has OffscreenCanvas.
initializeCanvas(
  (w, h) => new OffscreenCanvas(w, h) as unknown as HTMLCanvasElement,
  (w, h) => new ImageData(w, h),
);

serveWorker((buffer: ArrayBuffer, progress) =>
  parsePsd(buffer, readPsd, async (data, width, height) => {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d")!.putImageData(new ImageData(data, width, height), 0, 0);
    return canvas.convertToBlob({ type: "image/png" });
  }, progress));
