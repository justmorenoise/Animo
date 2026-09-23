import type { Tool, ToolContext } from "./Tool";
import type { NodeId } from "@/core/doc/ids";
import { newIkId } from "@/core/doc/ids";
import type { Transform } from "@/core/math/Transform";
import { fromMatrix, tf } from "@/core/math/Transform";
import { invert, mat, matOf, mul } from "@/core/math/Matrix2D";
import { createLayer, createNode } from "@/core/doc/defaults";
import { AddNode } from "@/core/history/commands";
import { AddIkConstraint } from "@/core/history/ikCommands";
import { applyTransforms } from "@/app/TimelineOps";
import { moveBy, type NodeSnapshot, snapshotOf } from "./transformOps";
import { boneSegment, pickBone } from "./boneGeom";

/**
 * The IK tool: click a bone to constrain it, drag the target to pose it.
 *
 * Dragging a target writes to the TARGET only — never to the bones it moves.
 * That is the whole point: the file carries the constraint, and the runtime
 * solves the chain on playback, so the editor must show the same thing
 * without baking the solve into keyframes. `pose.ts` runs the runtime's own
 * solver at display time to keep the two honest.
 */
export class IkTool implements Tool {
  readonly id = "ik";
  readonly showsGizmo = false;

  private dragging: NodeSnapshot | null = null;
  private startWorld = { x: 0, y: 0 };
  private startContent = { x: 0, y: 0 };
  private moved = false;

  onHover(e: PointerEvent, ctx: ToolContext): void {
    const pose = ctx.pose();
    if (!pose) return;
    const world = ctx.toWorld(e);
    const tolerance = 10 / ctx.camera.screenScale;
    const { targets, bones } = pickable(ctx);
    const onTarget = pickBone(pose, world, tolerance, targets);
    const onBone = onTarget ? null : pickBone(pose, world, tolerance, bones);
    ctx.setCursor(onTarget ? "move" : onBone ? "cell" : "default");
  }

  onPointerDown(e: PointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const pose = ctx.pose();
    if (!pose) return;

    this.startWorld = ctx.toWorld(e);
    this.startContent = ctx.toContent(e);
    this.moved = false;
    const tolerance = 10 / ctx.camera.screenScale;
    const { targets, bones } = pickable(ctx);

    // A target under the pointer is a handle: pick it up.
    const target = pickBone(pose, this.startWorld, tolerance, targets);
    if (target) {
      const entry = pose.byNode.get(target)!;
      const parent = entry.node.parentId ? pose.byNode.get(entry.node.parentId) : undefined;
      ctx.store.selectNodes([target]);
      this.dragging = snapshotOf(target, entry.local, entry.world, parent?.world, entry.node.pivot);
      return;
    }

    const bone = pickBone(pose, this.startWorld, tolerance, bones);
    if (!bone) { ctx.store.clearSelection(); return; }

    // A bone that already has a constraint: select its target rather than
    // stacking a second constraint on it.
    const existing = ctx.store.currentSymbol.ik.find((k) => k.boneId === bone);
    if (existing) { ctx.store.selectNodes([existing.targetId]); return; }

    this.constrain(ctx, bone);
  }

  onPointerMove(e: PointerEvent, ctx: ToolContext): void {
    if (!this.dragging) return;
    const content = ctx.toContent(e);
    if (!this.moved) {
      if (Math.hypot(content.x - this.startContent.x, content.y - this.startContent.y) < 3) return;
      this.moved = true;
      ctx.store.history.beginInteraction("node.transform");
    }

    const world = ctx.toWorld(e);
    let dx = world.x - this.startWorld.x;
    let dy = world.y - this.startWorld.y;
    if (e.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0;
    }

    const next = new Map<NodeId, Transform>([[this.dragging.id, moveBy(this.dragging, dx, dy)]]);
    applyTransforms(ctx.store, next, true);
    ctx.invalidate();
  }

  onPointerUp(_e: PointerEvent, ctx: ToolContext): void {
    if (this.dragging && this.moved) ctx.store.history.endInteraction();
    this.dragging = null;
    this.moved = false;
    ctx.invalidate();
  }

  /** Escape puts the target back, as it does for every other tool's drag. */
  onCancel(ctx: ToolContext): void {
    if (this.dragging && this.moved) ctx.store.history.abortInteraction();
    this.dragging = null;
    this.moved = false;
    ctx.invalidate();
  }

  /**
   * Constrain a bone: a target bone at its tip, plus the constraint itself.
   *
   * The chain length follows the runtime's rule — two bones when the effector
   * has a parent to root the solve, one otherwise — and the target is parented
   * OUTSIDE the chain, since a target that the chain moves would chase itself.
   */
  private constrain(ctx: ToolContext, boneId: NodeId): void {
    const store = ctx.store;
    const pose = ctx.pose();
    const symbol = store.currentSymbol;
    const effector = pose?.byNode.get(boneId);
    if (!effector) return;

    const parentId = effector.node.parentId;
    const parentIsBone = parentId ? symbol.nodes[parentId]?.kind === "bone" : false;
    const chain: 0 | 1 = parentIsBone ? 1 : 0;
    const rootId = chain === 1 ? parentId! : boneId;
    const targetParentId = symbol.nodes[rootId]?.parentId ?? null;
    const targetParent = targetParentId ? pose?.byNode.get(targetParentId) : undefined;

    const tip = boneSegment(effector);
    const world = matOf(1, 0, 0, 1, tip.bx, tip.by);
    let local = world;
    if (targetParent) {
      const inverse = mat();
      if (invert(inverse, targetParent.world)) local = mul(mat(), inverse, world);
    }

    const target = createNode("bone", uniqueName(symbol, `${effector.node.name}_target`), {
      parentId: targetParentId,
    });
    target.bind = fromMatrix(tf(), local);
    target.boneLength = 20;

    const layer = createLayer(target.id, target.name, symbol.layers.length);

    store.transaction(`IK on ${effector.node.name}`, () => {
      store.apply(new AddNode(`Add ${target.name}`, store.currentSymbolId, target, layer, 0));
      store.apply(new AddIkConstraint(store.currentSymbolId, {
        id: newIkId(),
        name: uniqueIkName(symbol, `${effector.node.name}_ik`),
        boneId,
        targetId: target.id,
        chain,
        bendPositive: true,
        weight: 1,
      }));
    });
    store.selectNodes([target.id]);
    store.emit("doc");
  }
}

/**
 * What a pointer may pick: targets to drag, and bones to constrain. A locked
 * or hidden layer holds for this tool as for every other, and a target is
 * never offered as a bone — with its own layer locked it would otherwise
 * fall through to the second pick and get a constraint of its own.
 */
function pickable(ctx: ToolContext): { targets: (id: NodeId) => boolean; bones: (id: NodeId) => boolean } {
  const sym = ctx.store.currentSymbol;
  const blocked = new Set(sym.layers.filter((l) => l.locked || !l.visible).map((l) => l.nodeId));
  const allTargets = new Set(sym.ik.map((k) => k.targetId));
  return {
    targets: (id) => allTargets.has(id) && !blocked.has(id),
    bones: (id) => !allTargets.has(id) && !blocked.has(id),
  };
}

function uniqueName(symbol: { nodes: Record<string, { name: string }> }, base: string): string {
  const taken = new Set(Object.values(symbol.nodes).map((n) => n.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

function uniqueIkName(symbol: { ik: Array<{ name: string }> }, base: string): string {
  const taken = new Set(symbol.ik.map((k) => k.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}
