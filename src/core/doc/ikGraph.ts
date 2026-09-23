import type { IkConstraint, SymbolItem } from "./types";
import type { NodeId } from "./ids";

/**
 * Who a constraint touches.
 *
 * A bone chain says what it does through the parent hierarchy — a layer row
 * indented under another one moves with it. An IK target says nothing: it is
 * parented OUTSIDE the chain it drives (a target the chain moved would chase
 * itself), so the one relationship that matters is the one the layer tree
 * cannot draw. `symbol.ik` holds it, and every place that has to show it —
 * the layer icons, the Properties panel, the stage links — reads it here
 * rather than re-deriving the runtime's chain rule.
 *
 * Pure, so `tests/ikGraph.test.ts` can check the rule against the real rig.
 */

/** `effector` is the bone named by the constraint; `root` is its parent when
 *  the solve is two-bone; `target` is the handle that pulls them. */
export type IkRole = "target" | "effector" | "root";

export interface IkRelation {
  constraint: IkConstraint;
  role: IkRole;
  /** The bones the solver moves, root first: one or two of them. */
  chain: NodeId[];
}

/**
 * The bones a constraint actually drives, by the runtime's own rule
 * (`chain > 0 && bone.parent !== null` is the two-bone solve rooted at the
 * parent; anything else is the one-bone look-at). A `chain: 1` constraint on
 * a bone whose parent is gone therefore reports ONE bone, which is what the
 * runtime will do with it.
 */
export function ikChain(symbol: SymbolItem, k: IkConstraint): NodeId[] {
  const bone = symbol.nodes[k.boneId];
  if (!bone) return [];
  const parentId = bone.parentId;
  if (k.chain > 0 && parentId && symbol.nodes[parentId]) return [parentId, k.boneId];
  return [k.boneId];
}

/**
 * Every constraint this node takes part in, and how. A target can drive more
 * than one chain, so this is a list — the panel used to `find` the first and
 * silently hide the rest.
 */
export function ikRelations(symbol: SymbolItem, nodeId: NodeId): IkRelation[] {
  const out: IkRelation[] = [];
  for (const constraint of symbol.ik) {
    const chain = ikChain(symbol, constraint);
    if (constraint.targetId === nodeId) out.push({ constraint, role: "target", chain });
    else if (constraint.boneId === nodeId) out.push({ constraint, role: "effector", chain });
    else if (chain.length > 1 && chain[0] === nodeId) out.push({ constraint, role: "root", chain });
  }
  return out;
}

/** The two sets the stage colours and the layer list icons: every target, and
 *  every bone some solver moves. One pass over `ik` for a whole render. */
export function ikRoles(symbol: SymbolItem): { targets: Set<NodeId>; driven: Set<NodeId> } {
  const targets = new Set<NodeId>();
  const driven = new Set<NodeId>();
  for (const k of symbol.ik) {
    targets.add(k.targetId);
    for (const id of ikChain(symbol, k)) driven.add(id);
  }
  return { targets, driven };
}

/** What one node is, for an icon: a handle, a solved bone, or neither. */
export function ikRoleOf(symbol: SymbolItem, nodeId: NodeId): "target" | "driven" | null {
  for (const k of symbol.ik) {
    if (k.targetId === nodeId) return "target";
    if (ikChain(symbol, k).includes(nodeId)) return "driven";
  }
  return null;
}

/**
 * The relationship in words, for the layer row's tooltip — the place someone
 * asking "what does this bone even do?" is already pointing at.
 *
 * Null when the node is in no constraint, so the caller can leave the title
 * alone rather than writing "not an IK bone" on every ordinary row.
 */
export function ikSummary(symbol: SymbolItem, nodeId: NodeId): string | null {
  const relations = ikRelations(symbol, nodeId);
  if (relations.length === 0) return null;
  const nameOf = (id: NodeId) => symbol.nodes[id]?.name ?? "?";

  if (relations[0]!.role === "target") {
    const parts = relations.map((r) =>
      `${r.chain.map(nameOf).join(" → ")} (${r.constraint.name})`);
    return `IK target for ${parts.join("; ")}. `
      + "Drag it to pose the chain. The bones follow it and never get keyframes.";
  }

  const parts = relations.map((r) =>
    `${nameOf(r.constraint.targetId)} (${r.constraint.name})`);
  return `Moved by IK, following ${parts.join("; ")}. `
    + "During playback it follows the target, so do not keyframe it.";
}

/**
 * The nodes among `ids` whose pose the IK solver sets. Re-parenting one keeps
 * it where it LOOKS, and what it looks like is the solved pose: the solve
 * would be written into its rest pose and keys, which the runtime then
 * solves again on top.
 */
export function ikDrivenAmong(symbol: SymbolItem, ids: readonly NodeId[]): NodeId[] {
  const { driven } = ikRoles(symbol);
  return ids.filter((id) => driven.has(id));
}
