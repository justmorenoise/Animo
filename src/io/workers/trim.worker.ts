import { serveWorker } from "./WorkerPool";
import { type TrimReply, type TrimRequest, trimRequest } from "./trim";

serveWorker<TrimRequest, TrimReply>((req) =>
  trimRequest(req, async (blob) => {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return { width: bitmap.width, height: bitmap.height, data };
    } finally {
      bitmap.close();
    }
  }));
