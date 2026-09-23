import type { Command, TouchSet } from "./Command";
import type { Animation, Layer, LibraryItem, Node, Project, SymbolItem, Track, } from "@/core/doc/types";
import { isSymbol } from "@/core/doc/types";
import { itemsOf } from "@/core/doc/displays";
import type { ItemId, LayerId, NodeId } from "@/core/doc/ids";
import { newItemId, newLayerId, newNodeId } from "@/core/doc/ids";
import { createAnimation, createLayer, createNode, createSymbol } from "@/core/doc/defaults";
import { evaluateSymbol, invalidateBounds, localBox } from "@/core/doc/pose";
import {
    denormalize,
    descendantsOf,
    type Normalization,
    normalizeLayerOrder,
    normalizeMasks,
} from "@/core/doc/layerTree";
import { apply } from "@/core/math/Matrix2D";

/**
 * Would placing `inserted` inside `host` close a loop?
 *
 * Has to be checked at EVERY entry point — placing from the library, pasting,
 * duplicating, converting a selection that already contains an instance —
 * because a cycle makes the renderer, the bounds cache and the exporter all
 * recurse until something gives.
 */
export function wouldCreateCycle(
  project: Project, hostId: ItemId, insertedId: ItemId, depth = 0,
): boolean {
  if (hostId === insertedId) return true;
  if (depth > 16) return true;                 // pathological nesting is a cycle for our purposes
  const inserted = project.items[insertedId];
  if (!isSymbol(inserted)) return false;
  for (const node of Object.values(inserted.nodes)) {
    for (const itemId of itemsOf(node)) {
      if (wouldCreateCycle(project, hostId, itemId, depth + 1)) return true;
    }
  }
  return false;
}

/** How deep a symbol's own nesting goes, for the depth cap. */
export function symbolDepth(project: Project, id: ItemId, depth = 0): number {
  if (depth > 16) return depth;
  const sym = project.items[id];
  if (!isSymbol(sym)) return depth;
  let deepest = depth;
  for (const node of Object.values(sym.nodes)) {
    for (const itemId of itemsOf(node)) {
      if (isSymbol(project.items[itemId])) deepest = Math.max(deepest, symbolDepth(project, itemId, depth + 1));
    }
  }
  return deepest;
}

/**
 * Convert a selection into a reusable Symbol, leaving one instance behind.
 *
 * A Symbol IS a DragonBones armature, so this is the operation that turns a
 * pile of layers into something the runtime can instance more than once.
 *
 * The transform bookkeeping is kept deliberately simple: the instance is
 * created under the selection's common parent with a pure translation and an
 * identity linear part, so moving the contents into the new symbol is just
 * "subtract the origin" — no matrix re-expression, and nothing can drift.
 */
export class ConvertToSymbol implements Command {
  readonly kind = "symbol.convert";
  readonly touches: TouchSet;
  readonly label = "Convert to Symbol";

  /** Available after apply(): the new symbol and the instance left behind. */
  symbol: SymbolItem | null = null;
  instance: Node | null = null;

  private movedNodes: Node[] = [];
  private movedLayers: Array<{ layer: Layer; index: number }> = [];
  private movedTracks: Array<{ animId: string; nodeId: NodeId; track: Track }> = [];
  private instanceLayer: Layer | null = null;
  private orderIndex = -1;
  /** What normalising the host changed — a mask whose targets all moved is
   *  demoted — undone before anything else. */
  private hostNorm: Normalization | null = null;

  constructor(
    private readonly hostId: ItemId,
    private readonly ids: NodeId[],
    private readonly name: string,
  ) {
    this.touches = { symbols: [hostId], nodes: ids, library: true, stage: true, timeline: true };
  }

  /** Reasons the conversion cannot proceed, for the caller to surface. */
  static validate(project: Project, hostId: ItemId, ids: NodeId[]): string | null {
    const host = project.items[hostId];
    if (!isSymbol(host)) return "No symbol is being edited.";
    if (ids.length === 0) return "Select something on the stage first.";
    for (const id of ids) {
      const node = host.nodes[id];
      if (node?.kind === "symbol" && node.itemId) {
        if (symbolDepth(project, node.itemId) >= 8) {
          return `"${node.name}" is already nested too deeply to wrap again.`;
        }
      }
    }
    return null;
  }

  apply(p: Project): void {
    const host = p.items[this.hostId];
    if (!isSymbol(host)) return;
    if (this.symbol) { this.reapply(p, host); return; }

    // Whole subtrees move, never half of one.
    const moving = new Set<NodeId>();
    for (const id of this.ids) {
      if (!host.nodes[id]) continue;
      moving.add(id);
      for (const child of descendantsOf(host, id)) moving.add(child);
    }
    if (moving.size === 0) return;

    const roots = [...moving].filter((id) => {
      const parent = host.nodes[id]?.parentId;
      return !parent || !moving.has(parent);
    });
    // Roots that disagree about their parent would need re-expressing; drop to
    // the top level rather than silently moving them somewhere unexpected.
    const firstParent = host.nodes[roots[0]!]?.parentId ?? null;
    const commonParent = roots.every((id) => (host.nodes[id]?.parentId ?? null) === firstParent)
      ? firstParent
      : null;

    const origin = this.registrationPoint(p, host, roots);

    // Build the new symbol, mirroring the host's animations so tracks have
    // somewhere to land.
    const symbol = createSymbol(this.name);
    symbol.animations = host.animations.map((a) => {
      const anim = createAnimation(a.name, a.duration);
      anim.playTimes = a.playTimes;
      return anim;
    });
    if (symbol.animations.length === 0) symbol.animations = [createAnimation()];

    // Move nodes and layers across, in the host's layer order.
    this.movedNodes = [];
    this.movedLayers = [];
    this.movedTracks = [];

    host.layers.forEach((layer, index) => {
      if (!moving.has(layer.nodeId)) return;
      this.movedLayers.push({ layer, index });
    });

    for (const { layer } of this.movedLayers) {
      const node = host.nodes[layer.nodeId]!;
      this.movedNodes.push(node);

      const relocated: Node = { ...node };
      if (roots.includes(node.id)) {
        // Only the roots shift: everything below is already relative to its
        // own parent and comes across unchanged.
        relocated.parentId = null;
        relocated.bind = { ...node.bind, x: node.bind.x - origin.x, y: node.bind.y - origin.y };
      }
      symbol.nodes[node.id] = relocated;
      symbol.layers.push({ ...layer });
    }

    for (const anim of host.animations) {
      const target = symbol.animations.find((a) => a.name === anim.name);
      for (const id of moving) {
        const track = anim.tracks[id];
        if (!track) continue;
        this.movedTracks.push({ animId: anim.id, nodeId: id, track });
        delete anim.tracks[id];
        if (!target) continue;
        target.tracks[id] = roots.includes(id)
          ? {
              ...track,
              keys: track.keys.map((k) => ({
                ...k,
                transform: { ...k.transform, x: k.transform.x - origin.x, y: k.transform.y - origin.y },
              })),
            }
          : track;
      }
    }

    for (const { layer } of this.movedLayers) {
      delete host.nodes[layer.nodeId];
    }
    host.layers = host.layers.filter((l) => !moving.has(l.nodeId));

    // Register the symbol and drop an instance where the selection was.
    p.items[symbol.id] = symbol;
    if (!p.itemOrder.includes(symbol.id)) {
      this.orderIndex = p.itemOrder.length;
      p.itemOrder.push(symbol.id);
    }

    const instance = createNode("symbol", this.name, {
      itemId: symbol.id, parentId: commonParent, x: origin.x, y: origin.y,
    });
    const at = this.movedLayers[0]?.index ?? 0;
    const layer = createLayer(instance.id, this.name, host.layers.length);
    host.nodes[instance.id] = instance;
    host.layers.splice(Math.min(at, host.layers.length), 0, layer);

    this.symbol = symbol;
    this.instance = instance;
    this.instanceLayer = layer;

    // A link to a mask that stayed behind points at a layer this symbol does
    // not have.
    normalizeMasks(symbol);
    this.hostNorm = normalizeLayerOrder(host);
    invalidateBounds();
  }

  /**
   * Redo puts back the SAME symbol and instance. Building fresh ones gave
   * them new ids, and every later step in the redo stack — moving the
   * instance, editing inside the symbol — then pointed at nothing.
   */
  private reapply(p: Project, host: SymbolItem): void {
    if (!this.symbol || !this.instance || !this.instanceLayer) return;
    const moving = new Set(this.movedNodes.map((n) => n.id));
    for (const { animId, nodeId } of this.movedTracks) {
      const anim = host.animations.find((a) => a.id === animId);
      if (anim) delete anim.tracks[nodeId];
    }
    for (const id of moving) delete host.nodes[id];
    host.layers = host.layers.filter((l) => !moving.has(l.nodeId));

    p.items[this.symbol.id] = this.symbol;
    if (!p.itemOrder.includes(this.symbol.id)) p.itemOrder.push(this.symbol.id);

    host.nodes[this.instance.id] = this.instance;
    const at = this.movedLayers[0]?.index ?? 0;
    host.layers.splice(Math.min(at, host.layers.length), 0, this.instanceLayer);
    this.hostNorm = normalizeLayerOrder(host);
    invalidateBounds();
  }

  revert(p: Project): void {
    const host = p.items[this.hostId];
    if (!isSymbol(host) || !this.symbol || !this.instance) return;

    if (this.hostNorm) denormalize(host, this.hostNorm);
    delete host.nodes[this.instance.id];
    if (this.instanceLayer) {
      host.layers = host.layers.filter((l) => l.id !== this.instanceLayer!.id);
    }

    for (const node of this.movedNodes) host.nodes[node.id] = node;
    for (const { layer, index } of [...this.movedLayers].sort((a, b) => a.index - b.index)) {
      host.layers.splice(Math.min(index, host.layers.length), 0, layer);
    }
    for (const { animId, nodeId, track } of this.movedTracks) {
      const anim = host.animations.find((a) => a.id === animId);
      if (anim) anim.tracks[nodeId] = track;
    }

    delete p.items[this.symbol.id];
    if (this.orderIndex >= 0) p.itemOrder = p.itemOrder.filter((i) => i !== this.symbol!.id);

    invalidateBounds();
  }

  estimateSize(): number { return this.movedNodes.length * 512 + 256; }

  /**
   * Where the symbol's origin sits: the centre of the selection's artwork,
   * so rotating the new instance behaves the way the user expects.
   */
  private registrationPoint(
    p: Project, host: SymbolItem, roots: NodeId[],
  ): { x: number; y: number } {
    const pose = evaluateSymbol(host, null, 0, "setup");
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const id of roots) {
      const entry = pose.byNode.get(id);
      const node = host.nodes[id];
      if (!entry || !node) continue;
      const box = localBox(p, node.itemId, node.pivot);
      if (!box) {
        minX = Math.min(minX, entry.world.tx); maxX = Math.max(maxX, entry.world.tx);
        minY = Math.min(minY, entry.world.ty); maxY = Math.max(maxY, entry.world.ty);
        continue;
      }
      for (const [cx, cy] of [
        [box.x, box.y], [box.x + box.w, box.y],
        [box.x + box.w, box.y + box.h], [box.x, box.y + box.h],
      ] as const) {
        const pt = apply({ x: 0, y: 0 }, entry.world, cx, cy);
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
      }
    }

    if (!Number.isFinite(minX)) {
      const first = host.nodes[roots[0]!];
      return { x: Math.round(first?.bind.x ?? 0), y: Math.round(first?.bind.y ?? 0) };
    }
    return { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2) };
  }
}

/** A blank symbol, for building one up from nothing. */
export class AddSymbol implements Command {
  readonly kind = "symbol.add";
  readonly touches: TouchSet = { library: true };
  readonly label = "New Symbol";
  readonly symbol: SymbolItem;

  constructor(name: string) { this.symbol = createSymbol(name); }

  apply(p: Project): void {
    p.items[this.symbol.id] = this.symbol;
    if (!p.itemOrder.includes(this.symbol.id)) p.itemOrder.push(this.symbol.id);
  }
  revert(p: Project): void {
    delete p.items[this.symbol.id];
    p.itemOrder = p.itemOrder.filter((i) => i !== this.symbol.id);
    invalidateBounds([this.symbol.id]);
  }
}

export type { Animation };


/**
 * Duplicate a library item.
 *
 * Images share the underlying asset — duplicating one is about getting a
 * second name and pivot, not a second copy of the pixels. Symbols are deep
 * copied with fresh ids, so editing the duplicate cannot reach back into the
 * original.
 */
export class DuplicateLibraryItem implements Command {
  readonly kind = "library.duplicate";
  readonly touches: TouchSet = { library: true };
  readonly label = "Duplicate";
  copy: SymbolItem | Node | null = null;
  private copyId: ItemId | null = null;
  /** The item this command made, re-inserted as it is on redo so its id — which
   *  later steps refer to — survives an undo. */
  private made: LibraryItem | null = null;

  constructor(private readonly sourceId: ItemId, private readonly name: string) {}

  apply(p: Project): void {
    if (this.made) {
      p.items[this.made.id] = this.made;
      if (!p.itemOrder.includes(this.made.id)) p.itemOrder.push(this.made.id);
      return;
    }
    const source = p.items[this.sourceId];
    if (!source) return;

    if (source.kind === "image") {
      const item = { ...source, id: newItemId(), name: this.name };
      p.items[item.id] = item;
      p.itemOrder.push(item.id);
      this.copyId = item.id;
      this.made = item;
      return;
    }

    const symbol = createSymbol(this.name);
    const idMap = new Map<NodeId, NodeId>();
    for (const id of Object.keys(source.nodes)) idMap.set(id as NodeId, newNodeId());
    const layerMap = new Map<LayerId, LayerId>();
    for (const layer of source.layers) layerMap.set(layer.id, newLayerId());

    for (const layer of source.layers) {
      const node = source.nodes[layer.nodeId];
      if (!node) continue;
      const id = idMap.get(node.id)!;
      symbol.nodes[id] = {
        ...structuredClone(node),
        id,
        parentId: node.parentId ? idMap.get(node.parentId) ?? null : null,
      };
      const copy: Layer = { ...structuredClone(layer), id: layerMap.get(layer.id)!, nodeId: id };
      // Mask links name LAYER ids, which are fresh here too.
      if (layer.maskedBy) {
        const mask = layerMap.get(layer.maskedBy);
        if (mask) copy.maskedBy = mask;
        else delete copy.maskedBy;
      }
      symbol.layers.push(copy);
    }
    normalizeMasks(symbol);

    symbol.animations = source.animations.map((anim) => {
      const next = createAnimation(anim.name, anim.duration);
      next.playTimes = anim.playTimes;
      for (const [nodeId, track] of Object.entries(anim.tracks)) {
        const id = idMap.get(nodeId as NodeId);
        if (!id || !track) continue;
        next.tracks[id] = { ...structuredClone(track), nodeId: id };
      }
      return next;
    });
    if (symbol.animations.length === 0) symbol.animations = [createAnimation()];

    symbol.ik = source.ik
      .filter((k) => idMap.has(k.boneId) && idMap.has(k.targetId))
      .map((k) => ({ ...k, boneId: idMap.get(k.boneId)!, targetId: idMap.get(k.targetId)! }));

    p.items[symbol.id] = symbol;
    p.itemOrder.push(symbol.id);
    this.copy = symbol;
    this.copyId = symbol.id;
    this.made = symbol;
  }

  revert(p: Project): void {
    if (!this.copyId) return;
    delete p.items[this.copyId];
    p.itemOrder = p.itemOrder.filter((i) => i !== this.copyId);
    invalidateBounds([this.copyId]);
  }

  get newItemId(): ItemId | null { return this.copyId; }
}
