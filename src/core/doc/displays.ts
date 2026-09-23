import type { ItemId } from "./ids";
import type { DisplayRef, Node, NodeKind, Project } from "./types";

/**
 * A node's display list, the way a DragonBones slot has one: index 0 is the
 * node's own `itemId` and `pivot`, the rest are `extraDisplays`. A keyframe's
 * `displayIndex` picks one; -1 shows nothing. Bones, groups and empty layers
 * have no display at all.
 */
export function displaysOf(node: Node): DisplayRef[] {
  if (!node.itemId) return [];
  return [{ itemId: node.itemId, pivot: node.pivot }, ...(node.extraDisplays ?? [])];
}

export function displayAt(node: Node, index: number): DisplayRef | null {
  if (index < 0 || !node.itemId) return null;
  if (index === 0) return { itemId: node.itemId, pivot: node.pivot };
  return node.extraDisplays?.[index - 1] ?? null;
}

/** Every library item the node can show — what usage counts, cycle checks
 *  and the export's dependency walk have to follow. */
export function itemsOf(node: Node): ItemId[] {
  return displaysOf(node).map((d) => d.itemId);
}

export function sameDisplay(a: DisplayRef, b: DisplayRef): boolean {
  return a.itemId === b.itemId && a.pivot.x === b.pivot.x && a.pivot.y === b.pivot.y;
}

/**
 * The index `ref` has in `displays`, appending it when no entry shows the
 * same item about the same point. The pivot is part of the identity: a
 * keyframe's transform places the bone at its display's transform point, so
 * the same image anchored elsewhere is a different display.
 */
export function findOrAddDisplay(
  displays: DisplayRef[], ref: DisplayRef,
): { displays: DisplayRef[]; index: number } {
  const found = displays.findIndex((d) => sameDisplay(d, ref));
  if (found >= 0) return { displays, index: found };
  return {
    displays: [...displays, { itemId: ref.itemId, pivot: { ...ref.pivot } }],
    index: displays.length,
  };
}

/** The node kind an item makes, for display 0. */
export function kindOfItem(project: Project, itemId: ItemId): NodeKind {
  return project.items[itemId]?.kind === "symbol" ? "symbol" : "image";
}
