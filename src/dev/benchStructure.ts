import { createAnimation, createKeyframe, createLayer, createNode, createProject, createSymbol } from "@/core/doc/defaults";
import type { ImageItem, Project, SymbolItem } from "@/core/doc/types";
import { isSymbol } from "@/core/doc/types";
import { tf } from "@/core/math/Transform";

/** What a synthetic document looks like; the images are supplied separately
 *  because making them needs a canvas. */
export interface BenchSpec {
  /** Symbols, each nested one level in the scene. */
  symbols: number;
  /** Image layers in every symbol. */
  nodesPerSymbol: number;
  /** Keyframes on every layer. */
  keys: number;
  /** Symbols nested inside other symbols, on top of `symbols`. */
  nested: number;
}

export const BENCH_PRESETS: Record<string, BenchSpec> = {
  small: { symbols: 4, nodesPerSymbol: 8, keys: 12, nested: 1 },
  medium: { symbols: 16, nodesPerSymbol: 24, keys: 24, nested: 8 },
  large: { symbols: 40, nodesPerSymbol: 40, keys: 48, nested: 30 },
};

/**
 * A document of the shape `spec` asks for, drawing from `images`. Deterministic
 * (no randomness), so two runs measure the same thing. Pure: no canvas, no
 * assets.
 */
export function buildBenchProject(spec: BenchSpec, images: readonly ImageItem[]): Project {
  if (images.length === 0) throw new Error("A benchmark document needs at least one image");
  const project = createProject("Bench");
  const root = project.items[project.rootSymbolId];
  if (!isSymbol(root)) throw new Error("no root");
  for (const img of images) {
    project.items[img.id] = img;
    project.itemOrder.push(img.id);
  }

  const symbols: SymbolItem[] = [];
  for (let s = 0; s < spec.symbols + spec.nested; s++) {
    const sym = createSymbol(`part${s}`);
    const anim = sym.animations[0]!;
    anim.duration = spec.keys * 2;
    for (let n = 0; n < spec.nodesPerSymbol; n++) {
      const inner = s >= spec.symbols && n === 0 && symbols.length > 0
        ? symbols[(s + n) % spec.symbols]
        : undefined;
      const node = inner
        ? createNode("symbol", `inst${n}`, { itemId: inner.id, x: n * 3, y: s })
        : createNode("image", `img${n}`, { itemId: images[(s * 7 + n) % images.length]!.id, x: n * 5, y: s * 2 });
      sym.nodes[node.id] = node;
      sym.layers.push(createLayer(node.id, node.name, n));
      const keys = [];
      for (let k = 0; k < spec.keys; k++) {
        const key = createKeyframe(k * 2, node);
        key.transform = tf(node.bind.x + k, node.bind.y + (k % 5), 0, 0, 1, 1);
        keys.push(key);
      }
      anim.tracks[node.id] = { nodeId: node.id, keys, endFrame: spec.keys * 2 - 1 };
    }
    project.items[sym.id] = sym;
    project.itemOrder.push(sym.id);
    symbols.push(sym);
  }

  // The scene shows the top-level symbols.
  const animation = createAnimation("idle", spec.keys * 2);
  root.animations = [animation];
  for (let s = 0; s < spec.symbols; s++) {
    const node = createNode("symbol", `part${s}`, { itemId: symbols[s]!.id, x: s * 20, y: 0 });
    root.nodes[node.id] = node;
    root.layers.push(createLayer(node.id, node.name, s));
  }
  return project;
}

/** Layers, keys and library items a spec produces, for the report. */
export function describeBench(project: Project): { items: number; nodes: number; keys: number } {
  let nodes = 0, keys = 0;
  for (const item of Object.values(project.items)) {
    if (!isSymbol(item)) continue;
    nodes += Object.keys(item.nodes).length;
    for (const anim of item.animations) for (const track of Object.values(anim.tracks)) keys += track.keys.length;
  }
  return { items: Object.keys(project.items).length, nodes, keys };
}
