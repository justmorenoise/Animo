import type { Tool, ToolContext } from "./Tool";
import type { NodeId } from "@/core/doc/ids";
import { shownDisplay } from "@/core/doc/pose";
import { rectFromPoints } from "@/core/math/geom";
import { applyEdit, transformAtFrame } from "@/app/TimelineOps";
import { moveBy, type NodeSnapshot, snapshotOf, topmostSelected } from "./transformOps";
import type { Transform } from "@/core/math/Transform";
import { quantize } from "@/core/math/Transform";
import { mat } from "@/core/math/Matrix2D";
import { pickBone } from "./boneGeom";

/**
 * The Selection tool: click to select, drag to move, marquee on empty space.
 * Scaling, rotating and skewing live on the Free Transform tool (Q), as in
 * Flash.
 */
export class SelectTool implements Tool {
  readonly id = "select";

  private mode: "none" | "maybeDrag" | "dragging" | "marquee" = "none";
  private startWorld = { x: 0, y: 0 };
  private startContent = { x: 0, y: 0 };
  private snaps: NodeSnapshot[] = [];
  private additive = false;

  onPointerDown(e: PointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    this.startWorld = ctx.toWorld(e);
    this.startContent = ctx.toContent(e);
    this.additive = e.shiftKey;

    const hit = hitAt(ctx, this.startWorld.x, this.startWorld.y);
    if (hit) {
      const already = ctx.store.selection.nodes.includes(hit);
      if (e.shiftKey) {
        ctx.store.toggleNode(hit);
      } else if (!already) {
        ctx.store.selectNodes([hit]);
      }
      // Locked layers can be clicked but not dragged.
      if (this.captureSnapshots(ctx)) this.mode = "maybeDrag";
      return;
    }

    if (!e.shiftKey) ctx.store.clearSelection();
    this.mode = "marquee";
  }

  onPointerMove(e: PointerEvent, ctx: ToolContext): void {
    if (this.mode === "none") return;
    const world = ctx.toWorld(e);
    const content = ctx.toContent(e);

    if (this.mode === "marquee") {
      ctx.setMarquee(rectFromPoints(this.startContent.x, this.startContent.y, content.x, content.y));
      ctx.invalidate();
      return;
    }

    const dx = world.x - this.startWorld.x;
    const dy = world.y - this.startWorld.y;

    if (this.mode === "maybeDrag") {
      const moved = Math.hypot(content.x - this.startContent.x, content.y - this.startContent.y);
      if (moved < 3) return;
      this.mode = "dragging";
      ctx.beginSnap(this.snaps.map((s) => s.id));
      ctx.store.history.beginInteraction("node.transform");
    }

    // Shift constrains to the dominant axis, as in Flash.
    let mx = dx, my = dy;
    if (e.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) my = 0; else mx = 0;
    }

    // Snapping, unless ⌘/Ctrl is held — the standard way to ask for the raw
    // delta for the length of one drag without touching the setting.
    const snapped = ctx.snapDelta(mx, my, e.metaKey || e.ctrlKey);
    mx = snapped.dx; my = snapped.dy;

    const next = new Map<NodeId, Transform>();
    for (const s of this.snaps) next.set(s.id, moveBy(s, mx, my));
    applyEdit(ctx.store, next, true);
    ctx.invalidate();
  }

  onPointerUp(e: PointerEvent, ctx: ToolContext): void {
    if (this.mode === "marquee") {
      const content = ctx.toContent(e);
      const r = rectFromPoints(this.startContent.x, this.startContent.y, content.x, content.y);
      ctx.setMarquee(null);
      if (r.w > 3 || r.h > 3) {
        const sym = ctx.store.currentSymbol;
        const skip = new Set<string>(
          sym.layers.filter((l) => l.locked || !l.visible).map((l) => l.nodeId),
        );
        ctx.store.selectNodes(ctx.nodesInRect(r, skip) as NodeId[], this.additive);
      }
    }
    ctx.endSnap();
    if (this.mode === "dragging") {
      // Quantise once on commit so golden files stay stable without the drag
      // feeling sticky.
      const next = new Map<NodeId, Transform>();
      for (const s of this.snaps) {
        const n = ctx.store.node(s.id);
        if (n) next.set(s.id, quantize(transformAtFrame(ctx.store, n)));
      }
      applyEdit(ctx.store, next, true);
      ctx.store.history.endInteraction();
    }
    this.mode = "none";
    this.snaps = [];
    ctx.invalidate();
  }

  onCancel(ctx: ToolContext): void {
    ctx.endSnap();
    if (this.mode === "dragging") ctx.store.history.abortInteraction();
    this.mode = "none";
    this.snaps = [];
    ctx.setMarquee(null);
    ctx.invalidate();
  }

  onHover(e: PointerEvent, ctx: ToolContext): void {
    const w = ctx.toWorld(e);
    ctx.setCursor(hitAt(ctx, w.x, w.y) ? "move" : "");
  }

  /** Returns false when nothing draggable is selected. */
  private captureSnapshots(ctx: ToolContext): boolean {
    const pose = ctx.pose();
    if (!pose) return false;
    const sym = ctx.store.currentSymbol;
    const lockedNodes = new Set(sym.layers.filter((l) => l.locked).map((l) => l.nodeId));

    this.snaps = [];
    const ids = topmostSelected(
      ctx.store.selection.nodes.filter((id) => !lockedNodes.has(id)),
      (id) => sym.nodes[id]?.parentId,
    );
    for (const id of ids) {
      const entry = pose.byNode.get(id);
      const node = sym.nodes[id];
      if (!entry || !node) continue;
      const parentEntry = node.parentId ? pose.byNode.get(node.parentId) : undefined;
      const shown = shownDisplay(entry);
      this.snaps.push(snapshotOf(
        id, transformAtFrame(ctx.store, node), entry.world, parentEntry?.world ?? mat(),
        shown.pivot, shown.index,
      ));
    }
    return this.snaps.length > 0;
  }
}

/**
 * Alpha-accurate pick that also skips hidden and locked layers.
 *
 * An IK target under the pointer wins over artwork. The target sits on the
 * effector's tip, which is exactly where the hand or foot artwork is, and the
 * artwork hit test ignores bones — so pressing on the target handle used to
 * pick up the hand instead, and moving or rotating it keyed a deformation on
 * the hand while the target stayed put.
 */
export function hitAt(ctx: ToolContext, wx: number, wy: number): NodeId | null {
  const sym = ctx.store.currentSymbol;
  const skip = new Set<string>(
    sym.layers.filter((l) => l.locked || !l.visible).map((l) => l.nodeId),
  );
  const pose = ctx.pose();
  if (pose && ctx.store.ui.showBones && sym.ik.length) {
    const targets = new Set<string>(sym.ik.map((k) => k.targetId));
    const target = pickBone(pose, { x: wx, y: wy }, 10 / ctx.camera.screenScale,
      (id) => targets.has(id) && !skip.has(id));
    if (target) return target;
  }
  return ctx.hitTest(wx, wy, skip) as NodeId | null;
}
