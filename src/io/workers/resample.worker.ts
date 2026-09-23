import { resampleRgba } from "@/core/atlas/resample";
import { serveWorker } from "./WorkerPool";
import type { ResampleRequest } from "./resample";

serveWorker<ResampleRequest, Uint8ClampedArray<ArrayBuffer>>(
  (r) => resampleRgba(r.src, r.sw, r.sh, r.dw, r.dh, r.filter),
  (out) => [out.buffer],
);
