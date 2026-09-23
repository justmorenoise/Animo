import type { Layer, Node, SymbolItem } from "./types";
import type { LayerId, NodeId } from "./ids";

export interface LayerRow {
  layer: Layer;
  node: Node;
  depth: number;
  hasChildren: boolean;
  /** Hidden because an ancestor group is collapsed. */
  hiddenByCollapse: boolean;
}

/**
 * The layer list as a tree: a group is immediately followed by its children,
 * indented under it.
 *
 * Display order and z-order are the SAME list — walking it depth first is
 * what makes "the top row draws in front" hold for nested layers too, exactly
 * as folders behave in Flash. `normalizeLayerOrder` keeps the stored array in
 * this shape so nothing has to reconcile two orders later.
 */
export function layerRows(sym: SymbolItem, includeHidden = false): LayerRow[] {
  const childrenOf = new Map<NodeId | null, Layer[]>();
  const known = new Set(sym.layers.map((l) => l.nodeId));

  for (const layer of sym.layers) {
    const node = sym.nodes[layer.nodeId];
    if (!node) continue;
    // A parent outside this symbol (or missing) makes the layer a root here.
    const parent = node.parentId && known.has(node.parentId) ? node.parentId : null;
    const list = childrenOf.get(parent);
    if (list) list.push(layer);
    else childrenOf.set(parent, [layer]);
  }

  const rows: LayerRow[] = [];
  const seen = new Set<NodeId>();

  const walk = (layer: Layer, depth: number, collapsedAbove: boolean): void => {
    if (seen.has(layer.nodeId)) return;      // a broken parent loop must not hang the UI
    seen.add(layer.nodeId);
    const node = sym.nodes[layer.nodeId];
    if (!node) return;
    const children = childrenOf.get(layer.nodeId) ?? [];

    rows.push({
      layer, node, depth,
      hasChildren: children.length > 0,
      hiddenByCollapse: collapsedAbove,
    });

    const hideBelow = collapsedAbove || layer.collapsed === true;
    for (const child of children) walk(child, depth + 1, hideBelow);
  };

  for (const layer of childrenOf.get(null) ?? []) walk(layer, 0, false);
  // Anything orphaned by a loop still needs a row.
  for (const layer of sym.layers) if (!seen.has(layer.nodeId)) walk(layer, 0, false);

  return includeHidden ? rows : rows.filter((r) => !r.hiddenByCollapse);
}

/**
 * What normalising replaced. Given to `denormalize` it is the exact inverse,
 * which is all a command's `revert` needs: undo the normalisation, then its
 * own change. Snapshotting every layer's masks instead, and normalising again
 * on the way back, left the layer ORDER as the second pass made it — a group
 * moved and undone kept a sibling between it and its children.
 */
export interface Normalization {
  /** The layer array before re-ordering; absent when only masks were fixed. */
  layers?: Layer[];
  /** Mask fields as they were, for the layers that changed. */
  masks: Map<LayerId, MaskState>;
}

/**
 * Rewrite `sym.layers` into depth-first order, keeping sibling order, then
 * `normalizeMasks`.
 *
 * Called after anything that changes parenting, so the stored array always
 * matches what the timeline shows — and therefore what the exporter emits.
 * Always a new array: the one returned must stay as it was for `denormalize`.
 */
export function normalizeLayerOrder(sym: SymbolItem): Normalization {
  const layers = sym.layers;
  const ordered = layerRows(sym, true).map((r) => r.layer);
  sym.layers = ordered.length === layers.length ? ordered : [...layers];
  return { layers, masks: normalizeMasks(sym).masks };
}

/** Put back what `normalizeLayerOrder` or `normalizeMasks` replaced. */
export function denormalize(sym: SymbolItem, n: Normalization): void {
  if (n.layers) sym.layers = n.layers;
  for (const [id, state] of n.masks) {
    const l = sym.layers.find((x) => x.id === id);
    if (l) assignMask(l, state);
  }
}

/* ── Masks ───────────────────────────────────────────────────────────────
   A mask layer clips the layers linked to it, which sit directly beneath it.
   DragonBones has no mask concept at all, so this is an editor + Pixi-host
   feature: `core/export/masks.ts` writes the relationships to a sidecar and
   the `ANIMO_masks` extension assigns `display.mask` at runtime. Nothing here can be
   expressed in `_ske.json`, which is why the invariants are enforced in the
   document rather than discovered at export time.                         */

/**
 * The mask fields that have to change for every link to mean something: a
 * link whose mask was deleted, demoted, or has ended up BELOW what it clips
 * is dropped, and a mask left with nothing to clip is demoted — or its
 * artwork would vanish from the stage for no visible reason. Only the layers
 * that change are listed, with their new state. Pure.
 *
 * Deliberately not a re-order: moving a layer out from under its mask is a
 * legitimate way to unlink it, and silently dragging it back would fight the
 * user. Contiguity is imposed when the link is made, not policed forever.
 */
export function maskRepairs(layers: readonly Layer[]): Map<LayerId, MaskState> {
  const indexOf = new Map(layers.map((l, i) => [l.id, i]));
  const byId = new Map(layers.map((l) => [l.id, l]));
  const link = new Map<LayerId, LayerId | undefined>();
  for (const layer of layers) {
    if (!layer.maskedBy) continue;
    const mask = byId.get(layer.maskedBy);
    const ok = mask
      && mask.isMask === true
      && mask.id !== layer.id
      // layers[0] is the TOP row, so "above" is a SMALLER index.
      && indexOf.get(mask.id)! < indexOf.get(layer.id)!;
    link.set(layer.id, ok ? layer.maskedBy : undefined);
  }
  const clipping = new Set([...link.values()].filter((id) => id !== undefined));

  const out = new Map<LayerId, MaskState>();
  for (const layer of layers) {
    const maskedBy = link.get(layer.id);
    const isMask = layer.isMask === true && clipping.has(layer.id);
    if (maskedBy !== layer.maskedBy || isMask !== (layer.isMask === true)) {
      out.set(layer.id, { isMask, maskedBy });
    }
  }
  return out;
}

/** Apply `maskRepairs` and return what it replaced. */
export function normalizeMasks(sym: SymbolItem): Normalization {
  const masks = new Map<LayerId, MaskState>();
  for (const [id, state] of maskRepairs(sym.layers)) {
    const l = sym.layers.find((x) => x.id === id)!;
    masks.set(id, maskStateOf(l));
    assignMask(l, state);
  }
  return { masks };
}

/** The mask fields of one layer. */
export interface MaskState {
  isMask?: boolean;
  maskedBy?: LayerId;
}

export function maskStateOf(l: Layer): MaskState {
  return { isMask: l.isMask, maskedBy: l.maskedBy };
}

/** Absent rather than false/undefined-valued, so a saved file stays clean. */
export function assignMask(l: Layer, state: MaskState): void {
  if (state.isMask) l.isMask = true; else delete l.isMask;
  if (state.maskedBy) l.maskedBy = state.maskedBy; else delete l.maskedBy;
}

/** maskLayerId -> the layers it clips, in paint order. */
export function maskGroups(sym: SymbolItem): Map<LayerId, Layer[]> {
  const out = new Map<LayerId, Layer[]>();
  for (const layer of sym.layers) {
    if (!layer.maskedBy) continue;
    const list = out.get(layer.maskedBy);
    if (list) list.push(layer);
    else out.set(layer.maskedBy, [layer]);
  }
  return out;
}

/**
 * The layer a new mask takes with it: the one directly beneath, unless it is
 * already a mask or already spoken for.
 *
 * Exactly Flash's behaviour — "Mask" links one layer and you add the rest by
 * hand. Swallowing the whole run below would be friendlier right until the
 * one time it quietly took four layers you meant to keep unmasked.
 */
export function maskCandidate(sym: SymbolItem, maskLayerId: LayerId): Layer | null {
  const i = sym.layers.findIndex((l) => l.id === maskLayerId);
  if (i < 0) return null;
  const below = sym.layers[i + 1];
  if (!below || below.isMask || below.maskedBy) return null;
  return below;
}

/**
 * The `to` of a `ReorderLayer` that lands `movingId` directly ABOVE `targetId`,
 * which is where the drop line is drawn. `ReorderLayer` lifts the layer out
 * before inserting, so moving down the list has to aim one index higher —
 * the target's own index put it one row below the line.
 */
export function indexAbove(sym: SymbolItem, movingId: LayerId, targetId: LayerId): number {
  const from = sym.layers.findIndex((l) => l.id === movingId);
  const at = sym.layers.findIndex((l) => l.id === targetId);
  return Math.max(0, from >= 0 && from < at ? at - 1 : at);
}

/** Every descendant of a layer, for select-with-children and delete: depth
 *  first, children in node order. One pass builds the child lists, so a deep
 *  rig costs O(n) rather than a scan of every node per descendant. */
export function descendantsOf(sym: SymbolItem, nodeId: NodeId): NodeId[] {
  const children = new Map<NodeId, NodeId[]>();
  for (const node of Object.values(sym.nodes)) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId);
    if (list) list.push(node.id);
    else children.set(node.parentId, [node.id]);
  }
  const out: NodeId[] = [];
  const seen = new Set<NodeId>([nodeId]);
  const walk = (id: NodeId, depth: number) => {
    if (depth > 64) return;
    for (const child of children.get(id) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      walk(child, depth + 1);
    }
  };
  walk(nodeId, 0);
  return out;
}

/** `ids` and everything under them, each once, in that order: what a drag, a
 *  cut or a layer copy actually takes along. */
export function withDescendants(sym: SymbolItem, ids: readonly NodeId[]): NodeId[] {
  const out = new Set<NodeId>();
  for (const id of ids) {
    if (out.has(id)) continue;
    out.add(id);
    for (const d of descendantsOf(sym, id)) out.add(d);
  }
  return [...out];
}

/** The nearest mask layer above `layerId`, or null. */
export function nearestMaskAbove(sym: SymbolItem, layerId: LayerId): Layer | null {
  const i = sym.layers.findIndex((l) => l.id === layerId);
  for (let n = i - 1; n >= 0; n--) {
    const l = sym.layers[n]!;
    if (l.isMask) return l;
  }
  return null;
}

/**
 * What New Group does with a selection: which nodes it adopts, where the
 * group goes and where its origin sits. Pure.
 *
 * Only the TOPMOST selected nodes are adopted — a node whose ancestor is also
 * selected comes along inside it, and re-parenting it too flattened the rig
 * (⌘A, New Group: every bone lost its parent). The group goes under their
 * shared parent when they have one, so a group made inside a group stays
 * there; its origin is the mean of their positions in that space.
 */
export function groupPlan(
  sym: SymbolItem, selected: readonly NodeId[], worldOrigin: (id: NodeId) => { x: number; y: number },
): { members: NodeId[]; parent: NodeId | null; origin: { x: number; y: number }; index: number } {
  const chosen = new Set(selected.filter((id) => sym.nodes[id]));
  const members = [...chosen].filter((id) => {
    const seen = new Set<NodeId>([id]);
    for (let p = sym.nodes[id]!.parentId; p && !seen.has(p); p = sym.nodes[p]?.parentId ?? null) {
      if (chosen.has(p)) return false;
      seen.add(p);
    }
    return true;
  });
  const first = members[0] ? sym.nodes[members[0]]!.parentId : null;
  const shared = members.every((id) => sym.nodes[id]!.parentId === first);
  const parent = shared ? first : null;
  // Positions in the group's future parent space: the binds themselves when
  // they share one, the scene positions when the group lands at the top.
  const points = members.map((id) => (shared ? sym.nodes[id]!.bind : worldOrigin(id)));
  const origin = points.length
    ? {
        x: Math.round(points.reduce((t, p) => t + p.x, 0) / points.length),
        y: Math.round(points.reduce((t, p) => t + p.y, 0) / points.length),
      }
    : { x: 0, y: 0 };
  const indices = members.map((id) => sym.layers.findIndex((l) => l.nodeId === id)).filter((i) => i >= 0);
  return { members, parent, origin, index: indices.length ? Math.min(...indices) : 0 };
}
