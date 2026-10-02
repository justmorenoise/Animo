import type { Store } from "./Store";
import type { AssetStore } from "./AssetStore";
import type { ReportProgress } from "./busy";
import { uniqueFolderName } from "@/core/doc/libraryTree";
import { AddFolder } from "@/core/history/libraryCommands";
import { AddLibraryItem } from "@/core/history/commands";
import { type AtlasImageIn, type AtlasSequence, buildAtlasImport } from "@/core/doc/atlasImport";
import type { CutImage } from "@/io/import/atlasCut";
import type { AssetId } from "@/core/doc/ids";

export interface AtlasImportOutcome {
  folderName: string;
  images: number;
  symbols: number;
}

/**
 * An atlas's images, already cut, into the library: one folder, and a symbol
 * per sequence. One undo step. Assets are registered before the transaction
 * opens, since decoding is async and a command never is.
 */
export async function importAtlas(
  store: Store, assets: AssetStore, name: string,
  images: Array<CutImage & { pivot?: { x: number; y: number } }>, sequences: AtlasSequence[],
  report: ReportProgress = () => {},
): Promise<AtlasImportOutcome> {
  const registered: AtlasImageIn[] = [];
  // Identical pixels share an asset: only the ones new here go if this fails.
  const before = new Set(assets.all().map((a) => a.id));
  const added = new Set<AssetId>();
  try {
    for (const [i, img] of images.entries()) {
      const asset = await assets.addFromBlob(img.blob, img.name);
      if (!before.has(asset.id)) added.add(asset.id);
      registered.push({ name: img.name, assetId: asset.id, width: img.width, height: img.height, pivot: img.pivot });
      report((i + 1) / images.length);
    }
  } catch (err) {
    for (const id of added) assets.remove(id);
    throw err;
  }
  const taken = new Set(Object.values(store.project.items).map((i) => i.name));
  const plan = buildAtlasImport(name, uniqueFolderName(store.project, null, name), registered, sequences, (n) => taken.has(n));
  store.transaction(`Import ${name}`, () => {
    store.apply(new AddFolder(plan.folder));
    for (const item of plan.items) store.apply(new AddLibraryItem(`Import ${item.name}`, item));
  });
  store.selectItems(plan.symbols.length ? plan.symbols.map((s) => s.id) : plan.items.map((i) => i.id));
  store.emit("library");
  return { folderName: plan.folder.name, images: plan.items.length - plan.symbols.length, symbols: plan.symbols.length };
}
