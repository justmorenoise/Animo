import type { Store } from "./Store";
import type { DisplayRef, Keyframe, Node, Project, Track } from "@/core/doc/types";
import { type ItemId, newNodeId, type NodeId } from "@/core/doc/ids";
import { createLayer } from "@/core/doc/defaults";
import { cloneTf } from "@/core/math/Transform";
import { TWEEN_NONE } from "@/core/math/easing";
import { EditTracks } from "@/core/history/timelineCommands";
import {
    AddNode,
    SetBindColor,
    SetNodeBlendMode,
    SetNodeDisplays,
    SetNodeItem,
    SetPivot
} from "@/core/history/commands";
import { ensureTrack } from "./TimelineOps";
import { emptyRange, insertKeyframe, keyIndexAt, pasteRun, removeFrame, spanIndexAt } from "@/core/doc/timeline";
import { layerRows } from "@/core/doc/layerTree";
import { displaysOf, findOrAddDisplay, itemsOf, kindOfItem } from "@/core/doc/displays";
import { wouldCreateCycle } from "@/core/history/symbolCommands";

/** A rectangle of frames: rows top to bottom, `from..to` on each. */
export interface FrameSelection {
  nodeIds: NodeId[];
  from: number;
  to: number;
}

interface FrameRow {
  /** The source node, cloned: its displays, colour, blend mode and bone
   *  fields are what a new layer is built from and an empty one filled with. */
  node: Node;
  layerColor: string;
  /** Rebased so the run starts at 0, which always has a key. */
  keys: Keyframe[];
}

interface FrameClip {
  rows: FrameRow[];
  /** How many frames the copied run covers. */
  span: number;
}

export type PasteMode = "insert" | "overwrite";

/**
 * Would laying down rows copied from these nodes put a symbol inside itself?
 * A row brings its node's whole display list along — onto an empty layer, a
 * new one, or appended to the destination's — so every display counts.
 */
export function rowsNestHost(project: Project, hostId: ItemId, nodes: readonly Node[]): boolean {
  return nodes.some((n) => itemsOf(n).some((id) => wouldCreateCycle(project, hostId, id)));
}

/**
 * Copy, cut and paste runs of frames, over one layer or several.
 *
 * A frame carries its content, as in Flash: what the layer shows there comes
 * along, so pasting onto an empty layer fills it and pasting onto one that
 * shows something else adds the copied artwork to its display list. Several
 * rows paste into the target layer and the ones below it, and layers are
 * created when the stack runs out.
 */
export class FrameClipboard {
  private clip: FrameClip | null = null;

  get hasContent(): boolean { return (this.clip?.rows.length ?? 0) > 0; }
  get span(): number { return this.clip?.span ?? 0; }

  /** Forget the clip when the document is replaced (see `Clipboard.reset`). */
  reset(): void { this.clip = null; }

  /** The rectangle currently selected, rows in stack order. */
  static selectionOf(store: Store): FrameSelection | null {
    const frames = store.selection.frames;
    if (frames.length === 0) return null;
    const ids = new Set<NodeId>();
    let from = Infinity, to = -Infinity;
    for (const cell of frames) {
      const cut = cell.lastIndexOf(":");
      const frame = Number(cell.slice(cut + 1));
      if (!Number.isFinite(frame)) continue;
      ids.add(cell.slice(0, cut) as NodeId);
      from = Math.min(from, frame);
      to = Math.max(to, frame);
    }
    if (ids.size === 0) return null;
    const order = layerRows(store.currentSymbol, true).map((r) => r.layer.nodeId);
    const nodeIds = [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return { nodeIds, from, to };
  }

  copy(store: Store, sel = FrameClipboard.selectionOf(store)): number {
    this.clip = sel ? buildClip(store, sel) : null;
    return this.clip?.span ?? 0;
  }

  cut(store: Store): number {
    const sel = FrameClipboard.selectionOf(store);
    const n = this.copy(store, sel);
    if (!n || !sel) return 0;
    clearRange(store, sel, "Cut Frames");
    return n;
  }

  /**
   * Drop the clip with its first row on `nodeId` at `atFrame` — by default
   * the top-left cell of the frame selection. "insert" (Paste Frames) moves
   * what was there to the right, and with several frames selected replaces
   * them, as Flash does; "overwrite" (Paste and Overwrite Frames) replaces
   * what lies under the pasted run.
   */
  paste(store: Store, nodeId?: NodeId, atFrame?: number, mode: PasteMode = "insert"): number {
    const clip = this.clip;
    if (!clip) return 0;
    const sym = store.currentSymbol;

    const sel = FrameClipboard.selectionOf(store);
    const target = nodeId ?? sel?.nodeIds[0] ?? store.selection.nodes[0];
    let at = atFrame ?? sel?.from ?? store.ui.frame;
    if (!target || !sym.nodes[target]) return 0;

    const replacing = mode === "insert" && !!sel && sel.to > sel.from
      && sel.nodeIds.includes(target) && at >= sel.from && at <= sel.to;
    if (replacing) at = sel!.from;

    return this.drop(store, clip, target, at, mode,
      mode === "insert" ? "Paste Frames" : "Paste and Overwrite Frames",
      replacing ? sel : null);
  }

  /**
   * Flash's frame drag: the selected rectangle moves to `target`/`at`,
   * overwriting what lies there, or is COPIED when `copy` is set (⌥). The
   * frames it leaves behind are emptied, and the whole thing is one undo step.
   * The ⌘C clipboard is untouched — a drag is not a copy.
   */
  dragTo(store: Store, sel: FrameSelection, target: NodeId, at: number, copy = false): number {
    const anim = store.currentAnimation;
    const clip = buildClip(store, sel);
    if (!clip || !anim || !store.currentSymbol.nodes[target]) return 0;
    const label = copy ? "Copy Frames" : "Move Frames";
    return store.transaction(label, () => {
      if (!copy) {
        const cleared = cutRange(store, sel);
        if (cleared.size) {
          store.apply(new EditTracks(label, store.currentSymbolId, anim.id, cleared));
        }
      }
      return this.drop(store, clip, target, Math.max(0, at), "overwrite", label, null);
    });
  }

  /** Lay `clip` down with its first row on `target` at `at`. */
  private drop(
    store: Store, clip: FrameClip, target: NodeId, at: number,
    mode: PasteMode, label: string, replace: FrameSelection | null,
  ): number {
    const anim = store.currentAnimation;
    const sym = store.currentSymbol;
    if (!anim) return 0;
    // The same guard as every other way into a symbol: frames copied at the
    // top level and pasted inside the symbol they show would nest it in itself.
    if (rowsNestHost(store.project, store.currentSymbolId, clip.rows.map((r) => r.node))) return 0;

    let rows = layerRows(sym).map((r) => r.node);
    if (!rows.some((n) => n.id === target)) rows = layerRows(sym, true).map((r) => r.node);
    const first = rows.findIndex((n) => n.id === target);

    const taken = new Set(Object.values(sym.nodes).map((n) => n.name));
    const pastedIds: NodeId[] = [];

    store.transaction(label, () => {
      const tracks = new Map<NodeId, Track>();
      let below = sym.layers.findIndex((l) => l.nodeId === target);

      clip.rows.forEach((row, i) => {
        const dest = rows[first + i];
        if (!dest) {
          const id = this.addRow(store, row, at, clip.span, taken, below + 1, tracks, label);
          below = sym.layers.findIndex((l) => l.nodeId === id);
          pastedIds.push(id);
          return;
        }
        const filled = dest.kind === "empty" && displaysOf(row.node).length > 0;
        const existing = anim.tracks[dest.id];
        // An empty layer nobody keyed has no frames to move, like a new
        // layer in Flash: the run is all it gets. One that was keyed keeps
        // its frames, blank, since they showed nothing.
        let base: Track = filled && !existing
          ? { nodeId: dest.id, keys: [], endFrame: -1 }
          : existing ?? ensureTrack(store, dest);
        if (filled) base = { ...base, keys: base.keys.map((k) => ({ ...k, displayIndex: -1 })) };
        if (replace && replace.nodeIds.includes(dest.id)) {
          for (let f = replace.from; f <= replace.to; f++) base = removeFrame(base, replace.from) ?? base;
        }
        const keys = this.mapDisplays(store, row, sym.nodes[dest.id]!, filled);
        tracks.set(dest.id, pasteRun(base, keys, clip.span, at, mode, sym.nodes[dest.id]!));
        below = sym.layers.findIndex((l) => l.nodeId === dest.id);
        pastedIds.push(dest.id);
      });

      store.apply(new EditTracks(label, store.currentSymbolId, anim.id, tracks));
    });

    const end = at + clip.span - 1;
    store.selectNodes(pastedIds);
    store.selection = {
      ...store.selection,
      frames: pastedIds.flatMap((id) => range(at, end).map((f) => `${id}:${f}`)),
    };
    store.emit("timeline");
    store.emit("stage");
    store.emit("selection");
    return clip.span;
  }

  /**
   * The row's keys with their `displayIndex` pointing into `dest`'s display
   * list, extending it with whatever artwork the row shows that `dest` does
   * not have. An empty `dest` (`fill`) takes the first of them as its own.
   */
  private mapDisplays(store: Store, row: FrameRow, dest: Node, fill: boolean): Keyframe[] {
    const keys = row.keys.map((k) => clone(k));
    const source = displaysOf(row.node);
    // An empty source row shows nothing, wherever its frames go.
    if (row.node.kind === "empty") return keys.map((k) => ({ ...k, displayIndex: -1 }));
    if (source.length === 0 || (!fill && displaysOf(dest).length === 0)) return keys;

    const sym = store.currentSymbolId;
    let displays: DisplayRef[] = fill ? [] : displaysOf(dest);
    const before = Math.max(1, displays.length);
    const out = keys.map((k) => {
      if (k.displayIndex < 0) return k;
      const ref = source[k.displayIndex];
      if (!ref) return { ...k, displayIndex: -1 };
      const found = findOrAddDisplay(displays, ref);
      displays = found.displays;
      return { ...k, displayIndex: found.index };
    });

    if (fill && displays.length) {
      const own = displays[0]!;
      store.apply(new SetNodeItem(sym, new Map([[dest.id, { itemId: own.itemId, kind: kindOfItem(store.project, own.itemId) }]])));
      store.apply(new SetPivot(sym, new Map([[dest.id, own.pivot]]), { keepArtwork: false }));
      if (row.node.color) store.apply(new SetBindColor(sym, new Map([[dest.id, row.node.color]])));
      if (row.node.blendMode && row.node.blendMode !== "normal") {
        store.apply(new SetNodeBlendMode(sym, [dest.id], row.node.blendMode));
      }
    }
    if (displays.length > before) {
      store.apply(new SetNodeDisplays(sym, new Map([[dest.id, displays.slice(1)]])));
    }
    return out;
  }

  /** A new layer for a row the stack has no room for, at `index`. */
  private addRow(
    store: Store, row: FrameRow, at: number, span: number,
    taken: Set<string>, index: number, tracks: Map<NodeId, Track>, label: string,
  ): NodeId {
    const sym = store.currentSymbol;
    const id = newNodeId();
    const name = uniqueName(row.node.name, taken);
    taken.add(name);
    const shown = row.keys.find((k) => k.displayIndex >= 0) ?? row.keys[0]!;
    const parentId = row.node.parentId && sym.nodes[row.node.parentId] ? row.node.parentId : null;
    const node: Node = { ...clone(row.node), id, name, parentId, bind: cloneTf(shown.transform) };
    const layer = createLayer(id, name, sym.layers.length);
    layer.color = row.layerColor;
    store.apply(new AddNode(label, store.currentSymbolId, node, layer, index));
    // Before `at` there is no key, so the layer is not on stage there.
    tracks.set(id, {
      nodeId: id,
      keys: row.keys.map((k) => clone({ ...k, frame: k.frame + at })),
      endFrame: at + span - 1,
    });
    return id;
  }
}

/** The rectangle's rows, each with the node it came from and its keys. */
function buildClip(store: Store, sel: FrameSelection): FrameClip | null {
  const sym = store.currentSymbol;
  const rows: FrameRow[] = [];
  for (const id of sel.nodeIds) {
    const node = sym.nodes[id];
    const layer = sym.layers.find((l) => l.nodeId === id);
    if (!node || !layer) continue;
    rows.push({ node: clone(node), layerColor: layer.color, keys: rowKeys(store, node, sel) });
  }
  return rows.length ? { rows, span: sel.to - sel.from + 1 } : null;
}

/**
 * The source rows with a dragged range taken out (`emptyRange`). A layer that
 * was never keyed still shows its artwork on every frame, so it is given its
 * track first — skipping it turned a move into a copy. A group or an empty
 * layer nobody keyed has no frames of its own to move.
 */
function cutRange(store: Store, sel: FrameSelection): Map<NodeId, Track> {
  const anim = store.currentAnimation;
  const out = new Map<NodeId, Track>();
  if (!anim) return out;
  for (const id of sel.nodeIds) {
    const node = store.currentSymbol.nodes[id];
    if (!node) continue;
    const track = anim.tracks[id] ?? (node.itemId ? ensureTrack(store, node) : undefined);
    const emptied = track ? emptyRange(track, sel.from, sel.to, node) : null;
    if (emptied) out.set(id, emptied);
  }
  return out;
}

/**
 * One row's keys over `sel`, rebased to 0. A range starting mid-span bakes
 * what is showing there — the key F6 would cut: the sampled colour, and only
 * the turns still to come. A row showing nothing at `from` starts with a
 * blank key, and one whose track ends inside the range gets a blank key
 * where it ended, so the paste shows exactly what the copy did.
 */
function rowKeys(store: Store, node: Node, sel: FrameSelection): Keyframe[] {
  const track = store.currentAnimation?.tracks[node.id];
  // A layer with no track still has a pose: its bind transform, all along.
  if (!track) {
    return [{ frame: 0, transform: cloneTf(node.bind), displayIndex: 0, tween: TWEEN_NONE }];
  }
  const blank = (frame: number): Keyframe =>
    ({ frame, transform: cloneTf(node.bind), displayIndex: -1, tween: TWEEN_NONE });

  const midSpan = sel.from <= track.endFrame && keyIndexAt(track, sel.from) < 0
    && spanIndexAt(track, sel.from) >= 0;
  const baked = midSpan ? insertKeyframe(track, sel.from, node) ?? track : track;
  const keys = baked.keys
    .filter((k) => k.frame >= sel.from && k.frame <= sel.to && k.frame <= track.endFrame)
    .map((k) => clone({ ...k, frame: k.frame - sel.from }));
  if (!keys.some((k) => k.frame === 0)) keys.unshift(blank(0));
  if (track.endFrame >= sel.from && track.endFrame < sel.to) keys.push(blank(track.endFrame + 1 - sel.from));
  return keys;
}

/** Remove every keyframe in a range on each row, keeping the frame-0 anchor. */
function clearRange(store: Store, sel: FrameSelection, label: string): void {
  const anim = store.currentAnimation;
  if (!anim) return;
  const tracks = new Map<NodeId, Track>();
  for (const id of sel.nodeIds) {
    const track = anim.tracks[id];
    if (!track) continue;
    const keys = track.keys.filter((k) => k.frame === 0 || k.frame < sel.from || k.frame > sel.to);
    if (keys.length !== track.keys.length) tracks.set(id, { ...track, keys });
  }
  if (!tracks.size) return;
  store.apply(new EditTracks(label, store.currentSymbolId, anim.id, tracks));
  store.emit("timeline");
  store.emit("stage");
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  const stem = base.replace(/_\d+$/, "");
  for (let i = 2; ; i++) {
    const candidate = `${stem}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}
