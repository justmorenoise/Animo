import type { Tool, ToolContext } from "./Tool";
import type { NodeId } from "@/core/doc/ids";
import { shownDisplay } from "@/core/doc/pose";
import type { Transform } from "@/core/math/Transform";
import { quantize } from "@/core/math/Transform";
import { mat, matOf } from "@/core/math/Matrix2D";
import type { Point } from "@/core/math/geom";
import { shortestDelta } from "@/core/math/angle";
import { SetPivot } from "@/core/history/commands";
import { applyEdit, transformAtFrame } from "@/app/TimelineOps";
import {
    cornerFraction,
    cursorFor,
    edgeFraction,
    type Gizmo,
    type HandleId,
    handlePoints,
    hitGizmo,
    oppositeCorner,
    oppositeEdge,
} from "./gizmo";
import {
    applyWorldMatrix,
    moveBy,
    type NodeSnapshot,
    pointerToImagePx,
    rotateAbout,
    scaleLocal,
    skewLocal,
    uniformFactor,
    snapshotOf,
    topmostSelected,
} from "./transformOps";
import { hitAt } from "./SelectTool";

/**
 * Flash's Free Transform: eight scale handles, rotation just outside the
 * corners, skew along the edges, and a draggable transform point.
 *
 * A single selection is transformed along its OWN axes, so handles stay glued
 * to rotated and sheared artwork. A multi-selection gets one axis-aligned
 * group box and is transformed in world space, which is what Flash does —
 * objects at different angles share no local frame.
 */
export class FreeTransformTool implements Tool {
  readonly id = "freeTransform";
  readonly showsGizmo = true;

  private active: HandleId | null = null;
  /** Whether this drag changed anything; a bare click must not write. */
  private moved = false;
  private snaps: NodeSnapshot[] = [];
  private gizmo: Gizmo | null = null;
  private anchorWorld: Point = { x: 0, y: 0 };
  private startWorld: Point = { x: 0, y: 0 };
  private startAngle = 0;
  private totalTheta = 0;
  private lastTheta = 0;
  private startBox = { x: 0, y: 0, w: 0, h: 0 };
  private startPivotWorld: Point = { x: 0, y: 0 };

  onPointerDown(e: PointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const g = ctx.gizmo();
    const world = ctx.toWorld(e);

    // No box yet, or the click is outside it: fall back to picking.
    if (!g) {
      const hit = hitAt(ctx, world.x, world.y);
      if (hit) ctx.store.selectNodes([hit]);
      else ctx.store.clearSelection();
      return;
    }

    const content = ctx.toContent(e);
    const handle = hitGizmo(g, content.x, content.y, {
      toScreen: (p) => ctx.toScreen(p),
      handleRadius: ctx.store.prefs.value.gizmos.handleSize,
    });

    if (!handle) {
      const hit = hitAt(ctx, world.x, world.y);
      if (hit) ctx.store.selectNodes([hit]);
      else if (!e.shiftKey) ctx.store.clearSelection();
      return;
    }

    if (handle.kind === "move") {
      const hit = hitAt(ctx, world.x, world.y);
      if (hit && !ctx.store.selection.nodes.includes(hit) && !e.shiftKey) {
        ctx.store.selectNodes([hit]);
        this.begin(ctx, { kind: "move" }, world);
        return;
      }
    }

    this.begin(ctx, handle, world);
  }

  private begin(ctx: ToolContext, handle: HandleId, world: Point): void {
    const g = ctx.gizmo();
    const pose = ctx.pose();
    if (!g || !pose) return;

    this.gizmo = g;
    this.active = handle;
    this.moved = false;
    this.startWorld = world;
    this.totalTheta = 0;
    this.lastTheta = 0;
    this.startPivotWorld = { ...g.pivot };

    const sym = ctx.store.currentSymbol;
    const locked = new Set(sym.layers.filter((l) => l.locked).map((l) => l.nodeId));
    this.snaps = [];
    const ids = topmostSelected(
      ctx.store.selection.nodes.filter((id) => !locked.has(id)),
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
    if (this.snaps.length === 0) { this.active = null; return; }

    if (g.single) this.startBox = { ...g.single.box };

    // Anchor: the point that must stay put for the duration of the drag.
    const pts = handlePoints(g);
    switch (handle.kind) {
      case "scale":     this.anchorWorld = pts.corners[oppositeCorner(handle.corner)]; break;
      case "scaleEdge": this.anchorWorld = pts.edges[oppositeEdge(handle.edge)]; break;
      case "rotate":    this.anchorWorld = { ...g.pivot }; break;
      default:          this.anchorWorld = { ...g.pivot }; break;
    }

    this.startAngle = Math.atan2(world.y - this.anchorWorld.y, world.x - this.anchorWorld.x)
                      * 180 / Math.PI;

    if (handle.kind === "move") ctx.beginSnap(this.snaps.map((s) => s.id));
    ctx.store.history.beginInteraction(handle.kind === "pivot" ? "node.pivot" : "node.transform");
  }

  onPointerMove(e: PointerEvent, ctx: ToolContext): void {
    if (!this.active || !this.gizmo) return;
    const world = ctx.toWorld(e);
    const g = this.gizmo;
    const next = new Map<NodeId, Transform>();

    switch (this.active.kind) {
      case "move": {
        let dx = world.x - this.startWorld.x;
        let dy = world.y - this.startWorld.y;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        // Same rule as the Selection tool: ⌘/Ctrl suspends the snap.
        const snapped = ctx.snapDelta(dx, dy, e.metaKey || e.ctrlKey);
        dx = snapped.dx; dy = snapped.dy;
        for (const s of this.snaps) next.set(s.id, moveBy(s, dx, dy));
        break;
      }

      case "rotate": {
        const angle = Math.atan2(world.y - this.anchorWorld.y, world.x - this.anchorWorld.x)
                      * 180 / Math.PI;
        // Accumulate with unwrapping so a multi-turn drag really exceeds 360.
        const step = shortestDelta(this.lastTheta + this.startAngle, angle);
        this.totalTheta += step;
        this.lastTheta = this.totalTheta;
        let theta = this.totalTheta;
        if (e.shiftKey) theta = Math.round(theta / 15) * 15;
        for (const s of this.snaps) next.set(s.id, rotateAbout(s, this.anchorWorld, theta));
        break;
      }

      case "scale":
      case "scaleEdge": {
        const uniform = e.shiftKey;
        const fromCenter = e.altKey;

        if (g.single && this.snaps.length === 1) {
          const handle = this.active.kind === "scale"
            ? cornerFraction(this.active.corner)
            : edgeFraction(this.active.edge);
          const anchor = this.active.kind === "scale"
            ? cornerFraction(oppositeCorner(this.active.corner))
            : edgeFraction(oppositeEdge(this.active.edge));
          const s = this.snaps[0]!;
          next.set(s.id, scaleLocal({
            snap: s, box: this.startBox, anchor, handle,
            pointer: world, uniform, fromCenter,
          }));
        } else {
          const anchor = fromCenter ? this.startPivotWorld : this.anchorWorld;
          const spanX = this.startWorld.x - anchor.x;
          const spanY = this.startWorld.y - anchor.y;
          let sx = Math.abs(spanX) > 1e-6 ? (world.x - anchor.x) / spanX : 1;
          let sy = Math.abs(spanY) > 1e-6 ? (world.y - anchor.y) / spanY : 1;
          const edge = this.active.kind === "scaleEdge" ? this.active.edge : null;
          const dragsX = edge !== "n" && edge !== "s";
          const dragsY = edge !== "e" && edge !== "w";
          if (!dragsX) sx = 1;
          if (!dragsY) sy = 1;
          if (uniform) {
            const k = uniformFactor(sx, sy, dragsX, dragsY);
            if (dragsX) sx = Math.sign(sx || 1) * k;
            if (dragsY) sy = Math.sign(sy || 1) * k;
          }
          const m = matOf(sx, 0, 0, sy, anchor.x * (1 - sx), anchor.y * (1 - sy));
          for (const s of this.snaps) next.set(s.id, applyWorldMatrix(s, m));
        }
        break;
      }

      case "skew": {
        if (!g.single || this.snaps.length !== 1) break;
        const s = this.snaps[0]!;
        next.set(s.id, skewLocal(s, this.startBox, this.active.edge, world, this.startWorld));
        break;
      }

      case "pivot":
        this.moved = true;
        this.movePivot(ctx, world);
        ctx.invalidate();
        return;
    }

    if (next.size > 0) {
      this.moved = true;
      applyEdit(ctx.store, next, true);
      ctx.invalidate();
    }
  }

  /**
   * Dragging the transform point moves the bone origin AND compensates the
   * pivot, so rotation happens about exactly the point the user set while the
   * artwork itself stays put.
   */
  private movePivot(ctx: ToolContext, world: Point): void {
    const g = this.gizmo;
    if (!g?.single || this.snaps.length !== 1) return;
    const s = this.snaps[0]!;

    const px = pointerToImagePx(s, world);
    if (!px) return;

    // Snap to whole pixels; the numeric fields still accept any value.
    const target = { x: Math.round(px.x), y: Math.round(px.y) };
    ctx.store.apply(new SetPivot(
      ctx.store.currentSymbolId, new Map([[s.id, target]]), { displays: new Map([[s.id, s.display]]) },
    ));
  }

  onPointerUp(_e: PointerEvent, ctx: ToolContext): void {
    ctx.endSnap();
    if (!this.active) return;
    // A click that moved nothing is not an edit: writing the pose back keyed
    // the playhead mid-tween and left an undo step for nothing.
    if (!this.moved) { this.onCancel(ctx); return; }
    if (this.active.kind !== "pivot") {
      const next = new Map<NodeId, Transform>();
      for (const s of this.snaps) {
        const n = ctx.store.node(s.id);
        if (n) next.set(s.id, quantize(transformAtFrame(ctx.store, n)));
      }
      if (next.size) applyEdit(ctx.store, next, true);
    }
    ctx.store.history.endInteraction();
    this.active = null;
    this.snaps = [];
    this.gizmo = null;
    ctx.invalidate();
  }

  onCancel(ctx: ToolContext): void {
    ctx.endSnap();
    if (this.active) ctx.store.history.abortInteraction();
    this.active = null;
    this.snaps = [];
    this.gizmo = null;
    ctx.invalidate();
  }

  onHover(e: PointerEvent, ctx: ToolContext): void {
    const g = ctx.gizmo();
    if (!g) { ctx.setCursor(""); return; }
    const c = ctx.toContent(e);
    const handle = hitGizmo(g, c.x, c.y, {
      toScreen: (p) => ctx.toScreen(p),
      handleRadius: ctx.store.prefs.value.gizmos.handleSize,
    });
    ctx.setCursor(cursorFor(handle, g));
  }
}

