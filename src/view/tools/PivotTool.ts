import type { Tool, ToolContext } from "./Tool";
import type { NodeId } from "@/core/doc/ids";
import { shownDisplay } from "@/core/doc/pose";
import { mat } from "@/core/math/Matrix2D";
import type { Point } from "@/core/math/geom";
import { SetPivot } from "@/core/history/commands";
import { transformAtFrame } from "@/app/TimelineOps";
import { type NodeSnapshot, pointerToImagePx, snapshotOf } from "./transformOps";
import { hitAt } from "./SelectTool";

/**
 * Transform Point (P): put a node's origin where you click.
 *
 * The toolbar has had this button since the first build with nothing behind
 * it — `ToolManager` fell back to the Selection tool, so pressing P and
 * dragging marquee-selected instead. The capability existed only as the pivot
 * handle of the Free Transform gizmo, which is a 6-pixel target you have to
 * know is there.
 *
 * It draws no gizmo of its own: with the box handles hidden, the white dot the
 * selection already carries IS the transform point, and there is nothing on
 * screen inviting a scale this tool would not perform.
 */
export class PivotTool implements Tool {
  readonly id = "pivot";

  private snap: NodeSnapshot | null = null;

  onPointerDown(e: PointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const world = ctx.toWorld(e);
    const hit = hitAt(ctx, world.x, world.y);

    if (!hit) { ctx.store.clearSelection(); return; }
    if (!ctx.store.selection.nodes.includes(hit)) ctx.store.selectNodes([hit]);

    this.snap = this.snapshot(ctx, hit as NodeId);
    if (!this.snap) return;

    ctx.store.history.beginInteraction("node.pivot");
    this.apply(ctx, world);
  }

  onPointerMove(e: PointerEvent, ctx: ToolContext): void {
    if (!this.snap) return;
    this.apply(ctx, ctx.toWorld(e));
  }

  onPointerUp(_e: PointerEvent, ctx: ToolContext): void {
    if (!this.snap) return;
    ctx.store.history.endInteraction();
    this.snap = null;
    ctx.invalidate();
  }

  onCancel(ctx: ToolContext): void {
    if (this.snap) ctx.store.history.abortInteraction();
    this.snap = null;
    ctx.invalidate();
  }

  onHover(e: PointerEvent, ctx: ToolContext): void {
    const w = ctx.toWorld(e);
    ctx.setCursor(hitAt(ctx, w.x, w.y) ? "crosshair" : "");
  }

  /**
   * `SetPivot` moves the origin and compensates the pose, so the artwork stays
   * exactly where it is and only the point everything rotates about moves.
   */
  private apply(ctx: ToolContext, world: Point): void {
    const snap = this.snap;
    if (!snap) return;
    const px = pointerToImagePx(snap, world);
    if (!px) return;
    // Whole pixels, as the Free Transform handle does; the Properties panel
    // still accepts any value.
    const target = { x: Math.round(px.x), y: Math.round(px.y) };
    ctx.store.apply(new SetPivot(
      ctx.store.currentSymbolId, new Map([[snap.id, target]]), { displays: new Map([[snap.id, snap.display]]) },
    ));
    ctx.invalidate();
  }

  private snapshot(ctx: ToolContext, id: NodeId): NodeSnapshot | null {
    const pose = ctx.pose();
    const sym = ctx.store.currentSymbol;
    const node = sym.nodes[id];
    const entry = pose?.byNode.get(id);
    if (!pose || !node || !entry) return null;
    // Locked layers are not moved by any other tool either.
    if (sym.layers.some((l) => l.nodeId === id && l.locked)) return null;
    const parent = node.parentId ? pose.byNode.get(node.parentId)?.world : undefined;
    const shown = shownDisplay(entry);
    return snapshotOf(
      id, transformAtFrame(ctx.store, node), entry.world, parent ?? mat(), shown.pivot, shown.index,
    );
  }
}
