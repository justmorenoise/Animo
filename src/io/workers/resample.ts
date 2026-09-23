import { resampleRgba } from "@/core/atlas/resample";
import type { Resample } from "@/core/export/settings";
import { canUseWorkers, poolSize, WorkerCrashed, WorkerPool } from "./WorkerPool";

export interface ResampleRequest {
  src: Uint8ClampedArray;
  sw: number; sh: number; dw: number; dh: number;
  filter: Resample;
}

let pool: WorkerPool<ResampleRequest, Uint8ClampedArray<ArrayBuffer>> | null | undefined;

function resamplePool() {
  if (pool === undefined) {
    pool = canUseWorkers()
      ? new WorkerPool(
          () => new Worker(new URL("./resample.worker.ts", import.meta.url), { type: "module" }),
          poolSize(4))
      : null;
  }
  return pool;
}

/**
 * `resampleRgba` on a worker: a 4096px Lanczos pass blocks for about a
 * second. The source is copied, not transferred — it is the asset's cached
 * pixels. Without workers, or when one cannot start, it runs here.
 */
export async function resampleOffThread(
  src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number, filter: Resample,
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const p = resamplePool();
  if (p) {
    try {
      return await p.run({ src, sw, sh, dw, dh, filter });
    } catch (err) {
      if (!(err instanceof WorkerCrashed)) throw err;
      p.dispose();
      pool = null;
    }
  }
  return resampleRgba(src, sw, sh, dw, dh, filter);
}
