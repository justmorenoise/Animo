import { type AsyncZippable, type Unzipped, unzip, unzipSync, zip, zipSync, type Zippable } from "fflate";
import { canUseWorkers } from "@/io/workers/WorkerPool";

/**
 * Zip archives for project files and export bundles.
 *
 * PNG, WebP and JPEG are already deflated: compressing them again saves a
 * fraction of a percent and costs most of the time (a 64 MB archive at level
 * 6 blocked the main thread for 0.6 s, stored for 0.17 s). They are stored;
 * JSON and text are deflated. With workers available fflate compresses and
 * inflates off the main thread.
 */
export function zipLevelFor(path: string): 0 | 6 {
  return /\.(png|webp|jpe?g|gif)$/i.test(path) ? 0 : 6;
}

export async function zipFiles(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const [path, data] of Object.entries(files)) entries[path] = [data, { level: zipLevelFor(path) }];
  if (!canUseWorkers()) return zipSync(entries as Zippable);
  return new Promise((resolve, reject) =>
    zip(entries as AsyncZippable, (err, out) => (err ? reject(err) : resolve(out))));
}

export async function unzipFiles(data: Uint8Array): Promise<Unzipped> {
  if (!canUseWorkers()) return unzipSync(data);
  return new Promise((resolve, reject) =>
    unzip(data, (err, out) => (err ? reject(err) : resolve(out))));
}
