import { adoptBefore, type Command, type TouchSet } from "./Command";
import type { IkConstraint, Project, SymbolItem } from "@/core/doc/types";
import { isSymbol } from "@/core/doc/types";
import type { ItemId, NodeId } from "@/core/doc/ids";
import { invalidateBounds } from "@/core/doc/pose";

function symbolOf(p: Project, id: ItemId): SymbolItem {
  const s = p.items[id];
  if (!isSymbol(s)) throw new Error(`Not a symbol: ${id}`);
  return s;
}

/**
 * Bones and IK constraints.
 *
 * Constraints are plain document data — the solve happens when a pose is
 * evaluated, never here — so these commands only add, remove and edit rows.
 */

export class AddIkConstraint implements Command {
  readonly kind = "ik.add";
  readonly touches: TouchSet;
  readonly label = "Add IK Constraint";

  constructor(
    private readonly symbolId: ItemId,
    private readonly constraint: IkConstraint,
  ) {
    this.touches = { symbols: [symbolId], nodes: [constraint.boneId, constraint.targetId], stage: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (!sym.ik.some((k) => k.id === this.constraint.id)) sym.ik.push(this.constraint);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    sym.ik = sym.ik.filter((k) => k.id !== this.constraint.id);
    invalidateBounds([this.symbolId]);
  }
}

export class RemoveIkConstraint implements Command {
  readonly kind = "ik.remove";
  readonly touches: TouchSet;
  readonly label = "Remove IK Constraint";
  /** Kept alive here so redo and later commands still resolve it. */
  private removed: IkConstraint | null = null;
  private index = -1;

  constructor(private readonly symbolId: ItemId, private readonly ikId: string) {
    this.touches = { symbols: [symbolId], stage: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.index = sym.ik.findIndex((k) => k.id === this.ikId);
    if (this.index < 0) return;
    this.removed = sym.ik[this.index]!;
    sym.ik.splice(this.index, 1);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    if (!this.removed || this.index < 0) return;
    const sym = symbolOf(p, this.symbolId);
    sym.ik.splice(Math.min(this.index, sym.ik.length), 0, this.removed);
    invalidateBounds([this.symbolId]);
  }
}

export interface IkPatch {
  chain?: 0 | 1;
  bendPositive?: boolean;
  weight?: number;
  name?: string;
}

export class SetIkOptions implements Command {
  readonly kind = "ik.options";
  readonly touches: TouchSet;
  readonly label = "IK Options";
  private before: IkPatch | null = null;

  constructor(
    private readonly symbolId: ItemId,
    private readonly ikId: string,
    private readonly patch: IkPatch,
  ) {
    this.touches = { symbols: [symbolId], stage: true };
  }

  private find(p: Project): IkConstraint | undefined {
    return symbolOf(p, this.symbolId).ik.find((k) => k.id === this.ikId);
  }

  apply(p: Project): void {
    const k = this.find(p);
    if (!k) return;
    this.before ??= { chain: k.chain, bendPositive: k.bendPositive, weight: k.weight, name: k.name };
    if (this.patch.chain !== undefined) k.chain = this.patch.chain;
    if (this.patch.bendPositive !== undefined) k.bendPositive = this.patch.bendPositive;
    // The runtime blends the solved rotation by this, so outside 0..1 it
    // would overshoot the target it is meant to reach.
    if (this.patch.weight !== undefined) k.weight = clamp01(this.patch.weight);
    if (this.patch.name !== undefined && this.patch.name.trim()) k.name = this.patch.name.trim();
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const k = this.find(p);
    if (!k || !this.before) return;
    if (this.before.chain !== undefined) k.chain = this.before.chain;
    if (this.before.bendPositive !== undefined) k.bendPositive = this.before.bendPositive;
    if (this.before.weight !== undefined) k.weight = this.before.weight;
    if (this.before.name !== undefined) k.name = this.before.name;
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    return next instanceof SetIkOptions && next.ikId === this.ikId
      && (Object.assign(this.patch, next.patch), true);
  }
}

export class SetBoneLength implements Command {
  readonly kind = "bone.length";
  readonly touches: TouchSet;
  readonly label = "Bone Length";
  private before = new Map<NodeId, number>();
  /** Own copy: a merge writes into it, and the caller's map is not ours. */
  private readonly lengths: Map<NodeId, number>;

  constructor(
    private readonly symbolId: ItemId,
    lengths: ReadonlyMap<NodeId, number>,
  ) {
    this.lengths = new Map(lengths);
    this.touches = { symbols: [symbolId], nodes: [...lengths.keys()], stage: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.before.size === 0) {
      for (const id of this.lengths.keys()) {
        const n = sym.nodes[id];
        if (n) this.before.set(id, n.boneLength ?? 0);
      }
    }
    for (const [id, len] of this.lengths) {
      const n = sym.nodes[id];
      // Length drives the second segment of a two-bone solve, so zero is a
      // degenerate chain rather than a harmless default.
      if (n) n.boneLength = Math.max(1, Math.round(len));
    }
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, len] of this.before) {
      const n = sym.nodes[id];
      if (n) n.boneLength = len;
    }
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetBoneLength) || next.symbolId !== this.symbolId) return false;
    this.touches.nodes?.push(...adoptBefore(this.before, next.before));
    for (const [id, len] of next.lengths) this.lengths.set(id, len);
    return true;
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}
