import type { Store } from "./Store";
import type { AssetStore } from "./AssetStore";
import { type PsdRaw, readPsdFile } from "@/io/import/psdReader";
import { buildPsdImport, type PsdPlan } from "@/core/doc/psdImport";
import { AddLibraryItem, AddNode, SetDocumentSettings } from "@/core/history/commands";
import { createLayer, createNode } from "@/core/doc/defaults";

export interface PsdImportOutcome {
  /** The symbol wrapping the whole document. */
  symbolName: string;
  images: number;
  symbols: number;
  /** Set when the stage was resized to the document; null otherwise. */
  stage: { width: number; height: number } | null;
  warnings: string[];
}

/**
 * Import a `.psd` as library items, and drop one instance of the document on
 * the stage.
 *
 * The whole thing is one undo entry. Half an imported PSD is not a state
 * anyone wants to be left in, and `Store.transaction` already gives us that
 * for free by folding the commands into a composite.
 */
export async function importPsd(
  store: Store, assets: AssetStore, file: File,
  /** Where the document's canvas origin lands. Defaults to the symbol's own. */
  at: { x: number; y: number } = { x: 0, y: 0 },
): Promise<PsdImportOutcome> {
  const doc = await readPsdFile(file);

  // Assets are registered before the transaction opens: they live outside the
  // document (the project stores only an AssetId), and decoding is async,
  // which a command must never be.
  let images = 0;
  const toPlan = async (raw: PsdRaw[]): Promise<PsdPlan[]> => {
    const out: PsdPlan[] = [];
    for (const node of raw) {
      if (node.kind === "group") {
        out.push({
          kind: "group", name: node.name, visible: node.visible,
          children: await toPlan(node.children),
        });
        continue;
      }
      const asset = await assets.addFromBlob(node.blob, node.name || "layer");
      images++;
      out.push({
        kind: "image",
        name: node.name,
        x: node.x, y: node.y, width: node.width, height: node.height,
        assetId: asset.id,
        visible: node.visible,
        blendMode: node.blendMode,
      });
    }
    return out;
  };

  const plan = await toPlan(doc.children);
  const taken = new Set(Object.values(store.project.items).map((i) => i.name));
  const { items, root } = buildPsdImport(doc.name, plan, (name) => taken.has(name));

  const hostId = store.currentSymbolId;
  // A PSD is usually bigger than an 800x600 stage, and landing mostly
  // off-stage looks broken. In an empty project the document defines the
  // frame, so adopt its canvas; in a project with work in it, touching the
  // stage would be presumptuous.
  const empty = hostId === store.project.rootSymbolId
    && store.currentSymbol.layers.length === 0
    && store.project.itemOrder.length === 1;
  const resizeStage = empty
    && (doc.width !== store.project.stage.width || doc.height !== store.project.stage.height);
  const instance = createNode("symbol", root.name, { itemId: root.id, x: at.x, y: at.y });
  const layer = createLayer(instance.id, instance.name, store.currentSymbol.layers.length);

  store.transaction(`Import ${file.name}`, () => {
    // Children before parents, so a symbol never references an item the
    // library has not seen yet.
    for (const item of items) store.apply(new AddLibraryItem(`Import ${item.name}`, item));
    store.apply(new AddNode(`Import ${root.name}`, hostId, instance, layer, 0));
    if (resizeStage) {
      store.apply(new SetDocumentSettings({ width: doc.width, height: doc.height }));
    }
  });

  store.selectNodes([instance.id]);
  store.emit("library");
  store.emit("doc");

  if (resizeStage) store.emit("stage");

  return {
    symbolName: root.name,
    images,
    symbols: items.length - images,
    stage: resizeStage ? { width: doc.width, height: doc.height } : null,
    warnings: doc.warnings,
  };
}
