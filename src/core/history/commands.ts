import { adoptBefore, type Command, type TouchSet } from "./Command";
import type {
    BlendMode,
    ColorTransform,
    DisplayRef,
    Keyframe,
    Layer,
    LibraryItem,
    MotionBlurSettings,
    Node,
    NodeKind,
    Project,
    SymbolItem,
    Track,
} from "@/core/doc/types";
import { DEFAULT_MOTION_BLUR, isDefaultColor, isImage, isSymbol } from "@/core/doc/types";
import type { Transform } from "@/core/math/Transform";
import { type ExportSettings, isDefaultExport } from "@/core/export/settings";
import { cloneTf, fromMatrix, translateLocal } from "@/core/math/Transform";
import { invert, mat, type Matrix2D, mul } from "@/core/math/Matrix2D";
import type { AssetId, ItemId, LayerId, NodeId } from "@/core/doc/ids";
import { evaluateSymbol, invalidateBounds, type Pose } from "@/core/doc/pose";
import {
    assignMask,
    denormalize,
    type MaskState,
    maskStateOf,
    type Normalization,
    normalizeLayerOrder,
    normalizeMasks,
} from "@/core/doc/layerTree";
import { durationFor } from "./timelineCommands";

function symbolOf(p: Project, id: ItemId): SymbolItem {
  const s = p.items[id];
  if (!isSymbol(s)) throw new Error(`Not a symbol: ${id}`);
  return s;
}

/* ── Library ─────────────────────────────────────────────────────────────*/

export class AddLibraryItem implements Command {
  readonly kind = "library.add";
  readonly touches: TouchSet = { library: true };
  constructor(readonly label: string, private readonly item: LibraryItem) {}

  apply(p: Project): void {
    p.items[this.item.id] = this.item;
    if (!p.itemOrder.includes(this.item.id)) p.itemOrder.push(this.item.id);
  }
  revert(p: Project): void {
    delete p.items[this.item.id];
    p.itemOrder = p.itemOrder.filter((i) => i !== this.item.id);
    invalidateBounds([this.item.id]);
  }
}

export class RenameLibraryItem implements Command {
  readonly kind = "library.rename";
  readonly touches: TouchSet;
  private before = "";
  constructor(private readonly id: ItemId, private readonly name: string) {
    this.touches = { library: true, symbols: [id] };
  }
  get label(): string { return "Rename"; }

  /**
   * Whether another library item already has `name`. The exporter refuses
   * such a clash — the runtime finds armatures and textures by name — so the
   * rename is the place to stop it being made.
   */
  static clashes(p: Project, id: ItemId, name: string): boolean {
    return Object.values(p.items).some((i) => i.id !== id && i.name === name);
  }

  apply(p: Project): void {
    const item = p.items[this.id];
    if (!item) return;
    this.before = item.name;
    item.name = this.name;
  }
  revert(p: Project): void {
    const item = p.items[this.id];
    if (item) item.name = this.before;
  }
}

/**
 * Swap the pixels behind an ImageItem, keeping its `ItemId`, so every instance
 * — with its pose, its keyframes and its IK — keeps working.
 *
 * The new asset is registered BEFORE this command is applied (the same rule
 * PSD import follows), which is what lets `apply` stay a pure swap of three
 * fields and `revert` a pure swap back. Transform points are left alone even
 * when the size changes; the caller says so, because the exporter normalises
 * pivots against the untrimmed size and the anchor visibly moves.
 */
export class ReplaceImageAsset implements Command {
  readonly kind = "library.replace";
  readonly touches: TouchSet;
  readonly label = "Replace Image";
  private before: { assetId: AssetId; width: number; height: number } | null = null;

  constructor(
    private readonly id: ItemId,
    private readonly next: { assetId: AssetId; width: number; height: number },
    /** Symbols holding an instance, so their cached bounds are refreshed. */
    hosts: ItemId[],
  ) {
    this.touches = { library: true, symbols: hosts, stage: true };
  }

  apply(p: Project): void {
    const item = p.items[this.id];
    if (!isImage(item)) return;
    this.before = { assetId: item.assetId, width: item.width, height: item.height };
    Object.assign(item, this.next);
    // Reaches every symbol measured through this image.
    invalidateBounds([this.id]);
  }

  revert(p: Project): void {
    const item = p.items[this.id];
    if (!isImage(item) || !this.before) return;
    Object.assign(item, this.before);
    invalidateBounds([this.id]);
  }
}

/**
 * Deleting a library item is refused while instances exist, so this command
 * never has to repair dangling references.
 */
export class RemoveLibraryItem implements Command {
  readonly kind = "library.remove";
  readonly touches: TouchSet = { library: true };
  readonly label = "Delete Library Item";
  private item: LibraryItem | null = null;
  private orderIndex = -1;
  constructor(private readonly id: ItemId) {}

  apply(p: Project): void {
    this.item = p.items[this.id] ?? null;
    this.orderIndex = p.itemOrder.indexOf(this.id);
    delete p.items[this.id];
    p.itemOrder = p.itemOrder.filter((i) => i !== this.id);
    invalidateBounds([this.id]);
  }
  revert(p: Project): void {
    if (!this.item) return;
    p.items[this.id] = this.item;
    const order = [...p.itemOrder];
    order.splice(this.orderIndex < 0 ? order.length : this.orderIndex, 0, this.id);
    p.itemOrder = order;
  }
}

/* ── Nodes and layers ────────────────────────────────────────────────────*/

export class AddNode implements Command {
  readonly kind = "node.add";
  readonly touches: TouchSet;
  constructor(
    readonly label: string,
    private readonly symbolId: ItemId,
    private readonly node: Node,
    private readonly layer: Layer,
    /** Insert position in the layer list; 0 is the top layer. */
    private readonly at = 0,
  ) {
    this.touches = { symbols: [symbolId], nodes: [node.id], stage: true, timeline: true };
  }

  private norm: Normalization | null = null;

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    sym.nodes[this.node.id] = this.node;
    sym.layers.splice(Math.min(this.at, sym.layers.length), 0, this.layer);
    this.norm = normalizeLayerOrder(sym);
    invalidateBounds([this.symbolId]);
  }
  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.norm) denormalize(sym, this.norm);
    delete sym.nodes[this.node.id];
    sym.layers = sym.layers.filter((l) => l.id !== this.layer.id);
    for (const anim of sym.animations) delete anim.tracks[this.node.id];
    invalidateBounds([this.symbolId]);
  }
}

/**
 * Removing a node keeps the whole detached subtree — the node, its layer,
 * its animation tracks and any IK constraints referencing it — alive inside
 * the command. Ids are never remapped, so redo and every later command still
 * resolve their references.
 */
export class RemoveNodes implements Command {
  readonly kind = "node.remove";
  readonly touches: TouchSet;
  readonly label = "Delete";

  private removedNodes: Node[] = [];
  private removedLayers: Array<{ layer: Layer; index: number }> = [];
  private removedTracks: Array<{ animId: string; nodeId: NodeId; track: unknown }> = [];
  private removedIk: Array<{ index: number; constraint: unknown }> = [];
  private reparented: Array<{ nodeId: NodeId; oldParent: NodeId | null }> = [];
  private durations: Array<{ animId: string; before: number }> = [];
  private norm: Normalization | null = null;

  constructor(private readonly symbolId: ItemId, private readonly ids: NodeId[]) {
    this.touches = { symbols: [symbolId], nodes: ids, stage: true, timeline: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const doomed = new Set<NodeId>();
    const collect = (id: NodeId) => {
      if (doomed.has(id)) return;
      doomed.add(id);
      for (const n of Object.values(sym.nodes)) {
        if (n.parentId === id) collect(n.id);
      }
    };
    for (const id of this.ids) collect(id);

    this.removedNodes = [];
    this.removedLayers = [];
    this.removedTracks = [];
    this.removedIk = [];
    this.reparented = [];

    // Indices in the list as it was, so re-inserting in ascending order
    // rebuilds it. Taken one removal at a time, a group and its children all
    // got the group's index and came back in reverse.
    sym.layers.forEach((layer, index) => {
      if (doomed.has(layer.nodeId) && sym.nodes[layer.nodeId]) this.removedLayers.push({ layer, index });
    });
    sym.layers = sym.layers.filter((l) => !this.removedLayers.some((r) => r.layer === l));

    for (const id of doomed) {
      const node = sym.nodes[id];
      if (!node) continue;
      this.removedNodes.push(node);
      delete sym.nodes[id];
      for (const anim of sym.animations) {
        const t = anim.tracks[id];
        if (t) {
          this.removedTracks.push({ animId: anim.id, nodeId: id, track: t });
          delete anim.tracks[id];
        }
      }
    }

    for (let i = sym.ik.length - 1; i >= 0; i--) {
      const k = sym.ik[i]!;
      if (doomed.has(k.boneId) || doomed.has(k.targetId)) {
        this.removedIk.push({ index: i, constraint: k });
        sym.ik.splice(i, 1);
      }
    }

    // The animation is as long as its longest track, so deleting the layer
    // that reached furthest shortens it. Leaving the number alone left the
    // timeline claiming frames nothing was on any more. `durationFor` keeps
    // the stored value when NOTHING is keyed, so deleting the last keyed
    // layer does not collapse the animation to one frame.
    this.durations = [];
    for (const anim of sym.animations) {
      this.durations.push({ animId: anim.id, before: anim.duration });
      anim.duration = durationFor(anim);
    }

    // Deleting a mask leaves its targets linked to nothing.
    this.norm = normalizeLayerOrder(sym);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.norm) denormalize(sym, this.norm);
    for (const { animId, before } of this.durations) {
      const anim = sym.animations.find((a) => a.id === animId);
      if (anim) anim.duration = before;
    }
    for (const n of this.removedNodes) sym.nodes[n.id] = n;
    for (const { layer, index } of [...this.removedLayers].sort((a, b) => a.index - b.index)) {
      sym.layers.splice(Math.min(index, sym.layers.length), 0, layer);
    }
    for (const { animId, nodeId, track } of this.removedTracks) {
      const anim = sym.animations.find((a) => a.id === animId);
      if (anim) anim.tracks[nodeId] = track as never;
    }
    for (const { index, constraint } of [...this.removedIk].sort((a, b) => a.index - b.index)) {
      sym.ik.splice(Math.min(index, sym.ik.length), 0, constraint as never);
    }
    for (const { nodeId, oldParent } of this.reparented) {
      const n = sym.nodes[nodeId];
      if (n) n.parentId = oldParent;
    }
    invalidateBounds([this.symbolId]);
  }

  estimateSize(): number { return this.removedNodes.length * 512; }
}

/**
 * Sets a node's bind transform. Merges during a drag so a 60fps gizmo lands
 * in history as a single undo entry.
 */
export class SetBindTransform implements Command {
  readonly kind = "node.transform";
  readonly touches: TouchSet;
  readonly label = "Transform";
  private before = new Map<NodeId, Transform>();
  private after: Map<NodeId, Transform>;

  constructor(private readonly symbolId: ItemId, next: Map<NodeId, Transform>) {
    this.after = new Map([...next].map(([k, v]) => [k, cloneTf(v)]));
    this.touches = { symbols: [symbolId], nodes: [...next.keys()], stage: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.before.size === 0) {
      for (const id of this.after.keys()) {
        const n = sym.nodes[id];
        if (n) this.before.set(id, cloneTf(n.bind));
      }
    }
    for (const [id, t] of this.after) {
      const n = sym.nodes[id];
      if (n) n.bind = cloneTf(t);
    }
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, t] of this.before) {
      const n = sym.nodes[id];
      if (n) n.bind = cloneTf(t);
    }
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetBindTransform)) return false;
    if (next.symbolId !== this.symbolId) return false;
    this.touches.nodes?.push(...adoptBefore(this.before, next.before));
    for (const [id, t] of next.after) this.after.set(id, cloneTf(t));
    return true;
  }
}

/**
 * Bind-pose colour, the Setup-mode counterpart of a keyframe's `color`.
 *
 * Merges like SetBindTransform so dragging a colour slider is one undo entry
 * rather than one per pointermove.
 */
export class SetBindColor implements Command {
  readonly kind = "node.color";
  readonly touches: TouchSet;
  readonly label = "Colour";
  private before = new Map<NodeId, ColorTransform | undefined>();
  private after: Map<NodeId, ColorTransform | undefined>;

  constructor(private readonly symbolId: ItemId, next: Map<NodeId, ColorTransform | undefined>) {
    this.after = new Map([...next].map(([k, v]) => [k, v ? { ...v } : undefined]));
    this.touches = { symbols: [symbolId], nodes: [...next.keys()], stage: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.before.size === 0) {
      for (const id of this.after.keys()) {
        const n = sym.nodes[id];
        if (n) this.before.set(id, n.color ? { ...n.color } : undefined);
      }
    }
    for (const [id, c] of this.after) {
      const n = sym.nodes[id];
      if (n) assignColor(n, c);
    }
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, c] of this.before) {
      const n = sym.nodes[id];
      if (n) assignColor(n, c);
    }
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetBindColor)) return false;
    if (next.symbolId !== this.symbolId) return false;
    this.touches.nodes?.push(...adoptBefore(this.before, next.before));
    for (const [id, c] of next.after) this.after.set(id, c ? { ...c } : undefined);
    return true;
  }
}

/** A neutral colour is stored as absent, so `isDefaultColor` stays the one test. */
function assignColor(n: Node, c: ColorTransform | undefined): void {
  if (!c || isDefaultColor(c)) delete n.color;
  else n.color = { ...c };
}

/**
 * Blend mode is a SETUP-pose property: the runtime has no blendMode timeline
 * (`Slot.init` reads it once from `_slotData`), so it cannot be keyed.
 */
export class SetNodeBlendMode implements Command {
  readonly kind = "node.blendMode";
  readonly touches: TouchSet;
  readonly label = "Blend Mode";
  private before = new Map<NodeId, BlendMode | undefined>();

  constructor(
    private readonly symbolId: ItemId,
    private readonly nodeIds: NodeId[],
    private readonly value: BlendMode,
  ) {
    this.touches = { symbols: [symbolId], nodes: [...nodeIds], stage: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.before.clear();
    for (const id of this.nodeIds) {
      const n = sym.nodes[id];
      if (!n) continue;
      this.before.set(id, n.blendMode);
      if (this.value === "normal") delete n.blendMode;
      else n.blendMode = this.value;
    }
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, m] of this.before) {
      const n = sym.nodes[id];
      if (!n) continue;
      if (m === undefined) delete n.blendMode;
      else n.blendMode = m;
    }
  }
}

/**
 * Motion blur multiplier. A setup property like blend mode: the runtime
 * extension reads it once per slot, so it cannot be keyed.
 */
export class SetNodeMotionBlur implements Command {
  readonly kind = "node.motionBlur";
  readonly touches: TouchSet;
  readonly label = "Motion Blur";
  private before = new Map<NodeId, number | undefined>();

  constructor(
    private readonly symbolId: ItemId,
    private readonly nodeIds: NodeId[],
    private value: number,
  ) {
    this.touches = { symbols: [symbolId], nodes: [...nodeIds] };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.before.clear();
    const v = Math.max(0, Math.min(2, Number.isFinite(this.value) ? this.value : 1));
    for (const id of this.nodeIds) {
      const n = sym.nodes[id];
      if (!n) continue;
      this.before.set(id, n.motionBlur);
      if (v === 1) delete n.motionBlur;
      else n.motionBlur = v;
    }
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, m] of this.before) {
      const n = sym.nodes[id];
      if (!n) continue;
      if (m === undefined) delete n.motionBlur;
      else n.motionBlur = m;
    }
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetNodeMotionBlur) || next.symbolId !== this.symbolId) return false;
    if (next.nodeIds.join() !== this.nodeIds.join()) return false;
    this.value = next.value;
    return true;
  }
}

/**
 * Point a node at a different library item — Flash's "Swap Symbol", and the
 * same command that fills an empty layer when something is dropped on it.
 *
 * An instance differs from another in its display: `kind` and `itemId` for
 * display 0, an entry of `extraDisplays` otherwise; the bind pose, the transform point, colour, blend mode, the
 * layer, every keyframe and every IK constraint live elsewhere on the node or
 * the symbol and survive untouched. `kind` has to move with `itemId` because
 * the exporter reads it (`node.kind === "symbol"` picks the armature display),
 * even though the renderer resolves the item and would self-correct.
 *
 * Transform points are deliberately NOT compensated for a size change: the
 * intent is "same pose, different artwork", exactly as Flash behaves.
 * `wouldCreateCycle` is the caller's job, as it is on every other entry point
 * that can put a symbol inside another.
 */
export class SetNodeItem implements Command {
  readonly kind = "node.item";
  readonly touches: TouchSet;
  readonly label = "Swap Instance";
  private before = new Map<NodeId, { itemId?: ItemId; kind: NodeKind; extras?: DisplayRef[] }>();

  /** `display` ≥ 1 swaps that entry of `extraDisplays` and leaves `kind`,
   *  which describes display 0, alone. */
  constructor(
    private readonly symbolId: ItemId,
    private readonly next: Map<NodeId, { itemId: ItemId; kind: NodeKind; display?: number }>,
  ) {
    this.touches = {
      symbols: [symbolId], nodes: [...next.keys()], stage: true, timeline: true,
    };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.before.clear();
    for (const [id, to] of this.next) {
      const n = sym.nodes[id];
      if (!n) continue;
      this.before.set(id, { itemId: n.itemId, kind: n.kind, extras: n.extraDisplays });
      const d = to.display ?? 0;
      if (d > 0 && n.extraDisplays?.[d - 1]) {
        n.extraDisplays = n.extraDisplays.map((e, i) =>
          (i === d - 1 ? { itemId: to.itemId, pivot: e.pivot } : e));
        continue;
      }
      n.itemId = to.itemId;
      n.kind = to.kind;
    }
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, was] of this.before) {
      const n = sym.nodes[id];
      if (!n) continue;
      if (was.itemId === undefined) delete n.itemId;
      else n.itemId = was.itemId;
      n.kind = was.kind;
      if (was.extras) n.extraDisplays = was.extras;
      else delete n.extraDisplays;
    }
    invalidateBounds([this.symbolId]);
  }
}

/**
 * Replace a node's `extraDisplays` — how pasted frames bring artwork a
 * layer did not have. A value like a track: the new array goes in, the old
 * one comes back on undo, and neither is ever edited.
 */
export class SetNodeDisplays implements Command {
  readonly kind = "node.displays";
  readonly touches: TouchSet;
  readonly label = "Add Display";
  private before = new Map<NodeId, DisplayRef[] | undefined>();

  constructor(
    private readonly symbolId: ItemId,
    private readonly next: Map<NodeId, DisplayRef[]>,
  ) {
    this.touches = { symbols: [symbolId], nodes: [...next.keys()], stage: true, timeline: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.before.clear();
    for (const [id, extras] of this.next) {
      const n = sym.nodes[id];
      if (!n) continue;
      this.before.set(id, n.extraDisplays);
      if (extras.length) n.extraDisplays = extras;
      else delete n.extraDisplays;
    }
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, was] of this.before) {
      const n = sym.nodes[id];
      if (!n) continue;
      if (was) n.extraDisplays = was;
      else delete n.extraDisplays;
    }
    invalidateBounds([this.symbolId]);
  }
}

export type { MaskState };

/**
 * Set the mask links of several layers at once.
 *
 * One command rather than a "make mask" and an "unlink" pair, because every
 * mask edit touches BOTH ends of the relationship — making a layer a mask
 * links the one below it, and clearing a mask has to clear every link
 * pointing at it. The caller computes the whole desired state; this just
 * swaps it in and remembers what was there.
 */
export class SetLayerMasks implements Command {
  readonly kind = "layer.mask";
  readonly touches: TouchSet;
  readonly label = "Mask";
  /** The layers this set, as they were. */
  private before = new Map<LayerId, MaskState>();
  /** What `normalizeMasks` changed on top: unlinking the last target
   *  demotes its mask, which `next` does not mention. */
  private norm: Normalization | null = null;

  constructor(
    private readonly symbolId: ItemId,
    private readonly next: Map<LayerId, MaskState>,
  ) {
    this.touches = { symbols: [symbolId], stage: true, timeline: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.before = new Map();
    for (const [id, state] of this.next) {
      const l = sym.layers.find((x) => x.id === id);
      if (!l) continue;
      this.before.set(id, maskStateOf(l));
      assignMask(l, state);
    }
    this.norm = normalizeMasks(sym);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.norm) denormalize(sym, this.norm);
    for (const [id, state] of this.before) {
      const l = sym.layers.find((x) => x.id === id);
      if (l) assignMask(l, state);
    }
  }
}

export class ReorderLayer implements Command {
  readonly kind = "layer.reorder";
  readonly touches: TouchSet;
  readonly label = "Reorder Layer";
  private from = -1;
  private norm: Normalization | null = null;
  constructor(
    private readonly symbolId: ItemId,
    private readonly layerId: string,
    private readonly to: number,
  ) {
    this.touches = { symbols: [symbolId], stage: true, timeline: true };
  }
  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.from = sym.layers.findIndex((l) => l.id === this.layerId);
    if (this.from < 0) return;
    const [layer] = sym.layers.splice(this.from, 1);
    sym.layers.splice(Math.max(0, Math.min(this.to, sym.layers.length)), 0, layer!);
    this.norm = normalizeLayerOrder(sym);
  }
  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.from < 0) return;
    if (this.norm) denormalize(sym, this.norm);
    const i = sym.layers.findIndex((l) => l.id === this.layerId);
    if (i < 0) return;
    const [layer] = sym.layers.splice(i, 1);
    sym.layers.splice(this.from, 0, layer!);
  }
}

export class SetLayerFlag implements Command {
  readonly kind = "layer.flag";
  readonly touches: TouchSet;
  private before = false;
  constructor(
    private readonly symbolId: ItemId,
    private readonly layerId: string,
    private readonly flag: "visible" | "locked" | "outline",
    private readonly value: boolean,
  ) {
    this.touches = { symbols: [symbolId], stage: true, timeline: true };
  }
  get label(): string { return `Toggle ${this.flag}`; }
  apply(p: Project): void {
    const l = symbolOf(p, this.symbolId).layers.find((x) => x.id === this.layerId);
    if (!l) return;
    this.before = l[this.flag];
    l[this.flag] = this.value;
  }
  revert(p: Project): void {
    const l = symbolOf(p, this.symbolId).layers.find((x) => x.id === this.layerId);
    if (l) l[this.flag] = this.before;
  }
}

/**
 * "Exclude from Export" — reference art and test rigs that must not reach the
 * file.
 *
 * A sibling of `SetLayerFlag` rather than a fourth entry in its union: that
 * command indexes `l[this.flag]` and assumes a required boolean, while this
 * flag has to be ABSENT when off so a saved file stays clean.
 */
export class SetLayerExcluded implements Command {
  readonly kind = "layer.flag";
  readonly touches: TouchSet;
  private before = new Map<LayerId, boolean>();
  constructor(
    private readonly symbolId: ItemId,
    private readonly layerIds: LayerId[],
    private readonly value: boolean,
  ) {
    this.touches = { symbols: [symbolId], timeline: true };
  }
  get label(): string { return this.value ? "Exclude from Export" : "Include in Export"; }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.before.clear();
    for (const id of this.layerIds) {
      const l = sym.layers.find((x) => x.id === id);
      if (!l) continue;
      this.before.set(id, l.excludeFromExport === true);
      if (this.value) l.excludeFromExport = true;
      else delete l.excludeFromExport;
    }
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, was] of this.before) {
      const l = sym.layers.find((x) => x.id === id);
      if (!l) continue;
      if (was) l.excludeFromExport = true;
      else delete l.excludeFromExport;
    }
  }
}

export class RenameLayer implements Command {
  readonly kind = "layer.rename";
  readonly touches: TouchSet;
  readonly label = "Rename Layer";
  private before = "";
  private beforeNode = "";
  constructor(
    private readonly symbolId: ItemId,
    private readonly layerId: string,
    private readonly name: string,
  ) {
    this.touches = { symbols: [symbolId], timeline: true };
  }
  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const l = sym.layers.find((x) => x.id === this.layerId);
    if (!l) return;
    this.before = l.name;
    l.name = this.name;
    const n = sym.nodes[l.nodeId];
    if (n) { this.beforeNode = n.name; n.name = this.name; }
  }
  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const l = sym.layers.find((x) => x.id === this.layerId);
    if (!l) return;
    l.name = this.before;
    const n = sym.nodes[l.nodeId];
    if (n) n.name = this.beforeNode;
  }
}

export class SetParent implements Command {
  readonly kind = "node.parent";
  readonly touches: TouchSet;
  readonly label = "Set Parent";
  private beforeParent = new Map<NodeId, NodeId | null>();
  private beforeBind = new Map<NodeId, Transform>();
  /** The tracks whose keys were re-expressed, as they were. */
  private beforeTracks: Array<{ animId: string; nodeId: NodeId; track: Track }> = [];
  private norm: Normalization | null = null;

  constructor(
    private readonly symbolId: ItemId,
    private readonly ids: NodeId[],
    private readonly parentId: NodeId | null,
    /** Keep the object visually where it is, re-expressing its transform in
     *  the new parent's space. Off means "adopt the parent's frame", which
     *  makes the object jump — occasionally wanted, never the default. */
    private readonly preserveWorld = true,
  ) {
    this.touches = { symbols: [symbolId], nodes: ids, stage: true, timeline: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const moving = this.ids.filter((id) => {
      const n = sym.nodes[id];
      if (!n) return false;
      return !(this.parentId && createsCycle(sym, id, this.parentId));
    });
    if (moving.length === 0) return;

    if (!this.preserveWorld) {
      for (const id of moving) {
        const n = sym.nodes[id]!;
        this.beforeParent.set(id, n.parentId);
        n.parentId = this.parentId;
      }
      this.norm = normalizeLayerOrder(sym);
      invalidateBounds([this.symbolId]);
      return;
    }

    // Capture where everything is BEFORE the parent changes: the setup pose,
    // plus each animation at each frame the moving nodes have a keyframe on.
    // Re-expressing only the bind pose would leave every existing keyframe
    // describing a position in a coordinate space that no longer exists.
    const framesByAnim = new Map<string, Set<number>>();
    for (const anim of sym.animations) {
      const frames = new Set<number>();
      for (const id of moving) {
        for (const key of anim.tracks[id]?.keys ?? []) frames.add(key.frame);
      }
      if (frames.size) framesByAnim.set(anim.id, frames);
    }

    const setupBefore = evaluateSymbol(sym, null, 0, "setup");
    const animBefore = new Map<string, Map<number, Pose>>();
    for (const [animId, frames] of framesByAnim) {
      const anim = sym.animations.find((a) => a.id === animId)!;
      const byFrame = new Map<number, Pose>();
      for (const f of frames) byFrame.set(f, evaluateSymbol(sym, anim, f, "animate"));
      animBefore.set(animId, byFrame);
    }

    for (const id of moving) {
      const n = sym.nodes[id]!;
      this.beforeParent.set(id, n.parentId);
      this.beforeBind.set(id, cloneTf(n.bind));
      n.parentId = this.parentId;
    }

    // Setup pose.
    const setupAfter = evaluateSymbol(sym, null, 0, "setup");
    for (const id of moving) {
      const world = setupBefore.byNode.get(id)?.world;
      if (!world) continue;
      const parentWorld = this.parentId
        ? setupAfter.byNode.get(this.parentId)?.world
        : undefined;
      sym.nodes[id]!.bind = reexpress(world, parentWorld, sym.nodes[id]!.bind);
    }

    // Keyframes, frame by frame. Collected first and written as new tracks:
    // the key objects are shared with tracks earlier undo steps keep. The new
    // parent cannot descend from a moving node, so its pose does not depend
    // on the keys being rewritten.
    this.beforeTracks = [];
    for (const [animId, byFrame] of animBefore) {
      const anim = sym.animations.find((a) => a.id === animId);
      if (!anim) continue;
      const rewritten = new Map<NodeId, Map<number, Transform>>();
      for (const [frame, poseBefore] of byFrame) {
        const poseAfter = evaluateSymbol(sym, anim, frame, "animate");
        for (const id of moving) {
          const key = anim.tracks[id]?.keys.find((k) => k.frame === frame);
          const world = poseBefore.byNode.get(id)?.world;
          if (!key || !world) continue;
          const parentWorld = this.parentId
            ? poseAfter.byNode.get(this.parentId)?.world
            : undefined;
          if (!rewritten.has(id)) rewritten.set(id, new Map());
          rewritten.get(id)!.set(frame, reexpress(world, parentWorld, key.transform));
        }
      }
      for (const [id, byFrame] of rewritten) {
        const track = anim.tracks[id]!;
        this.beforeTracks.push({ animId, nodeId: id, track });
        anim.tracks[id] = {
          ...track,
          keys: track.keys.map((k) => {
            const transform = byFrame.get(k.frame);
            return transform ? { ...k, transform } : k;
          }),
        };
      }
    }

    this.norm = normalizeLayerOrder(sym);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    // The order this command found: it never touches the array itself, so
    // re-normalising under the old parents is NOT the inverse.
    if (this.norm) denormalize(sym, this.norm);
    for (const [id, parent] of this.beforeParent) {
      const n = sym.nodes[id];
      if (n) n.parentId = parent;
    }
    for (const [id, bind] of this.beforeBind) {
      const n = sym.nodes[id];
      if (n) n.bind = cloneTf(bind);
    }
    for (const { animId, nodeId, track } of this.beforeTracks) {
      const anim = sym.animations.find((a) => a.id === animId);
      if (anim) anim.tracks[nodeId] = track;
    }
    invalidateBounds([this.symbolId]);
  }
}

/** `local = inverse(parentWorld) * world`, decomposed back to a Transform. */
export function reexpress(
  world: Matrix2D, parentWorld: Matrix2D | undefined, prev: Transform,
): Transform {
  if (!parentWorld) return fromMatrix(cloneTf(prev), world, prev);
  const inv = mat();
  if (!invert(inv, parentWorld)) return cloneTf(prev);
  return fromMatrix(cloneTf(prev), mul(mat(), inv, world), prev);
}

/** Would parenting `child` under `parent` close a loop? */
export function createsCycle(sym: SymbolItem, child: NodeId, parent: NodeId): boolean {
  let cur: NodeId | null = parent;
  const seen = new Set<NodeId>();
  while (cur) {
    if (cur === child) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = sym.nodes[cur]?.parentId ?? null;
  }
  return false;
}

/**
 * Move a node's transform point, keeping the artwork where it is.
 *
 * The compensation reaches the bind pose AND every keyframe of the node's
 * tracks. It has to: the artwork hangs off the origin at -pivot, so a pivot
 * that moved without each frame's origin moving with it would drag the
 * artwork across the whole animation — and compensating only the bind pose
 * (which is what this command used to do) fixes Setup mode while leaving
 * every animated object to slide, since the rendered pose comes from the
 * track.
 *
 * Each display has its own transform point (`displays` picks one per node,
 * 0 by default), so only the keys showing it are compensated — and the bind
 * pose and the blank keys only for display 0, which is what they stand for.
 *
 * `keepArtwork: false` sets the transform point outright, which is what
 * pasting properties from another instance means.
 */
export class SetPivot implements Command {
  readonly kind = "node.pivot";
  readonly touches: TouchSet;
  readonly label = "Move Transform Point";
  private before = new Map<NodeId, {
    pivot: { x: number; y: number }; bind: Transform; extras: DisplayRef[] | undefined;
  }>();
  /** The tracks this replaced, as they were before the first step. */
  private beforeTracks = new Map<string, { animId: string; nodeId: NodeId; track: Track }>();
  private after: Map<NodeId, { x: number; y: number }>;
  private readonly displays: Map<NodeId, number>;
  private readonly keepArtwork: boolean;

  constructor(
    private readonly symbolId: ItemId,
    pivots: Map<NodeId, { x: number; y: number }>,
    opts: { keepArtwork?: boolean; displays?: Map<NodeId, number> } = {},
  ) {
    this.after = new Map([...pivots].map(([k, v]) => [k, { ...v }]));
    this.displays = new Map(opts.displays ?? []);
    this.keepArtwork = opts.keepArtwork !== false;
    this.touches = { symbols: [symbolId], nodes: [...pivots.keys()], stage: true, timeline: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, pivot] of this.after) {
      const n = sym.nodes[id];
      if (!n) continue;
      if (!this.before.has(id)) {
        this.before.set(id, { pivot: n.pivot, bind: n.bind, extras: n.extraDisplays });
      }

      const wanted = this.displays.get(id) ?? 0;
      const d = wanted > 0 && n.extraDisplays?.[wanted - 1] ? wanted : 0;
      const current = d === 0 ? n.pivot : n.extraDisplays![d - 1]!.pivot;
      const dx = pivot.x - current.x;
      const dy = pivot.y - current.y;
      if (d === 0) n.pivot = { ...pivot };
      else {
        n.extraDisplays = n.extraDisplays!.map((e, i) =>
          (i === d - 1 ? { itemId: e.itemId, pivot: { ...pivot } } : e));
      }
      if (!this.keepArtwork || (dx === 0 && dy === 0)) continue;

      // New objects all the way down, keys included: the frame algebra
      // shares key objects between a track and the one an earlier undo step
      // keeps, and a converted symbol shares `bind` with the node its
      // command keeps.
      if (d === 0) n.bind = translateLocal(cloneTf(n.bind), n.bind, dx, dy);
      const shows = (k: Keyframe) => k.displayIndex === d || (d === 0 && k.displayIndex < 0);
      for (const anim of sym.animations) {
        const track = anim.tracks[id];
        if (!track || !track.keys.some(shows)) continue;
        const k = `${anim.id}/${id}`;
        if (!this.beforeTracks.has(k)) this.beforeTracks.set(k, { animId: anim.id, nodeId: id, track });
        anim.tracks[id] = {
          ...track,
          keys: track.keys.map((key) => (shows(key)
            ? { ...key, transform: translateLocal(cloneTf(key.transform), key.transform, dx, dy) }
            : key)),
        };
      }
    }
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, prev] of this.before) {
      const n = sym.nodes[id];
      if (!n) continue;
      n.pivot = prev.pivot;
      n.bind = prev.bind;
      if (prev.extras) n.extraDisplays = prev.extras;
      else delete n.extraDisplays;
    }
    for (const { animId, nodeId, track } of this.beforeTracks.values()) {
      const anim = sym.animations.find((a) => a.id === animId);
      if (anim) anim.tracks[nodeId] = track;
    }
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetPivot)) return false;
    if (next.symbolId !== this.symbolId || next.keepArtwork !== this.keepArtwork) return false;
    // Redo replays only the merged command, so one node's steps must all
    // have moved the same display.
    for (const id of next.after.keys()) {
      if (this.after.has(id) && (next.displays.get(id) ?? 0) !== (this.displays.get(id) ?? 0)) return false;
    }
    // Our `before` holds the state from the start of the drag; the follow-up
    // only adds what it touched for the first time.
    for (const [id, pivot] of next.after) this.after.set(id, { ...pivot });
    for (const [id, d] of next.displays) this.displays.set(id, d);
    for (const [id, prev] of next.before) if (!this.before.has(id)) this.before.set(id, prev);
    for (const [k, t] of next.beforeTracks) if (!this.beforeTracks.has(k)) this.beforeTracks.set(k, t);
    return true;
  }
}

export class RenameNode implements Command {
  readonly kind = "node.rename";
  readonly touches: TouchSet;
  readonly label = "Rename";
  private before = "";
  private beforeLayer = "";
  constructor(
    private readonly symbolId: ItemId,
    private readonly nodeId: NodeId,
    private readonly name: string,
  ) {
    this.touches = { symbols: [symbolId], nodes: [nodeId], timeline: true, selection: true };
  }
  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const n = sym.nodes[this.nodeId];
    if (!n) return;
    this.before = n.name;
    n.name = this.name;
    const layer = sym.layers.find((l) => l.nodeId === this.nodeId);
    if (layer) { this.beforeLayer = layer.name; layer.name = this.name; }
  }
  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const n = sym.nodes[this.nodeId];
    if (n) n.name = this.before;
    const layer = sym.layers.find((l) => l.nodeId === this.nodeId);
    if (layer) layer.name = this.beforeLayer;
  }
}


/**
 * Frame rate, stage size and background.
 *
 * Frame rate is the document's, not the animation's: DragonBones writes it
 * once at the root and every armature inherits it, so changing it here
 * retimes everything at once — which is what "the project runs at 30fps"
 * means.
 */
export interface DocumentSettingsPatch {
  name?: string;
  frameRate?: number;
  width?: number;
  height?: number;
  background?: string;
  motionBlur?: Partial<MotionBlurSettings>;
}

export class SetDocumentSettings implements Command {
  readonly kind = "doc.settings";
  readonly touches: TouchSet = { stage: true, timeline: true, library: true };
  readonly label = "Document Settings";
  private before: {
    name: string; frameRate: number; stage: Project["stage"]; motionBlur?: MotionBlurSettings;
  } | null = null;

  constructor(private patch: DocumentSettingsPatch) {}

  apply(p: Project): void {
    if (!this.before) {
      this.before = {
        name: p.name, frameRate: p.frameRate, stage: { ...p.stage },
        motionBlur: p.motionBlur ? { ...p.motionBlur } : undefined,
      };
    }
    // The project name is also the export file name, so an empty one is
    // refused rather than propagated into `_ske.json`.
    if (this.patch.name !== undefined && this.patch.name.trim()) p.name = this.patch.name.trim();
    if (this.patch.frameRate !== undefined) {
      p.frameRate = clampInt(this.patch.frameRate, 1, 120);
    }
    if (this.patch.width !== undefined) p.stage.width = clampInt(this.patch.width, 1, 16384);
    if (this.patch.height !== undefined) p.stage.height = clampInt(this.patch.height, 1, 16384);
    if (this.patch.background !== undefined) p.stage.background = this.patch.background;
    if (this.patch.motionBlur) {
      const next = { ...(p.motionBlur ?? DEFAULT_MOTION_BLUR), ...this.patch.motionBlur };
      p.motionBlur = {
        enabled: next.enabled === true,
        shutter: clampInt(next.shutter, 0, 360),
        maxLength: clampInt(next.maxLength, 1, 4096),
      };
    }
  }

  revert(p: Project): void {
    if (!this.before) return;
    p.name = this.before.name;
    p.frameRate = this.before.frameRate;
    p.stage = { ...this.before.stage };
    if (this.before.motionBlur) p.motionBlur = { ...this.before.motionBlur };
    else delete p.motionBlur;
  }

  /** The follow-up's values become the ones redo applies; `before` keeps the
   *  state from the start of the scrub. */
  mergeWith(next: Command): boolean {
    if (!(next instanceof SetDocumentSettings)) return false;
    const motionBlur = this.patch.motionBlur || next.patch.motionBlur
      ? { ...this.patch.motionBlur, ...next.patch.motionBlur }
      : undefined;
    this.patch = { ...this.patch, ...next.patch, ...(motionBlur ? { motionBlur } : {}) };
    return true;
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Number.isFinite(v) ? Math.round(v) : lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * The document's export settings, replaced whole. Settings equal to the
 * defaults are stored as absent, so a file nobody configured stays as it was.
 */
export class SetExportSettings implements Command {
  readonly kind = "doc.export";
  readonly touches: TouchSet = { library: false };
  readonly label = "Export Settings";
  private before: ExportSettings | undefined;
  private captured = false;

  constructor(private readonly next: ExportSettings) {}

  apply(p: Project): void {
    if (!this.captured) { this.before = p.exportSettings; this.captured = true; }
    if (isDefaultExport(this.next)) delete p.exportSettings;
    else p.exportSettings = { ...this.next };
  }

  revert(p: Project): void {
    if (this.before) p.exportSettings = this.before;
    else delete p.exportSettings;
  }
}

