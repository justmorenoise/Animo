import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deserializeProject } from "@/io/project/ProjectFile";
import { isSymbol, type Project, type SymbolItem } from "@/core/doc/types";
import type { AssetId, ItemId } from "@/core/doc/ids";
import type { AssetStore } from "@/app/AssetStore";
import { Store } from "@/app/Store";

/**
 * The real rig, not a hand-built scene.
 *
 * `frog.animo` is a v2 file with eleven symbols, mask links,
 * nested symbol instances and animations hundreds of frames long — the shapes
 * a synthetic two-layer scene never produces. Loading it here means the layer
 * clipboard, the frame clipboard and the export filter are exercised against
 * a document somebody actually authored, migration included.
 */
export const FIXTURE_PATH = fileURLToPath(
  new URL("./projects/frog.animo", import.meta.url),
);

/** Symbol names inside the fixture that the tests lean on. */
export const RIG = {
  /** 5 layers: a mask, two masked layers, a nested symbol, one plain image. */
  eyeLeft: "eye_left",
  /** 5 layers, 4 tracks keyed at 0 / 49 / 119. */
  body: "body",
  pupil2: "pupil_2",
} as const;

/**
 * A stand-in for AssetStore: the export path never decodes pixels, it only
 * needs the blobs to round-trip. Same trick as `tests/project.test.ts`.
 */
export function fakeAssets(): AssetStore & { size(): number } {
  const map = new Map<string, { id: string; name: string; blob: Blob; width: number; height: number }>();
  return {
    get: (id: string) => map.get(id),
    clear: () => map.clear(),
    addWithId: async (id: string, blob: Blob, name: string) => {
      const asset = { id, name, blob, width: 10, height: 10 };
      map.set(id, asset);
      return asset;
    },
    size: () => map.size,
  } as unknown as AssetStore & { size(): number };
}

export interface Fixture {
  project: Project;
  store: Store;
  assets: AssetStore & { size(): number };
  diagnostics: { path: string; message: string; severity: string }[];
  /** The symbol with that name, or a throw — a typo must not read as "empty". */
  symbol(name: string): SymbolItem;
  itemId(name: string): ItemId;
  /** Open a symbol for editing, the way the Library's "Edit" does. */
  open(name: string): SymbolItem;
}

/** Load the fixture fresh. Every test gets its own copy: the commands mutate. */
export async function loadFixture(): Promise<Fixture> {
  const assets = fakeAssets();
  const bytes = readFileSync(FIXTURE_PATH);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const { project, diagnostics } = await deserializeProject(buffer as ArrayBuffer, assets);
  const store = new Store(project);

  const symbol = (name: string): SymbolItem => {
    const item = Object.values(project.items).find((i) => i.name === name);
    if (!item || !isSymbol(item)) throw new Error(`fixture has no symbol "${name}"`);
    return item;
  };

  return {
    project, store, assets,
    diagnostics: diagnostics as Fixture["diagnostics"],
    symbol,
    itemId(name: string): ItemId {
      const item = Object.values(project.items).find((i) => i.name === name);
      if (!item) throw new Error(`fixture has no item "${name}"`);
      return item.id;
    },
    open(name: string): SymbolItem {
      const sym = symbol(name);
      store.openSymbol(sym.id);
      return sym;
    },
  };
}

/** An image asset id present in the fixture, for Replace Image. */
export function anyAssetIdOtherThan(project: Project, not: AssetId): AssetId {
  for (const item of Object.values(project.items)) {
    if ("assetId" in item && item.assetId !== not) return item.assetId as AssetId;
  }
  throw new Error("fixture has only one image");
}

/** Layer row names of a symbol, top row first. */
export const rowNames = (sym: SymbolItem): string[] => sym.layers.map((l) => l.name);
