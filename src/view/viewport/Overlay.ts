import type { Camera } from "./Camera";
import { uiFont, type UiFontSize } from "@/core/prefs/fonts";
import type { Pose } from "@/core/doc/pose";
import {
    EMPTY_SYMBOL_SIZE,
    entryBox,
    type FrameContext,
    isEmptySymbolInstance,
    localBox,
    SETUP_CONTEXT,
} from "@/core/doc/pose";
import type { Layer, Project, SymbolItem } from "@/core/doc/types";
import type { NodeId } from "@/core/doc/ids";
import { ikChain, ikRoles } from "@/core/doc/ikGraph";
import { mat, type Matrix2D, mul } from "@/core/math/Matrix2D";
import { type Point, type Rect, transformCorners } from "@/core/math/geom";
import { type Gizmo, handlePoints } from "@/view/tools/gizmo";
import { AXIS_LENGTH, axisTips, drivenBox, positionAxisTips, SCENE_FRAME, showsPositionAxes, } from "./nodeFrame";
import { DEFAULT_COLORS, type OverlayColors } from "./overlayColors";
import type { SnapLine } from "@/core/math/snap";

export { localBox };

export const RULER = 18;

/** Shortest the local axes are ever drawn, in screen pixels. */
const MIN_AXIS_PX = 16;

/** How long the parent-frame axes are drawn against the node's own. */
const GHOST_AXIS_RATIO = 0.7;



export interface Guide { axis: "x" | "y"; at: number; }

export interface OverlayOptions {
  showRulers: boolean;
  showGrid: boolean;
  showGuides: boolean;
  showBones: boolean;
  /** The reference marks on a selected node — never the selection box itself,
   *  which is what says something IS selected. */
  showGizmos: boolean;
  /** Setup pose mode: the stage edge says so, loudly enough to notice. */
  setupMode: boolean;
  gridSize: number;
  /** Cells between two major grid lines. */
  gridSubdivisions: number;
  /** Radius of the Free Transform handles, in screen pixels. */
  handleSize: number;
  /** The palette; the Preferences dialog hands in a different one. */
  colors: OverlayColors;
  /** Interface ▸ Text. A canvas inherits nothing, so the labels on the stage
   *  need the scale handed to them or they stay 9px while the app grows. */
  fontSize: UiFontSize;
  /** Smart guides for the snap the current drag is holding. */
  snapLines: SnapLine[];
  selection: Set<NodeId>;
  guides: Guide[];
  /** Guide currently being dragged out of a ruler. */
  draftGuide: Guide | null;
  marquee: Rect | null;
  /** Bone being dragged out with the Bone tool, in world space. */
  draftBone: { ax: number; ay: number; bx: number; by: number } | null;
  gizmo: Gizmo | null;
  /** Edit Multiple Frames: the box around every instance of the selection
   *  between the markers, in world space — the virtual group being edited. */
  groupBox?: Rect | null;

  /** Playhead and mode, so boxes match what the renderer drew. */
  when: FrameContext;
}


/** Everything drawn on top of the artwork: chrome, guides and handles. */
export class Overlay {
  /** The palette in force for the draw in progress. Set from the options at
   *  the top of `draw`, so every helper below paints the same one. */
  private C: OverlayColors = DEFAULT_COLORS;
  /** The text scale for the draw in progress, alongside `C`. */
  private F: UiFontSize = "small";

  draw(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    project: Project,
    symbol: SymbolItem,
    pose: Pose,
    opts: OverlayOptions,
  ): void {
    this.C = opts.colors;
    this.F = opts.fontSize;
    const ox = opts.showRulers ? RULER : 0;
    const oy = opts.showRulers ? RULER : 0;

    ctx.save();
    ctx.translate(ox, oy);
    ctx.beginPath();
    ctx.rect(0, 0, camera.width, camera.height);
    ctx.clip();

    if (opts.showGrid) this.drawGrid(ctx, camera, opts.gridSize, opts.gridSubdivisions);
    this.drawStageOutline(ctx, camera, project, opts.setupMode);
    if (opts.showGuides) this.drawGuides(ctx, camera, opts.guides, opts.draftGuide);
    this.drawEmptySymbols(ctx, camera, project, pose);
    if (opts.showBones) this.drawBones(ctx, camera, symbol, pose, opts);
    this.drawSelection(
      ctx, camera, project, symbol, pose, opts.selection, !!opts.gizmo, opts.when,
      opts.showGizmos,
    );
    if (opts.groupBox && !opts.gizmo) this.drawGroupBox(ctx, camera, opts.groupBox);
    if (opts.gizmo) this.drawGizmo(ctx, camera, opts.gizmo, opts.handleSize);
    if (opts.marquee) this.drawMarquee(ctx, opts.marquee);
    if (opts.snapLines.length) this.drawSnapLines(ctx, camera, opts.snapLines);

    ctx.restore();

    if (opts.showRulers) this.drawRulers(ctx, camera, opts);
  }

  // ── Grid & stage ───────────────────────────────────────────────────────

  private drawGrid(
    ctx: CanvasRenderingContext2D, cam: Camera, size: number, subdivisions = 5,
  ): void {
    const step = size * cam.zoom;
    if (step < 4) return;                        // unreadable; skip entirely
    const major = step * Math.max(1, subdivisions);

    const startX = ((cam.panX % step) + step) % step;
    const startY = ((cam.panY % step) + step) % step;

    ctx.lineWidth = 1;
    ctx.strokeStyle = this.C.grid;
    ctx.beginPath();
    for (let x = startX; x < cam.width; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, cam.height);
    }
    for (let y = startY; y < cam.height; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(cam.width, Math.round(y) + 0.5);
    }
    ctx.stroke();

    if (major >= 12) {
      const mx = ((cam.panX % major) + major) % major;
      const my = ((cam.panY % major) + major) % major;
      ctx.strokeStyle = this.C.gridMajor;
      ctx.beginPath();
      for (let x = mx; x < cam.width; x += major) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, cam.height);
      }
      for (let y = my; y < cam.height; y += major) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(cam.width, Math.round(y) + 0.5);
      }
      ctx.stroke();
    }
  }

  /**
   * The stage belongs to the SCENE, so it is drawn through the camera's scene
   * mapping — never through the symbol being edited, whose space may be
   * scaled or rotated relative to it.
   */
  private drawStageOutline(
    ctx: CanvasRenderingContext2D, cam: Camera, project: Project,
    setupMode = false,
  ): void {
    const tl = cam.sceneToScreen(0, 0);
    const br = cam.sceneToScreen(project.stage.width, project.stage.height);
    const x = Math.round(tl.x) + 0.5;
    const y = Math.round(tl.y) + 0.5;
    const w = Math.round(br.x - tl.x);
    const h = Math.round(br.y - tl.y);

    ctx.strokeStyle = this.C.stageEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);

    if (!setupMode) return;

    // In Setup mode a drag edits the rest pose and the playhead is ignored,
    // which looks like nothing happening if you thought you were animating.
    // Hence a border you cannot miss, and a tag naming the mode.
    ctx.save();
    ctx.strokeStyle = this.C.setup;
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);

    const label = "SETUP POSE";
    ctx.font = uiFont(10, this.F, 600);
    ctx.textBaseline = "middle";
    const pad = 5;
    const tw = ctx.measureText(label).width;
    const th = 15;
    // Above the stage, or tucked just inside it when the top is off screen.
    const ty = y - th - 3 < 0 ? y + 3 : y - th - 3;
    ctx.fillStyle = this.C.setup;
    ctx.fillRect(x - 1, ty, tw + pad * 2, th);
    ctx.fillStyle = "#123";
    ctx.fillText(label, x - 1 + pad, ty + th / 2 + 0.5);
    ctx.restore();
  }

  // ── Guides ─────────────────────────────────────────────────────────────

  private drawGuides(
    ctx: CanvasRenderingContext2D, cam: Camera, guides: Guide[], draft: Guide | null,
  ): void {
    ctx.lineWidth = 1;
    const paint = (g: Guide, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = this.C.guide;
      ctx.beginPath();
      if (g.axis === "x") {
        const x = Math.round(cam.sceneToScreen(g.at, 0).x) + 0.5;
        ctx.moveTo(x, 0); ctx.lineTo(x, cam.height);
      } else {
        const y = Math.round(cam.sceneToScreen(0, g.at).y) + 0.5;
        ctx.moveTo(0, y); ctx.lineTo(cam.width, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    for (const g of guides) paint(g, 0.85);
    if (draft) paint(draft, 0.55);
  }

  /**
   * The lines a drag is currently snapped to. Drawn like guides but in the
   * snap colour and only while the pointer is down: they answer "why did it
   * stop there", which is the whole difference between snapping that feels
   * helpful and snapping that feels broken.
   */
  private drawSnapLines(
    ctx: CanvasRenderingContext2D, cam: Camera, lines: SnapLine[],
  ): void {
    ctx.save();
    ctx.strokeStyle = this.C.snapLine;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (const l of lines) {
      if (l.axis === "x") {
        const x = Math.round(cam.sceneToScreen(l.at, 0).x) + 0.5;
        ctx.moveTo(x, 0); ctx.lineTo(x, cam.height);
      } else {
        const y = Math.round(cam.sceneToScreen(0, l.at).y) + 0.5;
        ctx.moveTo(0, y); ctx.lineTo(cam.width, y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  // ── Rulers ─────────────────────────────────────────────────────────────

  private drawRulers(ctx: CanvasRenderingContext2D, cam: Camera, opts: OverlayOptions): void {
    const W = cam.width + RULER;
    const H = cam.height + RULER;

    ctx.fillStyle = this.C.ruler;
    ctx.fillRect(0, 0, W, RULER);
    ctx.fillRect(0, 0, RULER, H);

    ctx.strokeStyle = this.C.rulerLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER - 0.5); ctx.lineTo(W, RULER - 0.5);
    ctx.moveTo(RULER - 0.5, 0); ctx.lineTo(RULER - 0.5, H);
    ctx.stroke();

    const step = niceStep(cam.zoom);
    ctx.font = uiFont(9, this.F);
    ctx.fillStyle = this.C.rulerText;
    ctx.strokeStyle = this.C.rulerTick;
    ctx.textBaseline = "alphabetic";

    // Three tick lengths — labelled, half, tenth — the way a real ruler is
    // divided. The minor divisions are dropped as soon as they crowd: below
    // ~4px apart they read as a grey band rather than as marks.
    const minor = step / 10;
    const half = step / 2;
    const showMinor = minor * cam.zoom >= 4;
    const showHalf = half * cam.zoom >= 5;

    // Rulers and guides measure the SCENE, like the stage rect, so they stay
    // put while a symbol is being edited in place.
    const w0 = cam.screenToScene(0, 0).x;
    const w1 = cam.screenToScene(cam.width, 0).x;
    const h0 = cam.screenToScene(0, 0).y;
    const h1 = cam.screenToScene(0, cam.height).y;

    // Minor and half ticks first, in one dimmer pass.
    if (showMinor || showHalf) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      const sub = showMinor ? minor : half;
      for (let v = Math.ceil(w0 / sub) * sub; v <= w1; v += sub) {
        if (nearMultiple(v, step)) continue;                 // the labelled one
        const long = showMinor && showHalf && nearMultiple(v, half);
        const x = Math.round(cam.sceneToScreen(v, 0).x) + RULER + 0.5;
        ctx.moveTo(x, RULER - (long ? 5 : 3)); ctx.lineTo(x, RULER - 1);
      }
      for (let v = Math.ceil(h0 / sub) * sub; v <= h1; v += sub) {
        if (nearMultiple(v, step)) continue;
        const long = showMinor && showHalf && nearMultiple(v, half);
        const y = Math.round(cam.sceneToScreen(0, v).y) + RULER + 0.5;
        ctx.moveTo(RULER - (long ? 5 : 3), y); ctx.lineTo(RULER - 1, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Horizontal labels.
    ctx.beginPath();
    for (let v = Math.ceil(w0 / step) * step; v <= w1; v += step) {
      const x = Math.round(cam.sceneToScreen(v, 0).x) + RULER + 0.5;
      ctx.moveTo(x, 1); ctx.lineTo(x, RULER - 1);
      ctx.fillText(String(Math.round(v)), x + 2, 9);
    }
    // Vertical
    for (let v = Math.ceil(h0 / step) * step; v <= h1; v += step) {
      const y = Math.round(cam.sceneToScreen(0, v).y) + RULER + 0.5;
      ctx.moveTo(1, y); ctx.lineTo(RULER - 1, y);
      ctx.save();
      ctx.translate(9, y - 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(String(Math.round(v)), 0, 0);
      ctx.restore();
    }
    ctx.stroke();

    // Corner box
    ctx.fillStyle = this.C.ruler;
    ctx.fillRect(0, 0, RULER - 1, RULER - 1);
    void opts;
  }

  // ── Selection ──────────────────────────────────────────────────────────

  private drawGroupBox(ctx: CanvasRenderingContext2D, cam: Camera, r: Rect): void {
    const corners = [
      cam.toScreen(r.x, r.y), cam.toScreen(r.x + r.w, r.y),
      cam.toScreen(r.x + r.w, r.y + r.h), cam.toScreen(r.x, r.y + r.h),
    ];
    ctx.save();
    ctx.strokeStyle = this.C.select;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  private drawSelection(
    ctx: CanvasRenderingContext2D, cam: Camera, project: Project,
    symbol: SymbolItem, pose: Pose, selection: Set<NodeId>, hasGizmo = false,
    when: FrameContext = SETUP_CONTEXT, showGizmos = true,
  ): void {
    if (selection.size === 0) return;
    const view = cam.matrix;

    for (const id of selection) {
      const e = pose.byNode.get(id);
      // Marks are drawn only for what is on the stage at this frame: a group,
      // an empty layer, or a layer outside its own span has nothing there, and
      // marks for one read as an object — an empty layer put axes and a ring on
      // the stage's top-left corner, and a track starting at frame 7 did the
      // same on frames 1..6.
      if (!e || !e.visible || e.node.kind === "group" || e.node.kind === "empty") continue;
      const box = entryBox(project, e, when);
      // A bone draws nothing, so there is no box to wrap — and until this
      // branch existed, selecting one put NOTHING on the stage even while its
      // timeline was driving half the rig.
      if (!box) {
        // With the gizmos off a bone goes back to drawing nothing at all,
        // which is the point of the switch: there is no artwork under it.
        if (showGizmos) {
          this.drawNodeFrame(ctx, cam, project, pose, e.nodeId, e.world, hasGizmo, when);
        }
        continue;
      }

      const m = {
        a: view.a * e.world.a + view.c * e.world.b,
        b: view.b * e.world.a + view.d * e.world.b,
        c: view.a * e.world.c + view.c * e.world.d,
        d: view.b * e.world.c + view.d * e.world.d,
        tx: view.a * e.world.tx + view.c * e.world.ty + view.tx,
        ty: view.b * e.world.tx + view.d * e.world.ty + view.ty,
      };
      const [tl, tr, br, bl] = transformCorners(m, box);

      ctx.strokeStyle = this.C.select;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y);
      ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y);
      ctx.closePath();
      ctx.stroke();

      // Artwork gets the parent-frame axes as well: its box already shows the
      // node's OWN frame (the box edges are its axes), but nothing showed the
      // frame its X and Y are measured in, and an image hanging off a rotated
      // bone moves sideways on a y edit exactly as a bone does.
      if (showGizmos) this.drawPositionAxes(ctx, cam, pose, e.nodeId, e.world);

      // The gizmo draws its own transform point; avoid doubling it up.
      if (!hasGizmo) {
        ctx.beginPath();
        ctx.arc(m.tx, m.ty, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = this.C.pivot;
        ctx.fill();
        ctx.strokeStyle = this.C.boneCore;
        ctx.stroke();
      }
    }
    void symbol;
  }

  /**
   * The frame of a node that carries no artwork of its own.
   *
   * Three marks, and each one answers a question the empty stage did not:
   *
   *  - the ORIGIN ring is the point the node's rotation happens about, and the
   *    point its x/y keyframes move;
   *  - the AXES are the node's own basis, so they turn with a rotation
   *    keyframe and stretch with a scale one — a bone that only rotates is
   *    otherwise indistinguishable from one that does nothing;
   *  - the dashed box is `drivenBox`: every piece of artwork descending from
   *    this node, in this node's frame. Selecting `hips` outlines the whole
   *    figure, `chest` the upper body — which is the reference that was
   *    missing when a bone's timeline moved things with nothing on the stage
   *    tying the two together.
   */
  private drawNodeFrame(
    ctx: CanvasRenderingContext2D, cam: Camera, project: Project, pose: Pose,
    nodeId: NodeId, world: Matrix2D, hasGizmo: boolean, when: FrameContext,
  ): void {
    const box = drivenBox(project, pose, nodeId, when);
    if (box) {
      const [tl, tr, br, bl] = transformCorners(mul(mat(), cam.matrix, world), box);
      ctx.save();
      ctx.strokeStyle = this.C.driven;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y);
      ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }

    const o = cam.toScreen(world.tx, world.ty);
    const tips = axisTips(world);
    const px = cam.toScreen(tips.x.x, tips.x.y);
    const py = cam.toScreen(tips.y.x, tips.y.y);
    let vx = { x: px.x - o.x, y: px.y - o.y };
    let vy = { x: py.x - o.x, y: py.y - o.y };

    // A node scaled right down would otherwise draw axes a few pixels long.
    // Both are scaled by the SAME factor, so their relative lengths — the
    // node's own anisotropy and shear — survive the clamp.
    const longest = Math.max(Math.hypot(vx.x, vx.y), Math.hypot(vy.x, vy.y));
    const clamp = longest > 0 && longest < MIN_AXIS_PX ? MIN_AXIS_PX / longest : 1;
    if (clamp !== 1) {
      vx = { x: vx.x * clamp, y: vx.y * clamp };
      vy = { x: vy.x * clamp, y: vy.y * clamp };
    }

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = this.C.axisY;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(o.x + vy.x, o.y + vy.y);
    ctx.stroke();

    ctx.strokeStyle = this.C.axisX;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(o.x + vx.x, o.y + vx.y);
    ctx.stroke();

    // Arrowhead on +x only: it is the direction a bone points, and the axis
    // that tells you at a glance which way the node is facing.
    const len = Math.hypot(vx.x, vx.y);
    if (len > 6) {
      const ux = vx.x / len, uy = vx.y / len;
      const tipX = o.x + vx.x, tipY = o.y + vx.y;
      ctx.fillStyle = this.C.axisX;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - ux * 7 - uy * 3.5, tipY - uy * 7 + ux * 3.5);
      ctx.lineTo(tipX - ux * 7 + uy * 3.5, tipY - uy * 7 - ux * 3.5);
      ctx.closePath();
      ctx.fill();
    }

    this.drawPositionAxes(ctx, cam, pose, nodeId, world);

    // The gizmo draws its own transform point; avoid doubling it up.
    if (!hasGizmo) {
      ctx.beginPath();
      ctx.arc(o.x, o.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = this.C.pivot;
      ctx.fill();
      ctx.strokeStyle = this.C.boneCore;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The axes of the space the node's X and Y are measured in, dashed.
   *
   * `world = parentWorld · local`, and the Properties panel's X and Y are that
   * `local` translation — so a node travels along its PARENT's axes, which on
   * a bone chain are rarely the screen's. `head` under a chest that points up
   * is the case that starts the head-scratching: y + 10 moves it 10px to the
   * RIGHT, and until these dashes existed nothing on the stage said why.
   *
   * Drawn a little shorter than the node's own axes, because the two frames
   * frequently share a direction exactly and equal-length lines would hide
   * each other. Skipped entirely when there is nothing to warn about —
   * see `showsPositionAxes`.
   */
  private drawPositionAxes(
    ctx: CanvasRenderingContext2D, cam: Camera, pose: Pose,
    nodeId: NodeId, world: Matrix2D,
  ): void {
    const parentId = pose.byNode.get(nodeId)?.node.parentId;
    const parentWorld = (parentId ? pose.byNode.get(parentId)?.world : null) ?? SCENE_FRAME;
    if (!showsPositionAxes(world, parentWorld)) return;

    const o = cam.toScreen(world.tx, world.ty);
    const tips = positionAxisTips(world, parentWorld, AXIS_LENGTH);
    const ends = (["x", "y"] as const).map((axis) => {
      const p = cam.toScreen(tips[axis].x, tips[axis].y);
      return { x: p.x - o.x, y: p.y - o.y };
    });
    const longest = Math.max(...ends.map((v) => Math.hypot(v.x, v.y)));
    if (longest <= 0) return;
    const k = (longest < MIN_AXIS_PX ? MIN_AXIS_PX / longest : 1) * GHOST_AXIS_RATIO;

    ctx.save();
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([4, 3]);
    ends.forEach((v, i) => {
      ctx.strokeStyle = i === 0 ? this.C.axisX : this.C.axisY;
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.lineTo(o.x + v.x * k, o.y + v.y * k);
      ctx.stroke();
    });
    ctx.restore();
  }

  /** The Free Transform box: eight handles plus the transform point. */
  private drawGizmo(
    ctx: CanvasRenderingContext2D, cam: Camera, g: Gizmo, handleSize = 3.5,
  ): void {
    const S = (p: Point) => cam.toScreen(p.x, p.y);
    const [tl, tr, br, bl] = g.corners.map(S) as [Point, Point, Point, Point];

    ctx.save();
    ctx.strokeStyle = this.C.select;
    ctx.lineWidth = 1;
    ctx.setLineDash(g.axisAligned ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    const { corners, edges } = handlePoints(g);
    // Drawn at the size the hit test uses, so a handle the pointer catches is
    // exactly the handle the user can see.
    const r = Math.max(2, handleSize - 2);
    const handle = (p: Point) => {
      const q = S(p);
      ctx.fillStyle = "#f2f2f2";
      ctx.strokeStyle = "#1e1e1e";
      ctx.lineWidth = 1;
      ctx.fillRect(Math.round(q.x) - r, Math.round(q.y) - r, r * 2, r * 2);
      ctx.strokeRect(Math.round(q.x) - r + 0.5, Math.round(q.y) - r + 0.5, r * 2 - 1, r * 2 - 1);
    };
    for (const c of ["nw", "ne", "se", "sw"] as const) handle(corners[c]);
    for (const e of ["n", "e", "s", "w"] as const) handle(edges[e]);

    // Transform point: a white ring with a dark core, as in Flash.
    const p = S(g.pivot);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#1e1e1e";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = "#1e1e1e";
    ctx.fill();
    ctx.restore();
  }

  private drawMarquee(ctx: CanvasRenderingContext2D, r: Rect): void {
    ctx.fillStyle = this.C.marquee;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = this.C.marqueeEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
  }

  /**
   * A marker for symbol instances with nothing in them yet, so an empty
   * symbol dropped on the stage is visible and obviously clickable rather
   * than a blank patch that appears to have done nothing.
   */
  private drawEmptySymbols(
    ctx: CanvasRenderingContext2D, cam: Camera, project: Project, pose: Pose,
  ): void {
    for (const e of pose.entries) {
      if (!e.visible || !e.display || !isEmptySymbolInstance(project, e.display)) continue;
      const half = EMPTY_SYMBOL_SIZE / 2;
      // World -> screen INCLUDING the edit base, or the marker would ignore
      // the transform of the instance the symbol is being edited inside.
      const screen = mul(mat(), cam.matrix, e.world);
      const [tl, tr, br, bl] = transformCorners(
        screen,
        { x: -half - e.display.pivot.x, y: -half - e.display.pivot.y,
          w: EMPTY_SYMBOL_SIZE, h: EMPTY_SYMBOL_SIZE },
      );

      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = this.C.emptySymbol;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y);
      ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      // A crosshair on the registration point, so it reads as an anchor.
      const cx = (tl.x + br.x) / 2, cy = (tl.y + br.y) / 2;
      ctx.beginPath();
      ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy);
      ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6);
      ctx.stroke();

      const label = project.items[e.display.itemId]?.name ?? "symbol";
      ctx.font = uiFont(9, this.F);
      ctx.fillStyle = this.C.emptySymbol;
      ctx.textAlign = "center";
      ctx.fillText(`${label} (empty)`, cx, Math.max(tl.y, bl.y) + 12);
      ctx.textAlign = "start";
      ctx.restore();
    }
  }

  // ── Bones ──────────────────────────────────────────────────────────────

  private drawBones(
    ctx: CanvasRenderingContext2D, cam: Camera,
    symbol: SymbolItem, pose: Pose, opts: OverlayOptions,
  ): void {
    // Constraints colour the chain: you can see at a glance which bones the
    // runtime will solve and which one you are meant to drag.
    const { targets, driven } = ikRoles(symbol);

    for (const e of pose.entries) {
      if (e.node.kind !== "bone") continue;
      const len = e.node.boneLength ?? 40;
      const a = cam.toScreen(e.world.tx, e.world.ty);
      const b = cam.toScreen(e.world.a * len + e.world.tx, e.world.b * len + e.world.ty);
      const selected = opts.selection.has(e.nodeId);
      const isTarget = targets.has(e.nodeId);

      if (isTarget) {
        this.drawIkTarget(ctx, a, selected);
        continue;
      }

      const dx = b.x - a.x, dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l, ny = dx / l;
      const w = Math.min(5, Math.max(2.5, l * 0.12));

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(a.x + dx * 0.22 + nx * w, a.y + dy * 0.22 + ny * w);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(a.x + dx * 0.22 - nx * w, a.y + dy * 0.22 - ny * w);
      ctx.closePath();
      ctx.fillStyle = driven.has(e.nodeId) ? this.C.boneIk : this.C.bone;
      ctx.fill();
      ctx.strokeStyle = selected ? this.C.boneSelected : this.C.boneCore;
      ctx.lineWidth = selected ? 1.6 : 1;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(a.x, a.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = this.C.boneCore;
      ctx.fill();
    }

    // A line from each effector's tip to its target, so a constraint is
    // visible even when the target has been dragged far away. The one the
    // SELECTION takes part in is drawn solid and named: a rig with four
    // chains is four identical dashes otherwise, and which bones a given
    // target moves is exactly what the layer tree cannot show — the target
    // hangs outside the chain it drives.
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = uiFont(9, this.F);
    ctx.textAlign = "center";
    for (const k of symbol.ik) {
      const bone = pose.byNode.get(k.boneId);
      const target = pose.byNode.get(k.targetId);
      if (!bone || !target) continue;
      const active = ikChain(symbol, k).some((id) => opts.selection.has(id))
        || opts.selection.has(k.targetId);
      const len = bone.node.boneLength ?? 40;
      const tip = cam.toScreen(
        bone.world.a * len + bone.world.tx,
        bone.world.b * len + bone.world.ty,
      );
      const t = cam.toScreen(target.world.tx, target.world.ty);
      ctx.setLineDash(active ? [] : [4, 4]);
      ctx.strokeStyle = active ? this.C.ikLinkActive : this.C.ikLink;
      ctx.lineWidth = active ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
      if (active) {
        ctx.fillStyle = this.C.ikLinkActive;
        ctx.fillText(k.name, (tip.x + t.x) / 2, (tip.y + t.y) / 2 - 4);
      }
    }
    ctx.textAlign = "start";
    ctx.restore();

    if (opts.draftBone) {
      const a = cam.toScreen(opts.draftBone.ax, opts.draftBone.ay);
      const b = cam.toScreen(opts.draftBone.bx, opts.draftBone.by);
      ctx.save();
      ctx.setLineDash([5, 3]);
      ctx.strokeStyle = this.C.bone;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(a.x, a.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = this.C.bone;
      ctx.fill();
    }
  }

  /** An IK target: a ring, because it is a handle rather than a limb. */
  private drawIkTarget(
    ctx: CanvasRenderingContext2D, at: { x: number; y: number }, selected: boolean,
  ): void {
    ctx.beginPath();
    ctx.arc(at.x, at.y, 6, 0, Math.PI * 2);
    ctx.strokeStyle = this.C.ikTarget;
    ctx.lineWidth = selected ? 2.5 : 1.6;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(at.x - 9, at.y);
    ctx.lineTo(at.x + 9, at.y);
    ctx.moveTo(at.x, at.y - 9);
    ctx.lineTo(at.x, at.y + 9);
    ctx.strokeStyle = this.C.ikTarget;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** Is `v` on a multiple of `step`, allowing for the float error that walking
 *  a loop by a tenth of one accumulates? */
function nearMultiple(v: number, step: number): boolean {
  const r = Math.abs(v / step - Math.round(v / step));
  return r < 1e-6;
}

/** Ruler tick spacing that stays readable at any zoom. */
function niceStep(zoom: number): number {
  const target = 64 / zoom;                     // aim for a label every ~64px
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, target))));
  for (const m of [1, 2, 5, 10]) {
    if (pow * m >= target) return pow * m;
  }
  return pow * 10;
}

export type { Layer };
