import { type AssetId, type FolderId, newFolderId } from "./ids";
import type { BlendMode, Layer, LibraryFolder, LibraryItem, Node, SymbolItem } from "./types";
import { createImageItem, createLayer, createNode, createSymbol } from "./defaults";

/**
 * Turning a Photoshop document into library items.
 *
 * The mapping is one-to-one with what the artist sees:
 *
 *   layer group  →  Symbol (its own armature), and a library folder holding
 *                   that symbol and its layers' images
 *   raster layer →  ImageItem, instanced once inside its group's symbol
 *   the document →  one Symbol wrapping the lot, at canvas coordinates, in
 *                   the top folder
 *
 * The library therefore reads like Photoshop's Layers panel. A group with no
 * layers gets no folder of its own: its symbol sits in the parent's.
 *
 * Two things have to be got right or everything after is subtly wrong.
 *
 * **Stacking.** Photoshop stores children bottom-to-top: the LAST child is
 * the one in front. Our `layers[0]` is the top row, drawn in front. So the
 * lists are reverses of each other — the same relationship the exporter has
 * with `armature.slot[]`, for the same reason.
 *
 * **Origins.** Every group symbol is built around the top-left of its own
 * content's bounding box, and its instance carries that offset. Positions
 * therefore come out identical to the PSD, while each symbol still has a
 * local origin near its own artwork rather than at a canvas corner half a
 * document away — which is what makes it possible to animate afterwards.
 *
 * This file is pure: no DOM, no ag-psd types. The reader hands it a plan with
 * assets already registered, which is what lets the whole mapping be tested.
 */

export interface PsdImagePlan {
  kind: "image";
  name: string;
  /** The layer's own pixel bounds, in canvas space. */
  x: number;
  y: number;
  width: number;
  height: number;
  assetId: AssetId;
  visible: boolean;
  blendMode?: BlendMode;
}

export interface PsdGroupPlan {
  kind: "group";
  name: string;
  visible: boolean;
  /** Bottom-to-top, exactly as Photoshop stores them. */
  children: PsdPlan[];
}

export type PsdPlan = PsdImagePlan | PsdGroupPlan;

export interface PsdImportResult {
  /** Everything to add to the library, children before their parents. */
  items: LibraryItem[];
  /** The symbol wrapping the whole document; last entry of `items`. */
  root: SymbolItem;
  /** The library folders, parents before children; the first is the top one
   *  (`parentId` null). Every item's `folderId` names one of them. */
  folders: LibraryFolder[];
}

export interface Box { x: number; y: number; w: number; h: number }

/** Union of the pixel bounds under a plan node; null when it has no pixels. */
export function planBounds(plan: PsdPlan): Box | null {
  if (plan.kind === "image") {
    return plan.width > 0 && plan.height > 0
      ? { x: plan.x, y: plan.y, w: plan.width, h: plan.height }
      : null;
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const child of plan.children) {
    const b = planBounds(child);
    if (!b) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function buildPsdImport(
  documentName: string,
  children: PsdPlan[],
  /** True when the library already has an item with this name. */
  isNameTaken: (name: string) => boolean = () => false,
  /** The top folder's name, already made unique among the library's top
   *  level by the caller. */
  folderName: string = documentName,
): PsdImportResult {
  const items: LibraryItem[] = [];
  const folders: LibraryFolder[] = [];

  // New folders only have each other for siblings: "eyes", "eyes 2".
  const folder = (base: string, parentId: FolderId | null): FolderId => {
    const stem = base.trim() || "Group";
    const taken = (n: string) => folders.some((f) => f.parentId === parentId && f.name === n);
    let name = stem;
    for (let i = 2; taken(name); i++) name = `${stem} ${i}`;
    const f: LibraryFolder = { id: newFolderId(), name, parentId };
    folders.push(f);
    return f.id;
  };
  const claimed = new Set<string>();

  const unique = (base: string): string => {
    const stem = base.trim() || "Layer";
    const free = (n: string) => !claimed.has(n) && !isNameTaken(n);
    if (free(stem)) { claimed.add(stem); return stem; }
    for (let i = 2; ; i++) {
      const candidate = `${stem}_${i}`;
      if (free(candidate)) { claimed.add(candidate); return candidate; }
    }
  };

  // Photoshop leaves layers unnamed more often than you would think, and a
  // library full of "" helps nobody. Numbered in import order, as PS does.
  let unnamed = 0;
  const nameOf = (plan: PsdPlan): string => plan.name.trim() || `Layer ${++unnamed}`;

  const build = (
    name: string, kids: PsdPlan[], originX: number, originY: number, folderId: FolderId,
  ): SymbolItem => {
    const symbol = createSymbol(unique(name));
    symbol.folderId = folderId;

    // Reversed: Photoshop's last child is the front one, and our layers[0] is.
    [...kids].reverse().forEach((child, index) => {
      let node: Node;
      if (child.kind === "image") {
        const item = createImageItem(
          unique(nameOf(child)), child.assetId, child.width, child.height,
        );
        item.folderId = folderId;
        items.push(item);
        node = createNode("image", item.name, {
          itemId: item.id, x: child.x - originX, y: child.y - originY,
        });
        if (child.blendMode && child.blendMode !== "normal") node.blendMode = child.blendMode;
      } else {
        // An empty group has no bounds of its own; anchor it where it sits so
        // adding art to it later does not move everything else.
        const b = planBounds(child) ?? { x: originX, y: originY, w: 0, h: 0 };
        const groupName = nameOf(child);
        const inside = child.children.length > 0 ? folder(groupName, folderId) : folderId;
        const nested = build(groupName, child.children, b.x, b.y, inside);
        items.push(nested);
        node = createNode("symbol", nested.name, {
          itemId: nested.id, x: b.x - originX, y: b.y - originY,
        });
      }

      symbol.nodes[node.id] = node;
      const layer: Layer = createLayer(node.id, node.name, index);
      layer.visible = child.visible;
      symbol.layers.push(layer);
    });

    return symbol;
  };

  const root = build(documentName, children, 0, 0, folder(folderName, null));
  items.push(root);
  return { items, root, folders };
}
