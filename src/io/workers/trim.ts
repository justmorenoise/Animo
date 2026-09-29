import { alphaBounds, type TrimResult } from "@/core/atlas/trim";
import { canUseWorkers, poolSize, WorkerCrashed, WorkerPool } from "./WorkerPool";

export interface TrimRequest {
  blob: Blob;
  threshold: number;
}

export interface TrimReply {
  trim: TrimResult;
  /** Size of the decoded image, so the caller can tell it read what it expected. */
  width: number;
  height: number;
}

/** Decoded pixels, however the environment produces them. */
export interface DecodedPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * The worker's job, with the decoder injected so it can be tested without a
 * browser: read the image, find the box of pixels above the alpha threshold.
 */
export async function trimRequest(
  req: TrimRequest, decode: (blob: Blob) => Promise<DecodedPixels>,
): Promise<TrimReply> {
  const px = await decode(req.blob);
  return { trim: alphaBounds(px.data, px.width, px.height, req.threshold), width: px.width, height: px.height };
}

let pool: WorkerPool<TrimRequest, TrimReply> | null | undefined;

function trimPool() {
  if (pool === undefined) {
    pool = canUseWorkers()
      ? new WorkerPool(
          () => new Worker(new URL("./trim.worker.ts", import.meta.url), { type: "module" }),
          poolSize(4))
      : null;
  }
  return pool;
}

/**
 * The trim box of an image, found on a worker: decoding it, reading its pixels
 * and scanning them for the alpha box is what held the page for most of a
 * cold preview build (about 660 ms for forty 2048px images). The image is sent
 * as its encoded bytes, so nothing large is copied.
 *
 * Null when it cannot be done here (no workers, or one that will not start);
 * the caller then trims on the page, as it always did.
 */
export async function trimOffThread(blob: Blob, threshold: number): Promise<TrimReply | null> {
  return trimWith(trimPool(), blob, threshold, () => { pool = null; });
}

/** `trimOffThread` on a given pool; `drop` is told when the pool is given up. */
export async function trimWith(
  p: WorkerPool<TrimRequest, TrimReply> | null, blob: Blob, threshold: number, drop: () => void = () => {},
): Promise<TrimReply | null> {
  if (!p) return null;
  try {
    return await p.run({ blob, threshold });
  } catch (err) {
    if (!(err instanceof WorkerCrashed)) throw err;
    p.dispose();
    drop();
    return null;
  }
}
