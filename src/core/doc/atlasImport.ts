import type { AssetId } from "./ids";
import { newFolderId } from "./ids";
import type { Keyframe, LibraryFolder, LibraryItem, SymbolItem } from "./types";
import { createAnimation, createImageItem, createLayer, createNode, createSymbol } from "./defaults";
import { tf } from "@/core/math/Transform";
import { TWEEN_NONE } from "@/core/math/easing";

/**
 * Turning the images of an atlas into library items: every image in one folder
 * named after the atlas, and each run of numbered frames (`walk_0001`,
 * `walk_0002`…) or animation the format names, when asked, a symbol playing
 * them frame by frame. Pure: the reader cuts the images and registers their
 * assets first.
 */

export interface AtlasImageIn {
  /** The region's name, as the format gives it. */
  name: string;
  assetId: AssetId;
  width: number;
  height: number;
  /** 0–1 of the image; absent: its centre. */
  pivot?: { x: number; y: number };
}

/** Frames in playing order, by region name; a name may come back. */
export interface AtlasSequence {
  name: string;
  frames: string[];
}

export interface AtlasImportResult {
  folder: LibraryFolder;
  /** Images first, then the symbols that show them. */
  items: LibraryItem[];
  symbols: SymbolItem[];
}

/** A region's name without the image extension TexturePacker keeps. */
export function imageName(region: string): string {
  return region.replace(/\.(png|jpe?g|webp|gif|bmp|tga)$/i, "");
}

/**
 * Runs of numbered names: the same prefix, then a number at the end, two
 * frames or more. In the order of their numbers; a sequence takes its prefix
 * as its name, without a trailing separator.
 */
export function sequencesOf(names: string[]): AtlasSequence[] {
  const runs = new Map<string, Array<{ n: number; name: string }>>();
  for (const name of names) {
    const m = /^(.*?)(\d+)$/.exec(imageName(name));
    if (!m) continue;
    (runs.get(m[1]!) ?? runs.set(m[1]!, []).get(m[1]!)!).push({ n: Number(m[2]), name });
  }
  const out: AtlasSequence[] = [];
  for (const [prefix, frames] of runs) {
    if (frames.length < 2) continue;
    frames.sort((a, b) => a.n - b.n);
    out.push({ name: prefix.replace(/[\s_\-./]+$/, "").split("/").pop() ?? "", frames: frames.map((f) => f.name) });
  }
  return out;
}

export function buildAtlasImport(
  atlasName: string, folderName: string, images: AtlasImageIn[], sequences: AtlasSequence[],
  taken: (name: string) => boolean,
): AtlasImportResult {
  const folder: LibraryFolder = { id: newFolderId(), name: folderName, parentId: null };
  const used = new Set<string>();
  const unique = (base: string) => {
    let n = base || "image";
    for (let i = 2; taken(n) || used.has(n); i++) n = `${base || "image"}_${i}`;
    used.add(n);
    return n;
  };

  const byRegion = new Map<string, { item: LibraryItem & { kind: "image" }; pivot: { x: number; y: number } }>();
  const items: LibraryItem[] = [];
  for (const img of images) {
    if (byRegion.has(img.name)) continue;
    const item = createImageItem(unique(imageName(img.name)), img.assetId, img.width, img.height);
    item.folderId = folder.id;
    const p = img.pivot ?? { x: 0.5, y: 0.5 };
    byRegion.set(img.name, { item, pivot: { x: p.x * img.width, y: p.y * img.height } });
    items.push(item);
  }

  const symbols: SymbolItem[] = [];
  for (const seq of sequences) {
    const frames = seq.frames.map((f) => byRegion.get(f)).filter((f) => !!f);
    if (!frames.length) continue;
    const sym = createSymbol(unique(seq.name || atlasName));
    sym.folderId = folder.id;
    const shown = [...new Set(frames)];
    const node = createNode("image", sym.name, { itemId: shown[0]!.item.id, pivotX: shown[0]!.pivot.x, pivotY: shown[0]!.pivot.y });
    if (shown.length > 1) node.extraDisplays = shown.slice(1).map((f) => ({ itemId: f.item.id, pivot: { ...f.pivot } }));
    sym.nodes[node.id] = node;
    sym.layers = [createLayer(node.id, node.name, 0)];
    const anim = createAnimation(seq.name || "animation", frames.length);
    // A key where the picture changes; a frame that repeats the one before holds.
    const keys: Keyframe[] = [];
    frames.forEach((f, i) => {
      const displayIndex = shown.indexOf(f);
      if (keys.at(-1)?.displayIndex === displayIndex) return;
      keys.push({ frame: i, transform: tf(), displayIndex, tween: TWEEN_NONE });
    });
    anim.tracks[node.id] = { nodeId: node.id, keys, endFrame: frames.length - 1 };
    sym.animations = [anim];
    symbols.push(sym);
  }
  return { folder, items: [...items, ...symbols], symbols };
}
