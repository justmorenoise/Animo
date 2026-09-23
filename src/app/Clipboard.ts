import type { Store } from "./Store";
import type { Animation, Layer, Node, SymbolItem, Track } from "@/core/doc/types";
import { isDefaultColor } from "@/core/doc/types";
import { type LayerId, newNodeId, type NodeId } from "@/core/doc/ids";
import { createLayer } from "@/core/doc/defaults";
import { clampScale, cloneTf, type Transform } from "@/core/math/Transform";
import { AddNode, reexpress, RemoveNodes, SetLayerMasks, SetPivot } from "@/core/history/commands";
import { EditTracks } from "@/core/history/timelineCommands";
import { applyTransforms, displayAtFrame, fillEmptyNode, transformAtFrame } from "./TimelineOps";
import { wouldCreateCycle } from "@/core/history/symbolCommands";
import { type MaskState, withDescendants } from "@/core/doc/layerTree";
import { displaySize, evaluateSymbol } from "@/core/doc/pose";
import { displayAt, itemsOf, kindOfItem } from "@/core/doc/displays";
import type { Matrix2D } from "@/core/math/Matrix2D";

interface ClipEntry {
  node: Node;
  layer: Layer;
  /** animationId -> the node's track in that animation. */
  tracks: Record<string, Track>;
  /** Stage copies only: the world matrix it was copied at, so a paste that
   *  lands under a different parent keeps it where it was on screen. */
  world?: Matrix2D;
}

export interface ClipboardPayload {
  /** Which symbol it came from, only to label the paste. */
  sourceSymbol: string;
  entries: ClipEntry[];
  /** animationId -> its name, so a paste into ANOTHER symbol can still find
   *  the timeline the keys belong on. Ids are unique per symbol. */
  animationNames: Record<string, string>;
}

/**
 * Copy, paste and duplicate for stage objects.
 *
 * Everything is deep-cloned through JSON at copy time, so a later edit to the
 * original cannot reach back into the clipboard — and pasting twice really
 * does give two independent objects.
 */
/** Everything the Properties panel shows for an instance. */
interface PropertyClip {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  /** On-screen size in px, so "same size" still holds between instances of
   *  DIFFERENT library items, where the same scale would not. */
  width: number;
  height: number;
  skewX: number;
  skewY: number;
  pivot: { x: number; y: number };
  /** Which library item it came from, to decide scale-vs-size on paste. */
  itemId?: string;
}

export class Clipboard {
  private payload: ClipboardPayload | null = null;
  /** A second slot: copying layers must not lose what was copied on stage. */
  private layers: ClipboardPayload | null = null;
  private props: PropertyClip | null = null;

  get hasContent(): boolean { return (this.payload?.entries.length ?? 0) > 0; }
  get hasProperties(): boolean { return this.props !== null; }

  /** Copy everything the Properties panel shows: position, size, scale,
   *  rotation, skew and transform point. */
  copyProperties(store: Store): boolean {
    const node = store.selectedNodes[0];
    if (!node) return false;
    const t = transformAtFrame(store, node);
    const shown = displayAtFrame(store, node);
    const size = displaySize(store.project, node, shown.index);
    this.props = {
      x: t.x, y: t.y,
      scaleX: t.scaleX, scaleY: t.scaleY,
      width: size.w * t.scaleX,
      height: size.h * t.scaleY,
      skewX: t.skewX, skewY: t.skewY,
      pivot: { ...(shown.display?.pivot ?? node.pivot) },
      itemId: shown.display?.itemId,
    };
    return true;
  }

  /**
   * Apply the copied properties.
   *
   * `includePosition` exists because both readings of "paste properties" are
   * reasonable: matching two instances exactly (which stacks them), and
   * matching only how they look. The menu offers each, rather than picking
   * one and being wrong half the time.
   */
  pasteProperties(store: Store, includePosition = true): number {
    const clip = this.props;
    const nodes = store.selectedNodes;
    if (!clip || nodes.length === 0) return 0;

    store.transaction("Paste Properties", () => {
      const pivots = new Map<NodeId, { x: number; y: number }>();
      const displays = new Map<NodeId, number>();

      for (const n of nodes) {
        const shown = displayAtFrame(store, n);
        const pivot = shown.display?.pivot ?? n.pivot;
        if (pivot.x !== clip.pivot.x || pivot.y !== clip.pivot.y) {
          // The transform point moves outright rather than compensating the
          // origin: the intent is "hang this one off its anchor the way that
          // one does", not "keep this one where it is".
          pivots.set(n.id, { ...clip.pivot });
          displays.set(n.id, shown.index);
        }
      }

      if (pivots.size) {
        store.apply(new SetPivot(store.currentSymbolId, pivots, { keepArtwork: false, displays }));
      }

      const transforms = new Map<NodeId, Transform>();
      for (const n of nodes) {
        const t = transformAtFrame(store, n);

        // Instances of the SAME library item take the scale directly, which
        // is exact. For a different item, derive the scale that reproduces
        // the copied on-screen size instead — otherwise "same size" would
        // silently mean "same multiplier", and the two would not match.
        let { scaleX, scaleY } = clip;
        const shown = displayAtFrame(store, n);
        if (shown.display?.itemId !== clip.itemId) {
          const size = displaySize(store.project, n, shown.index);
          if (size.w > 0) scaleX = clip.width / size.w;
          if (size.h > 0) scaleY = clip.height / size.h;
        }

        transforms.set(n.id, {
          ...t,
          x: includePosition ? clip.x : t.x,
          y: includePosition ? clip.y : t.y,
          scaleX: clampScale(scaleX),
          scaleY: clampScale(scaleY),
          skewX: clip.skewX, skewY: clip.skewY,
        });
      }
      applyTransforms(store, transforms);
    });

    store.emit("doc");
    return nodes.length;
  }

  /**
   * Copy what the selection looks like at the playhead, as Flash copies the
   * objects on stage: one static pose, the colour and the artwork showing
   * there, no timeline. Taking every track — what this used to do — is Copy
   * Layers, and pasted the whole animation of the original.
   */
  copy(store: Store): number {
    const sym = store.currentSymbol;
    const ids = store.selection.nodes.filter((id) => sym.nodes[id]);
    if (ids.length === 0) return 0;

    const entries = snapshotEntries(store, ids);
    this.payload = { sourceSymbol: sym.id, entries, animationNames: {} };
    return entries.length;
  }

  /**
   * `RemoveNodes` takes the whole subtree, so the clipboard has to hold the
   * whole subtree too. Copying just the selection, as Copy does, meant cutting
   * a bone threw away the artwork bound to it with no way to paste it back.
   */
  cut(store: Store): number {
    const sym = store.currentSymbol;
    const ids = withDescendants(sym, store.selection.nodes.filter((id) => sym.nodes[id]));
    if (ids.length === 0) return 0;
    const entries = snapshotEntries(store, ids);
    this.payload = { sourceSymbol: sym.id, entries, animationNames: {} };
    store.apply(new RemoveNodes(store.currentSymbolId, [...store.selection.nodes]));
    store.clearSelection();
    store.emit("doc");
    return entries.length;
  }

  paste(store: Store, offset = { x: 10, y: 10 }): number {
    if (!this.payload) return 0;
    return this.pasteSnapshot(store, this.payload, "Paste", offset);
  }

  duplicate(store: Store, offset = { x: 10, y: 10 }): number {
    const saved = this.payload;
    const n = this.copy(store);
    if (n === 0) { this.payload = saved; return 0; }
    const fresh = this.payload!;
    this.payload = saved;                        // duplicating must not clobber the clipboard
    return this.pasteSnapshot(store, fresh, "Duplicate", offset);
  }

  /**
   * Put copied objects back on stage.
   *
   * A layer holds one object here, so where Flash adds the object to the
   * current layer this adds a layer directly ABOVE the selected one — next
   * to the original, in its group. A single selected EMPTY layer is the
   * exception: it receives the first object in place, as a library drop
   * does, and anything further lands above it.
   *
   * Roots keep their parent when it exists here, so the copy moves with the
   * same group or bone as the original. Under a parent that is gone (a
   * paste into another symbol) or a different one (the empty layer's own),
   * the pose is re-expressed from the world matrix it was copied at.
   */
  private pasteSnapshot(
    store: Store, payload: ClipboardPayload, label: string, offset: { x: number; y: number },
  ): number {
    const sym = store.currentSymbol;
    const legal = payload.entries.filter((e) =>
      itemsOf(e.node).every((id) => !wouldCreateCycle(store.project, store.currentSymbolId, id)));
    if (legal.length === 0) return 0;

    const inSet = new Set(legal.map((e) => e.node.id));
    const selected = store.selection.nodes.filter((id) => sym.nodes[id]);
    const only = selected.length === 1 ? sym.nodes[selected[0]!] : undefined;
    let target = only?.kind === "empty" ? only : undefined;
    const indices = selected
      .map((id) => sym.layers.findIndex((l) => l.nodeId === id))
      .filter((i) => i >= 0);
    let at = indices.length ? Math.min(...indices) : 0;

    const taken = new Set(Object.values(sym.nodes).map((n) => n.name));
    const idMap = new Map<NodeId, NodeId>();
    for (const e of legal) idMap.set(e.node.id, newNodeId());
    const created: NodeId[] = [];
    // Nothing the paste does moves an existing node, so one pose serves.
    const anim = store.ui.mode === "setup" ? null : store.currentAnimation;
    const here = evaluateSymbol(sym, anim, store.ui.frame, store.ui.mode);
    const worldOfParent = (id: NodeId | null) => (id ? here.byNode.get(id)?.world : undefined);

    store.transaction(label, () => {
      for (const entry of legal) {
        const source = entry.node;
        const parentInSet = !!source.parentId && inSet.has(source.parentId);
        const shift = parentInSet ? { x: 0, y: 0 } : offset;

        // Only the roots of the pasted set move: a child's transform is local
        // to a parent that has already moved, and offsetting it too put it
        // twice the distance away.
        const place = (parentId: NodeId | null): Transform => {
          const same = parentInSet || parentId === source.parentId;
          const t = same || !entry.world
            ? cloneTf(source.bind)
            : reexpress(entry.world, worldOfParent(parentId), source.bind);
          return { ...t, x: t.x + shift.x, y: t.y + shift.y };
        };

        if (target && !parentInSet && source.itemId) {
          const into = target;
          target = undefined;
          idMap.set(source.id, into.id);
          at = sym.layers.findIndex((l) => l.nodeId === into.id);
          fillEmptyNode(store, into.id, {
            itemId: source.itemId,
            kind: source.kind,
            pivot: source.pivot,
            transform: place(into.parentId),
            color: source.color,
            blendMode: source.blendMode,
            motionBlur: source.motionBlur,
          });
          created.push(into.id);
          continue;
        }

        const id = idMap.get(source.id)!;
        const parentId = parentInSet
          ? idMap.get(source.parentId!)!
          : source.parentId && sym.nodes[source.parentId] ? source.parentId : null;
        const name = uniqueName(source.name, taken);
        taken.add(name);
        const node: Node = { ...clone(source), id, name, parentId, bind: place(parentId) };
        const layer = createLayer(id, name, sym.layers.length);
        layer.color = entry.layer.color;
        layer.visible = entry.layer.visible;
        store.apply(new AddNode(label, store.currentSymbolId, node, layer, at));
        at = sym.layers.findIndex((l) => l.nodeId === id) + 1;
        created.push(id);
      }
    });

    store.selectNodes(created);
    store.emit("doc");
    return created.length;
  }

  /* ── Layers ─────────────────────────────────────────────────────────────
     The same entries, read as ROWS rather than as objects: nothing moves, the
     layer's own flags come along, and the destination is a place in the stack
     rather than the top of it.                                            */

  get hasLayers(): boolean { return this.layers !== null; }

  /** Forget both slots: ids restart with every document, so what was copied
   *  from the last one would point at whatever now has the same id. */
  reset(): void {
    this.payload = null;
    this.layers = null;
  }

  /** Copy whole layers, groups included: a group without its children would
   *  paste as an empty container. */
  copyLayers(store: Store): number {
    const sym = store.currentSymbol;
    const ids = withDescendants(sym, store.selection.nodes.filter((id) => sym.nodes[id]));
    if (ids.length === 0) return 0;

    // Stack order, not click order — pasting must not shuffle the rows.
    ids.sort((a, b) =>
      sym.layers.findIndex((l) => l.nodeId === a) - sym.layers.findIndex((l) => l.nodeId === b));

    this.layers = {
      sourceSymbol: sym.id,
      entries: entriesFor(sym, ids),
      animationNames: animationNames(sym),
    };
    return ids.length;
  }

  /**
   * Paste layers at the selected row.
   *
   * A single EMPTY layer as the destination is consumed: that is what makes
   * "create an empty layer, paste three layers into it" produce three layers
   * where the empty one was, with everything below sliding down. Any other
   * selection pastes above the topmost selected row.
   */
  pasteLayers(store: Store): number {
    const clip = this.layers;
    if (!clip) return 0;
    const sym = store.currentSymbol;

    const selected = store.selection.nodes.filter((id) => sym.nodes[id]);
    const indices = selected
      .map((id) => sym.layers.findIndex((l) => l.nodeId === id))
      .filter((i) => i >= 0);
    const at = indices.length ? Math.min(...indices) : 0;

    const target = selected.length === 1 ? sym.nodes[selected[0]!] : undefined;
    const consume = target?.kind === "empty" ? target.id : null;

    return this.insert(store, clip, "Paste Layers", {
      offset: { x: 0, y: 0 }, at, carryLayer: true, consume,
    });
  }

  /** A copy of the selected layers, directly above the originals. */
  duplicateLayers(store: Store): number {
    const sym = store.currentSymbol;
    const saved = this.layers;
    const n = this.copyLayers(store);
    if (n === 0) { this.layers = saved; return 0; }
    const fresh = this.layers!;
    this.layers = saved;                         // as with objects: never clobber the clipboard

    const indices = fresh.entries
      .map((e) => sym.layers.findIndex((l) => l.nodeId === e.node.id))
      .filter((i) => i >= 0);
    const at = indices.length ? Math.min(...indices) : 0;

    return this.insert(store, fresh, "Duplicate Layer", {
      offset: { x: 0, y: 0 }, at, carryLayer: true,
    });
  }

  private insert(
    store: Store, payload: ClipboardPayload, label: string,
    opts: {
      offset: { x: number; y: number };
      /** Index in `sym.layers` to insert at; the entries keep their order. */
      at?: number;
      /** Carry the layer's own flags, for a paste that means "this row". */
      carryLayer?: boolean;
      /** An empty layer to replace, so the pasted rows take its place. */
      consume?: NodeId | null;
    },
  ): number {
    const { offset } = opts;
    const sym = store.currentSymbol;
    const taken = new Set(Object.values(sym.nodes).map((n) => n.name));

    // Refuse anything that would place a symbol inside itself. Paste is a
    // separate entry point from the library drag, and the guard has to be on
    // every one of them.
    const legal = payload.entries.filter((e) =>
      itemsOf(e.node).every((id) => !wouldCreateCycle(store.project, store.currentSymbolId, id)));
    if (legal.length === 0) return 0;

    // Fresh ids for what is actually pasted, so a parent link inside the set
    // follows the copy and none points at a node that was refused.
    const idMap = new Map<NodeId, NodeId>();
    for (const e of legal) idMap.set(e.node.id, newNodeId());

    const created: NodeId[] = [];
    const layerMap = new Map<LayerId, LayerId>();

    store.transaction(label, () => {
      // Replacing the empty layer FIRST keeps the arithmetic honest: `at`
      // then names the row the pasted layers should occupy.
      let at = opts.at ?? 0;
      if (opts.consume) {
        const i = sym.layers.findIndex((l) => l.nodeId === opts.consume);
        if (i >= 0) at = i;
        store.apply(new RemoveNodes(store.currentSymbolId, [opts.consume]));
      }

      legal.forEach((entry, i) => {
        const id = idMap.get(entry.node.id)!;
        const name = uniqueName(entry.node.name, taken);
        taken.add(name);

        const parentId = pastedParent(entry.node.parentId, idMap, (id) => !!sym.nodes[id]);
        const node: Node = {
          ...clone(entry.node),
          id,
          name,
          parentId,
          bind: cloneTf(entry.node.bind),
        };
        // Only the roots of the pasted set move: a child's transform is local
        // to a parent that has already moved, and offsetting it too put it
        // twice the distance away.
        const shift = entry.node.parentId && idMap.has(entry.node.parentId) ? { x: 0, y: 0 } : offset;
        node.bind.x += shift.x;
        node.bind.y += shift.y;

        const layer = createLayer(id, name, sym.layers.length + i);
        layer.color = entry.layer.color;
        layer.visible = entry.layer.visible;
        layer.locked = false;
        if (opts.carryLayer) {
          layer.outline = entry.layer.outline;
          if (entry.layer.excludeFromExport) layer.excludeFromExport = true;
        }
        layerMap.set(entry.layer.id, layer.id);

        store.apply(new AddNode(label, store.currentSymbolId, node, layer, at + i));
        created.push(id);

        // Bring the animation across too, offset to match.
        for (const [animId, track] of Object.entries(entry.tracks)) {
          const anim = destinationAnimation(sym, animId, payload, store, entry);
          if (!anim) continue;
          const copied: Track = {
            nodeId: id,
            endFrame: track.endFrame,
            keys: track.keys.map((k) => ({
              ...clone(k),
              transform: { ...k.transform, x: k.transform.x + shift.x, y: k.transform.y + shift.y },
            })),
          };
          store.apply(new EditTracks(
            label, store.currentSymbolId, anim.id, new Map([[id, copied]]),
          ));
        }
      });

      if (opts.carryLayer) {
        const links = remapMasks(sym, layerMap, payload.entries);
        if (links.size) store.apply(new SetLayerMasks(store.currentSymbolId, links));
      }
    });

    store.selectNodes(created);
    store.emit("doc");
    return created.length;
  }
}

/**
 * The parent a pasted layer gets: the copy of its parent when that came
 * along, else the original parent when it exists here, else none. Keeping the
 * original is what leaves a duplicated layer in its group at the same place;
 * dropping it put the copy at the top level, offset by the group's transform
 * and moved to the bottom of the stack.
 */
export function pastedParent(
  parentId: NodeId | null, copies: ReadonlyMap<NodeId, NodeId>, existsHere: (id: NodeId) => boolean,
): NodeId | null {
  if (!parentId) return null;
  return copies.get(parentId) ?? (existsHere(parentId) ? parentId : null);
}

/** Animation ids are per symbol, so a cross-symbol paste matches by NAME. */
function animationNames(sym: SymbolItem): Record<string, string> {
  const out: Record<string, string> = {};
  for (const anim of sym.animations) out[anim.id] = anim.name;
  return out;
}

/**
 * Where a copied track lands.
 *
 * Within one symbol the id matches and there is nothing to decide. Pasting
 * into ANOTHER symbol used to drop every keyframe on the floor — the row
 * arrived with its artwork and none of its animation, which reads as "copy
 * lost the frames" and gives no clue why. So: same id, else the animation
 * with the same NAME, else — for a row that carries a single timeline — the
 * one being edited, which is the only timeline the paste can be about.
 */
function destinationAnimation(
  sym: SymbolItem, animId: string, payload: ClipboardPayload,
  store: Store, entry: ClipEntry,
): Animation | undefined {
  const byId = sym.animations.find((a) => a.id === animId);
  if (byId) return byId;
  const name = payload.animationNames?.[animId];
  const byName = name ? sym.animations.find((a) => a.name === name) : undefined;
  if (byName) return byName;
  return Object.keys(entry.tracks).length === 1
    ? store.currentAnimation ?? undefined
    : undefined;
}


/**
 * Each node as it looks at the playhead: its pose there as the bind pose,
 * the colour it shows there, and the display showing as its only display.
 * Deep-cloned, so a later edit cannot reach back.
 */
function snapshotEntries(store: Store, ids: NodeId[]): ClipEntry[] {
  const sym = store.currentSymbol;
  // Stack order, not click order, so the pasted layers keep theirs.
  const row = (id: NodeId) => sym.layers.findIndex((l) => l.nodeId === id);
  ids = [...ids].sort((a, b) => row(a) - row(b));
  const anim = store.ui.mode === "setup" ? null : store.currentAnimation;
  const pose = evaluateSymbol(sym, anim, store.ui.frame, store.ui.mode);
  const entries: ClipEntry[] = [];
  for (const id of ids) {
    const source = sym.nodes[id];
    const layer = sym.layers.find((l) => l.nodeId === id);
    const e = pose.byNode.get(id);
    if (!source || !layer || !e) continue;
    const node = clone(source);
    node.bind = cloneTf(e.local);
    const shown = e.display ?? displayAt(source, 0);
    if (shown) {
      node.itemId = shown.itemId;
      node.kind = kindOfItem(store.project, shown.itemId);
      node.pivot = { ...shown.pivot };
    }
    delete node.extraDisplays;
    if (isDefaultColor(e.color)) delete node.color;
    else node.color = { ...e.color };
    entries.push({ node, layer: clone(layer), tracks: {}, world: clone(e.world) });
  }
  return entries;
}

/** Node + layer + every track, deep-cloned so a later edit cannot reach back. */
function entriesFor(sym: SymbolItem, ids: NodeId[]): ClipEntry[] {
  const entries: ClipEntry[] = [];
  for (const id of ids) {
    const node = sym.nodes[id];
    const layer = sym.layers.find((l) => l.nodeId === id);
    if (!node || !layer) continue;
    const tracks: Record<string, Track> = {};
    for (const anim of sym.animations) {
      const track = anim.tracks[id];
      if (track) tracks[anim.id] = clone(track);
    }
    entries.push({ node: clone(node), layer: clone(layer), tracks });
  }
  return entries;
}

/**
 * The mask links of the pasted rows, re-pointed at the copies.
 *
 * Read off the ENTRIES and applied as one `SetLayerMasks` after the last row:
 * `AddNode` runs `normalizeMasks` after every single row, which sees a mask
 * copy nobody links to yet (demoted) and a target still pointing at the
 * ORIGINAL mask, by then below it (unlinked). Setting the links once the whole
 * set exists — through a command, so undo and redo carry them — is what makes
 * "copy a mask and what it clips" paste as a working pair.
 */
function remapMasks(
  sym: SymbolItem, layerMap: Map<LayerId, LayerId>, entries: ClipEntry[],
): Map<LayerId, MaskState> {
  const out = new Map<LayerId, MaskState>();
  for (const entry of entries) {
    const id = layerMap.get(entry.layer.id);
    if (!id || !sym.layers.some((l) => l.id === id)) continue;
    const mapped = entry.layer.maskedBy ? layerMap.get(entry.layer.maskedBy) : undefined;
    // A mask that came along is re-pointed at its copy. One that did not is
    // still worth keeping IF it is here and above the pasted row — pasting
    // under an existing mask should stay clipped by it, which is what makes a
    // pasted row look like the row that was copied. `normalizeMasks` inside
    // the command has the final say on both, and drops whatever cannot hold.
    const kept = !mapped && entry.layer.maskedBy
      && sym.layers.some((l) => l.id === entry.layer.maskedBy)
      ? entry.layer.maskedBy : undefined;
    const maskedBy = mapped ?? kept;
    if (entry.layer.isMask || maskedBy) {
      out.set(id, { ...(entry.layer.isMask ? { isMask: true } : {}), ...(maskedBy ? { maskedBy } : {}) });
    }
  }
  return out;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function uniqueName(base: string, taken: Set<string>): string {
  const stem = base.replace(/_copy\d*$/, "").replace(/_\d+$/, "");
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${stem}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
