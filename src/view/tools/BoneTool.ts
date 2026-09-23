import type { Tool, ToolContext } from "./Tool";
import type { NodeId } from "@/core/doc/ids";
import { createLayer, createNode } from "@/core/doc/defaults";
import { AddNode } from "@/core/history/commands";
import { ikRoles } from "@/core/doc/ikGraph";
import { applyTransforms } from "@/app/TimelineOps";
import { SetBoneLength } from "@/core/history/ikCommands";
import { fromMatrix, tf, toMatrix } from "@/core/math/Transform";
import { invert, mat, matOf, type Matrix2D, mul } from "@/core/math/Matrix2D";
import { boneSegment, localLength, pickBoneTip } from "./boneGeom";

/**
 * The Bone tool: drag to lay down a bone, drag again from its tip to chain.
 *
 * A bone here is a node like any other — parenting IS the skeleton — so a
 * chain is just a run of nodes each parented to the last. That is also why
 * binding artwork to a bone is nothing more than reparenting it.
 *
 * Alt-dragging an existing tip re-aims and re-lengthens that bone instead of
 * starting a child, which is the other half of what a bone tool is for.
 */
export class BoneTool implements Tool {
  readonly id = "bone";
  readonly showsGizmo = false;

  private draft: {
    parentId: NodeId | null;
    editing: NodeId | null;
    ax: number; ay: number; bx: number; by: number;
  } | null = null;

  onHover(e: PointerEvent, ctx: ToolContext): void {
    const pose = ctx.pose();
    if (!pose) return;
    const world = ctx.toWorld(e);
    const near = pickBoneTip(pose, world, 8 / ctx.camera.screenScale, pickable(ctx));
    ctx.setCursor(near ? "alias" : "crosshair");
  }

  onPointerDown(e: PointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const pose = ctx.pose();
    const world = ctx.toWorld(e);
    const tolerance = 8 / ctx.camera.screenScale;

    let parentId: NodeId | null = null;
    let editing: NodeId | null = null;
    let ax = world.x;
    let ay = world.y;

    const tip = pose ? pickBoneTip(pose, world, tolerance, pickable(ctx)) : null;
    if (tip) {
      const entry = pose!.byNode.get(tip)!;
      const segment = boneSegment(entry);
      if (e.altKey) {
        // Re-aim the bone itself: start from ITS origin, not its tip.
        editing = tip;
        ax = segment.ax;
        ay = segment.ay;
      } else {
        parentId = tip;
        ax = segment.bx;
        ay = segment.by;
      }
    }

    this.draft = { parentId, editing, ax, ay, bx: ax, by: ay };
    ctx.setDraftBone({ ax, ay, bx: ax, by: ay });
    ctx.invalidate();
  }

  onPointerMove(e: PointerEvent, ctx: ToolContext): void {
    if (!this.draft) return;
    const world = ctx.toWorld(e);
    this.draft.bx = world.x;
    this.draft.by = world.y;

    // Shift snaps the direction to 15°, as everywhere else.
    if (e.shiftKey) {
      const dx = world.x - this.draft.ax;
      const dy = world.y - this.draft.ay;
      const step = Math.PI / 12;
      const angle = Math.round(Math.atan2(dy, dx) / step) * step;
      const len = Math.hypot(dx, dy);
      this.draft.bx = this.draft.ax + Math.cos(angle) * len;
      this.draft.by = this.draft.ay + Math.sin(angle) * len;
    }

    ctx.setDraftBone({ ...this.draft });
    ctx.invalidate();
  }

  onPointerUp(_e: PointerEvent, ctx: ToolContext): void {
    const draft = this.draft;
    this.draft = null;
    ctx.setDraftBone(null);
    ctx.invalidate();
    if (!draft) return;

    const length = Math.hypot(draft.bx - draft.ax, draft.by - draft.ay);
    if (length < 6 / ctx.camera.screenScale) return;          // a click, not a drag

    if (draft.editing) {
      this.reaim(ctx, draft.editing, draft, length);
      return;
    }
    this.create(ctx, draft, length);
  }

  onCancel(ctx: ToolContext): void {
    this.draft = null;
    ctx.setDraftBone(null);
    ctx.invalidate();
  }

  /** A new bone, parented to the tip it started from. */
  private create(
    ctx: ToolContext,
    draft: { parentId: NodeId | null; ax: number; ay: number; bx: number; by: number },
    length: number,
  ): void {
    const store = ctx.store;
    const symbol = store.currentSymbol;
    const pose = ctx.pose();
    const parentEntry = draft.parentId ? pose?.byNode.get(draft.parentId) : undefined;

    const local = localFromWorld(worldOf(draft), parentEntry?.world);
    const node = createNode("bone", uniqueBoneName(store), { parentId: draft.parentId ?? null });
    node.bind = fromMatrix(tf(), local);
    node.boneLength = Math.max(1, Math.round(length));

    const layer = createLayer(node.id, node.name, symbol.layers.length);
    store.apply(new AddNode(`Add ${node.name}`, store.currentSymbolId, node, layer, 0));
    store.selectNodes([node.id]);
    store.emit("doc");
  }

  /** Alt-drag: keep the bone where it is, change where it points and how far. */
  private reaim(
    ctx: ToolContext, id: NodeId,
    draft: { ax: number; ay: number; bx: number; by: number },
    length: number,
  ): void {
    const store = ctx.store;
    const pose = ctx.pose();
    const entry = pose?.byNode.get(id);
    if (!entry) return;
    const parentId = entry.node.parentId;
    const parentEntry = parentId ? pose?.byNode.get(parentId) : undefined;

    const local = localFromWorld(worldOf(draft), parentEntry?.world);
    const next = fromMatrix(tf(), local);
    // Direction and length only; the bone stays where it was rooted.
    next.x = entry.local.x;
    next.y = entry.local.y;
    next.scaleX = entry.local.scaleX;
    next.scaleY = entry.local.scaleY;

    // Through `applyTransforms`, like every other tool: in Animate mode the
    // aim is a key at the playhead. Writing the bind pose there moved the
    // bone's origin to its animated position while the stage, drawn from the
    // track, showed nothing happen. A bone the IK solver drives is never
    // keyed, so there only its length changes.
    const driven = store.ui.mode === "animate" && ikRoles(store.currentSymbol).driven.has(id);
    // The drag is measured on the stage; the bone stores its own units.
    const aimed = toMatrix(mat(), next);
    const boneWorld = driven ? entry.world : parentEntry ? mul(mat(), parentEntry.world, aimed) : aimed;
    store.transaction("Aim Bone", () => {
      if (!driven) applyTransforms(store, new Map([[id, next]]));
      store.apply(new SetBoneLength(store.currentSymbolId, new Map([[id, localLength(length, boneWorld)]])));
    });
    store.emit("doc");
  }
}

/** The drag as a world matrix: rotation from the drag, origin at its start. */
function worldOf(draft: { ax: number; ay: number; bx: number; by: number }): Matrix2D {
  const angle = Math.atan2(draft.by - draft.ay, draft.bx - draft.ax);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return matOf(cos, sin, -sin, cos, draft.ax, draft.ay);
}

/** Express a desired world matrix in a parent's space. */
function localFromWorld(world: Matrix2D, parent?: Matrix2D): Matrix2D {
  if (!parent) return world;
  const inverse = mat();
  if (!invert(inverse, parent)) return world;
  return mul(mat(), inverse, world);
}

/** Locked and hidden layers take no gesture, here as in every other tool. */
function pickable(ctx: ToolContext): (id: NodeId) => boolean {
  const blocked = new Set(ctx.store.currentSymbol.layers
    .filter((l) => l.locked || !l.visible).map((l) => l.nodeId));
  return (id) => !blocked.has(id);
}

function uniqueBoneName(store: { currentSymbol: { nodes: Record<string, { name: string }> } }): string {
  const taken = new Set(Object.values(store.currentSymbol.nodes).map((n) => n.name));
  if (!taken.has("bone")) return "bone";
  for (let i = 2; ; i++) {
    if (!taken.has(`bone_${i}`)) return `bone_${i}`;
  }
}
