import type { AssetId } from "@/core/doc/ids";
import type { Asset, AssetStore } from "@/app/AssetStore";

/** The bytes decide the asset; two blobs with the same bytes are one image. */
export const blobOf = (bytes: string) => new Blob([bytes], { type: "image/png" });

/** Put images straight into a store, without decoding: `[id, bytes]` each. */
export function fillAssets(store: AssetStore, entries: Array<[string, string]>, { keep = false } = {}): void {
  const inner = store as unknown as { assets: Map<AssetId, Asset>; byHash: Map<string, AssetId> };
  if (!keep) { inner.assets = new Map(); inner.byHash = new Map(); }
  for (const [id, bytes] of entries) {
    inner.assets.set(id as AssetId, {
      id: id as AssetId, name: id, width: 4, height: 4,
      bitmap: { close() {} } as unknown as ImageBitmap, blob: blobOf(bytes),
    });
  }
}
