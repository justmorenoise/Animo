import type { AssetStore, Asset } from "./AssetStore";
import type { AssetId } from "@/core/doc/ids";
import { assetsInUse } from "@/core/doc/assetsInUse";
import type { Project } from "@/core/doc/types";

/**
 * The assets one import registers, so an import that comes to nothing gives
 * back exactly what it brought. Pixels that were already in the store are not
 * its own, nor is anything another import registered meanwhile; and `release`
 * keeps whatever an image item of the document uses, since a failure can
 * come after some of the import was applied, or another import may share it.
 */
export class AssetBatch {
  private readonly brought = new Set<AssetId>();

  constructor(private readonly assets: AssetStore) {}

  async addFromBlob(blob: Blob, name: string): Promise<Asset> {
    return this.note(await this.assets.register(blob, name));
  }

  async addFromFile(file: File): Promise<Asset> {
    return this.note(await this.assets.registerFile(file));
  }

  /** Give back what this batch brought that `project` does not use. */
  release(project: Project): void {
    const used = assetsInUse(project);
    for (const id of this.brought) if (!used.has(id)) this.assets.remove(id);
    this.brought.clear();
  }

  private note(r: { asset: Asset; created: boolean }): Asset {
    if (r.created) this.brought.add(r.asset.id);
    return r.asset;
  }
}

