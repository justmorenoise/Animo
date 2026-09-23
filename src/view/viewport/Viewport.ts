import { cls, h, on, raf } from "@/view/widgets/dom";
import { Camera } from "./Camera";
import { contentMatrixOf, SceneRenderer } from "./SceneRenderer";
import { type Guide, Overlay, RULER } from "./Overlay";
import type { Store } from "@/app/Store";
import type { AssetStore } from "@/app/AssetStore";
import { entryBox, evaluateSymbol, type FrameContext, type Pose } from "@/core/doc/pose";
import type { NodeId } from "@/core/doc/ids";
import { applyInverse, invert, mat, matOf, type Matrix2D, mul } from "@/core/math/Matrix2D";
import { polygonContains, type Rect, rectContains, transformCorners } from "@/core/math/geom";
import { isImage, isSymbol } from "@/core/doc/types";
import { ToolManager } from "@/view/tools/ToolManager";
import type { ToolContext } from "@/view/tools/Tool";
import { buildGizmo, type Gizmo, type PoseAt, selectionBounds } from "@/view/tools/gizmo";
import { onionFrames } from "@/core/doc/onion";
import { keyIndexAt } from "@/core/doc/timeline";
import { withDescendants } from "@/core/doc/layerTree";
import { GhostPainter } from "./ghost";
import { type OverlayColors, resolveColors } from "./overlayColors";
import { type SnapLine, snapMove, type SnapTargets, snapValue } from "@/core/math/snap";
import { collectSnapTargets, selectionRefs } from "./snapTargets";
import { promptNumber } from "@/view/widgets/promptNumber";
import { menuAnchor, showMenu } from "@/view/widgets/Dock";

/**
 * The stage: two stacked canvases (artwork, then chrome), a camera, and all
 * the navigation input. Tools plug in later; this owns the parts every tool
 * needs — coordinate conversion, hit testing, and the redraw loop.
 */
export class Viewport {
  readonly camera = new Camera();
  private sceneCanvas: HTMLCanvasElement;
  private overlayCanvas: HTMLCanvasElement;
  private sceneCtx: CanvasRenderingContext2D;
  private overlayCtx: CanvasRenderingContext2D;
  private renderer: SceneRenderer;
  private overlay = new Overlay();

  private dpr = 1;
  private lastPose: Pose | null = null;
  /** The other frames drawn under Edit Multiple Frames, with their poses. */
  private ghostPoses: Array<{ frame: number; pose: Pose }> = [];
  private ghosts = new GhostPainter();

  guides: Guide[] = [];
  private draftGuide: Guide | null = null;
  private marquee: Rect | null = null;
  private spaceDown = false;
  private tools = new ToolManager();
  private toolCtx: ToolContext;
  private lastGizmo: Gizmo | null = null;
  private draftBone: { ax: number; ay: number; bx: number; by: number } | null = null;
  /** Live coordinate readout while a guide is being placed or moved. */
  private guideTip: HTMLElement | null = null;
  /** Smart guides for the snap the drag in progress is holding. */
  private snapLines: SnapLine[] = [];
  /**
   * What the drag in progress snaps FROM and TO, captured when it started.
   *
   * A tool's delta is measured from the pointer-down position and applied to
   * the snapshot it took there, so the reference points have to come from
   * that same moment: taken from the live pose they would already include
   * the move, and every frame would add the correction again. The targets are
   * captured with them — nothing else moves during a drag, so this is also
   * one bounds walk per drag instead of one per pointer event.
   */
  private snapSession: {
    refs: { xs: number[]; ys: number[] };
    targets: SnapTargets;
  } | null = null;
  private colors: OverlayColors;

  readonly invalidate: () => void;

  constructor(
    private readonly host: HTMLElement,
    private readonly store: Store,
    assets: AssetStore,
  ) {
    this.renderer = new SceneRenderer(() => this.store.project, assets);
    this.colors = resolveColors(store.prefs.value);
    store.prefs.subscribe((p) => {
      this.colors = resolveColors(p);
      this.invalidate();
    });
    this.toolCtx = {
      store,
      assets,
      camera: this.camera,
      pose: () => this.lastPose,
      gizmo: () => this.lastGizmo,
      toWorld: (e) => this.toWorld(e),
      toContent: (e) => this.toContent(e),
      toScreen: (p) => this.camera.toScreen(p.x, p.y),
      hitTest: (wx, wy, exclude) => this.hitTest(wx, wy, assets, exclude),
      nodesInRect: (r, exclude) => this.nodesInRect(r, exclude),
      invalidate: () => this.invalidate(),
      setMarquee: (r) => { this.marquee = r; },
      setDraftBone: (segment) => { this.draftBone = segment; },
      beginSnap: (moving) => this.beginSnap(moving),
      snapDelta: (dx, dy, free) => this.snapDelta(dx, dy, free),
      endSnap: () => { this.snapSession = null; this.snapLines = []; },
      setCursor: (c) => { if (!this.spaceDown) this.host.style.cursor = c; },
    };

    this.sceneCanvas = h("canvas");
    this.overlayCanvas = h("canvas");
    host.appendChild(this.sceneCanvas);
    host.appendChild(this.overlayCanvas);

    this.sceneCtx = this.sceneCanvas.getContext("2d")!;
    this.overlayCtx = this.overlayCanvas.getContext("2d")!;

    this.invalidate = raf(() => this.render());

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.camera.centerOn(this.store.project.stage.width / 2, this.store.project.stage.height / 2);

    // Edit-in-place: keep the symbol's contents where they were on screen.
    // Descending into an instance only changes which space the camera is
    // looking through: the artwork keeps the exact position, size and
    // deformation it had, so there is no pan to compensate with.
    store.onEditContextChange = (base) => {
      this.camera.setBase(base);
      this.invalidate();
    };
    this.camera.setBase(store.editBase);

    this.wireInput();
    this.store.subscribe((topic) => {
      if (topic === "tool") this.tools.setActive(this.store.ui.tool, this.toolCtx);
      if (topic === "doc" || topic === "stage" || topic === "frame" ||
          topic === "selection" || topic === "ui" || topic === "library" || topic === "tool") {
        this.syncZoomFromStore();
        this.invalidate();
      }
    });
    this.invalidate();
  }

  // ── Sizing ─────────────────────────────────────────────────────────────

  private resize(): void {
    const r = this.host.getBoundingClientRect();
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    for (const c of [this.sceneCanvas, this.overlayCanvas]) {
      c.width = Math.max(1, Math.round(r.width * this.dpr));
      c.height = Math.max(1, Math.round(r.height * this.dpr));
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
    }
    const gutter = this.store.ui.showRulers ? RULER : 0;
    this.camera.width = Math.max(1, r.width - gutter);
    this.camera.height = Math.max(1, r.height - gutter);
    if (this.fitPending) this.fitToStage();
    this.invalidate();
  }

  private syncZoomFromStore(): void {
    if (Math.abs(this.camera.zoom - this.store.ui.zoom) > 1e-9) {
      this.camera.setZoom(this.store.ui.zoom);
    }
    const gutter = this.store.ui.showRulers ? RULER : 0;
    const r = this.host.getBoundingClientRect();
    this.camera.width = Math.max(1, r.width - gutter);
    this.camera.height = Math.max(1, r.height - gutter);
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  private render(): void {
    const { camera, store } = this;
    const gutter = store.ui.showRulers ? RULER : 0;
    const project = store.project;

    // Scene layer: pasteboard, stage, artwork.
    const sc = this.sceneCtx;
    sc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    sc.clearRect(0, 0, this.sceneCanvas.width, this.sceneCanvas.height);
    sc.save();
    sc.translate(gutter, gutter);
    sc.beginPath();
    sc.rect(0, 0, camera.width, camera.height);
    sc.clip();

    // The stage belongs to the SCENE, so while editing a symbol in place it
    // is drawn where the scene's origin actually falls, not at the symbol's
    // own (0,0) — which would put a white rectangle in the middle of nowhere
    // and make the contents look displaced.
    const tl = camera.sceneToScreen(0, 0);
    sc.fillStyle = project.stage.background;
    sc.fillRect(tl.x, tl.y, project.stage.width * camera.zoom, project.stage.height * camera.zoom);

    // World -> device pixels. drawEntry uses setTransform, so the DPR scale
    // and the ruler gutter have to be baked in here rather than left on the
    // context (where they would be wiped out).
    const view = mul(
      mat(),
      matOf(this.dpr, 0, 0, this.dpr, gutter * this.dpr, gutter * this.dpr),
      camera.matrix,
    );
    // Ancestors behind the symbol being edited, dimmed, so there is
    // something to align against. The instance we came in through is left
    // out, or it would draw on top of the contents in front of it.
    // Scene space -> device pixels: the camera without the edit base.
    const sceneView = mul(
      mat(),
      matOf(this.dpr, 0, 0, this.dpr, gutter * this.dpr, gutter * this.dpr),
      camera.sceneMatrix,
    );
    for (const ctx of store.editContext) {
      // Only levels entered through an instance on the stage: opening a
      // symbol from the library is meant to be an isolated environment.
      if (!ctx.ghost) continue;
      const ancestor = project.items[ctx.symbolId];
      if (!isSymbol(ancestor)) continue;
      const ancestorView = mul(mat(), sceneView, ctx.matrix);
      // At the pose the user descended out of, in the mode they are in — not
      // the bind pose at frame 0. A ghost drawn in Setup while the stage is in
      // Animate shows every keyed limb somewhere it is not, which is the whole
      // value of the reference gone.
      const anim = ancestor.animations.find((a) => a.id === ctx.animId)
        ?? ancestor.animations[0] ?? null;
      this.renderer.draw(
        sc, ancestor, anim, ctx.frame, store.ui.mode, ancestorView,
        { alpha: 0.3, hiddenLayers: ctx.hideNode ? new Set([ctx.hideNode]) : undefined },
      );
    }

    this.ghostPoses = [];
    this.drawOtherFrames(sc, view);

    this.lastPose = this.renderer.draw(
      sc, store.currentSymbol, store.currentAnimation, store.ui.frame, store.ui.mode, view,
    );
    sc.restore();

    // The transform box is rebuilt from the fresh pose every frame, so it
    // can never lag the artwork it is wrapped around.
    this.lastGizmo = this.tools.showsGizmo
      ? buildGizmo(project, this.editPoses(), store.selection.nodes)
      : null;

    // Overlay layer: chrome, guides, selection.
    const oc = this.overlayCtx;
    oc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    oc.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    this.overlay.draw(oc, camera, project, store.currentSymbol, this.lastPose, {
      showRulers: store.ui.showRulers,
      showGrid: store.ui.showGrid,
      showGuides: store.ui.showGuides,
      showBones: store.ui.showBones,
      showGizmos: store.ui.showGizmos,
      setupMode: store.ui.mode === "setup",
      gridSize: store.prefs.value.stage.gridSize,
      gridSubdivisions: store.prefs.value.stage.gridSubdivisions,
      handleSize: store.prefs.value.gizmos.handleSize,
      colors: this.colors,
      fontSize: store.prefs.value.interface.fontSize,
      snapLines: this.snapLines,
      selection: new Set(store.selection.nodes),

      when: this.frameContext,
      guides: this.guides,
      draftGuide: this.draftGuide,
      marquee: this.marquee,
      draftBone: this.draftBone,
      gizmo: this.lastGizmo,
      groupBox: this.ghostPoses.length && store.selection.nodes.length
        ? selectionBounds(project, this.editPoses(), store.selection.nodes) : null,
    });
  }

  /**
   * What the stage is currently showing: the playhead and the mode. Boxes and
   * hit tests are measured with it so they land on the artwork the renderer
   * drew, animated nested symbols included.
   */
  get frameContext(): FrameContext {
    return {
      animationName: this.store.currentAnimation?.name ?? null,
      frame: this.store.ui.frame,
      mode: this.store.ui.mode,
    };
  }

  /**
   * The frames around the playhead. Only in Animate — the setup pose has no
   * neighbours — and never while the runtime is driving the stage. Locked
   * layers are left out of both, as in Animate: locking is how a layer is
   * kept out of the onion skin.
   *
   * With Edit Multiple Frames on, every frame between the markers is drawn
   * opaque and its pose kept, because each of those instances is editable:
   * the hit test, the marquee and the transform box all look at them.
   * Otherwise the onion skin draws them faded and colour-coded.
   */
  private drawOtherFrames(sc: CanvasRenderingContext2D, view: Matrix2D): void {
    const { store } = this;
    const anim = store.currentAnimation;
    if (!anim || store.ui.mode !== "animate" || store.ui.playMode) return;
    if (!store.ui.onionSkin && !store.ui.editMultipleFrames) return;

    const sym = store.currentSymbol;
    const locked = new Set<string>(sym.layers.filter((l) => l.locked).map((l) => l.nodeId));
    const hiddenLayers = locked.size ? locked : undefined;
    const span = store.onionSpan;
    const frame = store.ui.frame;

    if (store.ui.editMultipleFrames) {
      for (let f = span.start; f <= span.end; f++) {
        if (f === frame) continue;
        const pose = this.renderer.draw(sc, sym, anim, f, "animate", view, { hiddenLayers });
        this.ghostPoses.push({ frame: f, pose });
      }
      return;
    }

    const o = store.prefs.value.timeline;
    const shown = sym.layers.filter((l) => l.visible && !l.locked).map((l) => anim.tracks[l.nodeId]);
    const isKey = o.onionKeyframesOnly
      ? (f: number) => shown.some((t) => !!t && keyIndexAt(t, f) >= 0)
      : undefined;
    for (const g of onionFrames({ frame, span, opacity: o.onionOpacity, falloff: o.onionFalloff, isKey })) {
      const tint = o.onionTint ? (g.side === "past" ? o.onionPastColor : o.onionFutureColor) : null;
      this.ghosts.paint(sc, this.dpr, { alpha: g.alpha, tint, outline: o.onionOutline }, (ctx) => {
        this.renderer.draw(ctx, sym, anim, g.frame, "animate", view, { hiddenLayers });
      });
    }
  }

  /**
   * Every pose on stage that can be picked and edited: the playhead's first,
   * then the other frames Edit Multiple Frames drew. The hit test, the
   * marquee and the transform box read the ones the last render drew.
   * `fresh` evaluates them now instead, for a reader that runs between an
   * edit and the next render — the Properties panel syncs on the store event
   * that schedules that render.
   */
  editPoses(fresh = false): PoseAt[] {
    const ctx = this.frameContext;
    if (fresh) {
      const store = this.store;
      const anim = store.currentAnimation;
      const sym = store.currentSymbol;
      const out: PoseAt[] = [{ pose: evaluateSymbol(sym, anim, ctx.frame, ctx.mode), when: ctx }];
      if (anim && store.ui.editMultipleFrames && ctx.mode === "animate" && !store.ui.playMode) {
        const span = store.onionSpan;
        for (let f = span.start; f <= span.end; f++) {
          if (f !== ctx.frame) out.push({ pose: evaluateSymbol(sym, anim, f, "animate"), when: { ...ctx, frame: f } });
        }
      }
      return out;
    }
    const out: PoseAt[] = [];
    if (this.lastPose) out.push({ pose: this.lastPose, when: ctx });
    for (const g of this.ghostPoses) out.push({ pose: g.pose, when: { ...ctx, frame: g.frame } });
    return out;
  }

  get pose(): Pose | null { return this.lastPose; }
  clearCaches(): void { this.renderer.clearCaches(); }

  // ── Coordinates ────────────────────────────────────────────────────────

  /** Mouse event -> content-area screen coordinates (rulers excluded). */
  private toContent(e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const r = this.host.getBoundingClientRect();
    const gutter = this.store.ui.showRulers ? RULER : 0;
    return { x: e.clientX - r.left - gutter, y: e.clientY - r.top - gutter };
  }

  toWorld(e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const c = this.toContent(e);
    return this.camera.toWorld(c.x, c.y);
  }

  // ── Hit testing ────────────────────────────────────────────────────────

  /**
   * Topmost node under a world point. Walks front-to-back (the reverse of
   * paint order) and probes alpha so transparent pixels do not swallow
   * clicks meant for the artwork behind them.
   */
  hitTest(wx: number, wy: number, assets: AssetStore, exclude?: Set<string>): NodeId | null {
    const project = this.store.project;
    for (const { pose, when } of this.editPoses()) {
      for (let i = pose.entries.length - 1; i >= 0; i--) {
        const e = pose.entries[i]!;
        if (!e.visible || e.node.kind === "bone") continue;
        if (exclude?.has(e.nodeId)) continue;
        const box = entryBox(project, e, when);
        if (!box || !e.display) continue;

        const local = { x: 0, y: 0 };
        if (!applyInverse(local, e.world, wx, wy)) continue;
        if (!rectContains(box, local.x, local.y)) continue;

        const item = project.items[e.display.itemId];
        if (isImage(item)) {
          const px = local.x + e.display.pivot.x;
          const py = local.y + e.display.pivot.y;
          if (assets.alphaAt(item.assetId, px, py) < 8) continue;
        }
        return e.nodeId;
      }
    }
    return null;
  }

  /** Nodes no pointer gesture may pick: hidden or locked layers. */
  private unpickable(): Set<string> {
    return new Set<string>(
      this.store.currentSymbol.layers
        .filter((l) => l.locked || !l.visible)
        .map((l) => l.nodeId as string),
    );
  }

  /** Every node whose transformed bounds intersect a screen-space marquee. */
  nodesInRect(screenRect: Rect, exclude?: Set<string>): NodeId[] {
    const project = this.store.project;
    const view = this.camera.matrix;
    const out = new Set<NodeId>();

    for (const { pose, when } of this.editPoses()) {
      for (const e of pose.entries) {
        if (!e.visible || e.node.kind === "bone" || out.has(e.nodeId)) continue;
        if (exclude?.has(e.nodeId)) continue;
        const box = entryBox(project, e, when);
        if (!box) continue;
        // The full product: inside an instance opened in place, the camera
        // carries the instance's rotation and skew, not just zoom and pan.
        const corners = transformCorners(mul(mat(), view, e.world), box);
        const inside = corners.some((p) => rectContains(screenRect, p.x, p.y));
        const surrounds = polygonContains(corners, screenRect.x + screenRect.w / 2,
                                                    screenRect.y + screenRect.h / 2);
        if (inside || surrounds) out.add(e.nodeId);
      }
    }
    return [...out];
  }

  // ── Input ──────────────────────────────────────────────────────────────

  private wireInput(): void {
    const host = this.host;

    on(window, "keydown", (e) => {
      const k = e as unknown as KeyboardEvent;
      if (k.code === "Space" && !this.spaceDown) {
        const t = k.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
        this.spaceDown = true;
        host.style.cursor = "grab";
      }
    });
    on(window, "keyup", (e) => {
      if ((e as unknown as KeyboardEvent).code === "Space") {
        this.spaceDown = false;
        host.style.cursor = "";
      }
    });

    on(host, "wheel", (ev) => {
      const e = ev as unknown as WheelEvent;
      e.preventDefault();
      const c = this.toContent(e);
      if (e.ctrlKey || e.metaKey) {
        this.camera.zoomAt(c.x, c.y, Math.exp(-e.deltaY * 0.0035));
        this.store.setUi({ zoom: this.camera.zoom }, "ui");
      } else if (e.shiftKey) {
        this.camera.panBy(-e.deltaY - e.deltaX, 0);
      } else {
        this.camera.panBy(-e.deltaX, -e.deltaY);
      }
      this.invalidate();
    }, { passive: false });

    on(host, "pointermove", (ev) => {
      const e = ev as unknown as PointerEvent;
      if (e.buttons !== 0 || this.spaceDown) return;
      const g = this.guideAt(e);
      if (g >= 0) {
        host.style.cursor = this.guides[g]!.axis === "x" ? "ew-resize" : "ns-resize";
        return;
      }
      this.tools.active?.onHover?.(e, this.toolCtx);
    });

    on(host, "contextmenu", (ev) => {
      const e = ev as unknown as MouseEvent;
      e.preventDefault();

      // A guide owns the right button over its own line: it is not part of
      // the scene, so the stage menu's commands would all act on something
      // else entirely.
      const g = this.guideAt(e);
      if (g >= 0) { this.guideMenu(g, e.clientX, e.clientY); return; }

      this.store.clearFrameSelection();
      const w = this.toWorld(e);
      // Locked and hidden layers are skipped here exactly as they are for the
      // left button (`hitAt` in SelectTool): a lock that holds for a click and
      // not for a right-click is not a lock, and the menu would then act on a
      // node the tools refuse to move.
      const hit = this.assetsRef
        ? this.hitTest(w.x, w.y, this.assetsRef, this.unpickable()) : null;
      // Right-clicking an unselected object selects it first, so the menu
      // always acts on what is under the pointer.
      if (hit && !this.store.selection.nodes.includes(hit)) this.store.selectNodes([hit]);
      else if (!hit) this.store.clearSelection();
      this.onContextMenu?.(e.clientX, e.clientY);
    });

    on(host, "dblclick", (ev) => {
      const e = ev as unknown as MouseEvent;

      // A guide has no other way to be given an exact coordinate: dragging is
      // approximate by nature, and typing 240 is the whole reason guides are
      // worth placing.
      const g = this.guideAt(e);
      if (g >= 0) { e.preventDefault(); this.editGuide(g); return; }

      const w = this.toWorld(e);
      const hit = this.assetsRef
        ? this.hitTest(w.x, w.y, this.assetsRef, this.unpickable()) : null;
      // Edit in place: descend into the symbol the way Flash does — the one
      // the layer shows at this frame.
      const entry = hit ? this.lastPose?.byNode.get(hit) : undefined;
      const shown = entry?.display;
      if (entry && shown && isSymbol(this.store.project.items[shown.itemId])) {
        e.preventDefault();
        this.store.enterSymbol(shown.itemId, contentMatrixOf(entry.world, shown.pivot), entry.nodeId);
        this.onEnterSymbol?.();
        return;
      }

      // Nothing under the pointer: step back OUT one level, as Flash does.
      // Double-clicking empty space is how you leave a symbol without going
      // for the breadcrumb, and it is the only exit that needs no target.
      const depth = this.store.ui.editPath.length;
      if (!hit && depth > 1) {
        e.preventDefault();
        this.store.exitToDepth(depth - 2);
        this.onEnterSymbol?.();
      }
    });

    on(host, "pointerdown", (ev) => {
      const e = ev as unknown as PointerEvent;
      host.focus();

      // Guides drag out of the rulers — unless they are locked, which means
      // exactly what it says: nothing about the guides changes.
      if (this.store.ui.showRulers && this.guidesEditable) {
        const r = host.getBoundingClientRect();
        const lx = e.clientX - r.left, ly = e.clientY - r.top;
        if (lx < RULER || ly < RULER) {
          this.beginGuideDrag(e, ly < RULER ? "y" : "x");
          return;
        }
      }

      const tool = this.store.ui.tool;
      const panning = this.spaceDown || e.button === 1 || tool === "hand";
      if (panning) { this.beginPan(e); return; }

      // An existing guide under the pointer is picked up and moved. It comes
      // before the tools deliberately: a guide is a thin line drawn over the
      // artwork, and whatever is behind it is one pixel away.
      if (e.button === 0) {
        const hit = this.guideAt(e);
        if (hit >= 0) { this.beginGuideMove(e, hit); return; }
      }

      if (tool === "zoom") {
        const c = this.toContent(e);
        this.camera.zoomAt(c.x, c.y, e.altKey ? 1 / 1.4 : 1.4);
        this.store.setUi({ zoom: this.camera.zoom }, "ui");
        this.invalidate();
        return;
      }

      if (e.button === 0) {
        this.store.clearFrameSelection();
        this.beginTool(e);
      }
    });
  }

  private beginPan(e: PointerEvent): void {
    const startPanX = this.camera.panX, startPanY = this.camera.panY;
    const sx = e.clientX, sy = e.clientY;
    this.host.setPointerCapture(e.pointerId);
    this.host.style.cursor = "grabbing";

    const move = (m: PointerEvent) => {
      this.camera.panX = startPanX + (m.clientX - sx);
      this.camera.panY = startPanY + (m.clientY - sy);
      this.invalidate();
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.host.releasePointerCapture?.(e.pointerId);
      this.host.style.cursor = this.spaceDown ? "grab" : "";
    };
    const offMove = on(this.host, "pointermove", move as (x: Event) => void);
    const offUp = on(this.host, "pointerup", up);
    const offCancel = on(this.host, "pointercancel", up);
  }

  /** Hand every non-navigation pointer gesture to the active tool. */
  private beginTool(e: PointerEvent): void {
    const tool = this.tools.active;
    if (!tool) return;
    this.host.setPointerCapture(e.pointerId);
    tool.onPointerDown?.(e, this.toolCtx);

    const move = (m: PointerEvent) => tool.onPointerMove?.(m, this.toolCtx);
    const detach = () => {
      offMove(); offUp(); offKey(); offCancel();
      this.host.releasePointerCapture?.(e.pointerId);
    };
    const up = (m: PointerEvent) => {
      detach();
      tool.onPointerUp?.(m, this.toolCtx);
    };
    const cancel = () => {
      detach();
      tool.onCancel?.(this.toolCtx);
    };
    const offMove = on(this.host, "pointermove", move as (x: Event) => void);
    const offUp = on(this.host, "pointerup", up as (x: Event) => void);
    // A pointer the browser takes away (a pen lifted out of range, a system
    // gesture) never sends pointerup: without this the move listener stayed
    // on, the object kept following a pointer with no button down, and the
    // open interaction swallowed the next edit of the same kind.
    const offCancel = on(this.host, "pointercancel", cancel);
    const offKey = on(window, "keydown", (k) => {
      if ((k as unknown as KeyboardEvent).key === "Escape") cancel();
    });
  }

  private beginGuideDrag(e: PointerEvent, axis: "x" | "y"): void {
    this.host.setPointerCapture(e.pointerId);
    const update = (m: PointerEvent) => {
      // Guides live in scene space, where the rulers that spawn them do.
      const c = this.toContent(m);
      const w = this.camera.screenToScene(c.x, c.y);
      this.draftGuide = { axis, at: this.snapGuide(axis, axis === "x" ? w.x : w.y) };
      this.showGuideTip(m, this.draftGuide, false);
      this.invalidate();
    };
    update(e);
    const up = (m: PointerEvent, cancelled = false) => {
      offMove(); offUp(); offCancel();
      this.host.releasePointerCapture?.(e.pointerId);
      this.hideGuideTip();
      const r = this.host.getBoundingClientRect();
      const inside = m.clientX - r.left > RULER && m.clientY - r.top > RULER;
      if (this.draftGuide && inside && !cancelled) this.guides.push(this.draftGuide);
      this.draftGuide = null;
      this.invalidate();
    };
    const offMove = on(this.host, "pointermove", update as (x: Event) => void);
    const offUp = on(this.host, "pointerup", ((m: PointerEvent) => up(m)) as (x: Event) => void);
    const offCancel = on(this.host, "pointercancel", ((m: PointerEvent) => up(m, true)) as (x: Event) => void);
  }

  clearGuides(): void { this.guides = []; this.invalidate(); }

  /** Guides can be picked up, moved and thrown away — unless locked. */
  private get guidesEditable(): boolean {
    return this.store.ui.showGuides && !this.store.prefs.value.stage.lockGuides;
  }

  /**
   * Index of the guide under the pointer, or -1.
   *
   * The tolerance is in SCREEN pixels — a guide is a one-pixel line, and
   * grabbing it must not get harder as the view zooms out. Searched from the
   * end so the most recently dropped guide, which is drawn last, wins.
   */
  private guideAt(e: PointerEvent | MouseEvent): number {
    if (!this.guidesEditable) return -1;
    const c = this.toContent(e);
    if (c.x < 0 || c.y < 0) return -1;             // in the rulers
    const TOL = 4;
    for (let i = this.guides.length - 1; i >= 0; i--) {
      const g = this.guides[i]!;
      const at = g.axis === "x"
        ? this.camera.sceneToScreen(g.at, 0).x - c.x
        : this.camera.sceneToScreen(0, g.at).y - c.y;
      if (Math.abs(at) <= TOL) return i;
    }
    return -1;
  }

  /**
   * Drag an existing guide.
   *
   * Dropping it back over a ruler removes it, which is where a guide came
   * from and the gesture every editor uses to get rid of one. Escape puts it
   * back where it started.
   */
  private beginGuideMove(e: PointerEvent, index: number): void {
    const guide = this.guides[index];
    if (!guide) return;
    const start = guide.at;
    this.host.setPointerCapture(e.pointerId);
    this.host.style.cursor = guide.axis === "x" ? "ew-resize" : "ns-resize";

    const overRuler = (m: PointerEvent) => {
      if (!this.store.ui.showRulers) return false;
      const r = this.host.getBoundingClientRect();
      return m.clientX - r.left < RULER || m.clientY - r.top < RULER;
    };

    const update = (m: PointerEvent) => {
      const c = this.toContent(m);
      const w = this.camera.screenToScene(c.x, c.y);
      guide.at = this.snapGuide(guide.axis, guide.axis === "x" ? w.x : w.y, index);
      const doomed = overRuler(m);
      this.host.style.cursor = doomed ? "not-allowed" : (guide.axis === "x" ? "ew-resize" : "ns-resize");
      this.showGuideTip(m, guide, doomed);
      this.invalidate();
    };

    const finish = (m: PointerEvent | null, cancelled: boolean) => {
      offMove(); offUp(); offKey(); offCancel();
      this.host.releasePointerCapture?.(e.pointerId);
      this.host.style.cursor = "";
      this.hideGuideTip();
      if (cancelled) guide.at = start;
      else if (m && overRuler(m)) this.guides.splice(index, 1);
      this.invalidate();
    };

    const offMove = on(this.host, "pointermove", ((m: PointerEvent) => update(m)) as (x: Event) => void);
    const offUp = on(this.host, "pointerup", ((m: PointerEvent) => finish(m, false)) as (x: Event) => void);
    const offCancel = on(this.host, "pointercancel", () => finish(null, true));
    const offKey = on(window, "keydown", (k) => {
      if ((k as unknown as KeyboardEvent).key === "Escape") finish(null, true);
    });
  }

  /**
   * The coordinate under the pointer while a guide is being placed.
   *
   * Dropping a guide is a blind gesture otherwise: the ruler is at the far
   * edge of the stage, and reading a position off it is exactly the thing the
   * guide is being placed to avoid.
   */
  private showGuideTip(e: PointerEvent, guide: Guide, doomed: boolean): void {
    if (!this.guideTip) {
      this.guideTip = h("div", { class: "guide-tip" });
      this.host.appendChild(this.guideTip);
    }
    const r = this.host.getBoundingClientRect();
    this.guideTip.textContent = doomed
      ? "Release to delete"
      : `${guide.axis === "x" ? "X" : "Y"}: ${Math.round(guide.at)}`;
    cls(this.guideTip, "doomed", doomed);
    this.guideTip.style.left = `${e.clientX - r.left + 14}px`;
    this.guideTip.style.top = `${e.clientY - r.top + 16}px`;
  }

  private hideGuideTip(): void {
    this.guideTip?.remove();
    this.guideTip = null;
  }

  /** Right-click on a guide: the two things you can do to one. */
  private guideMenu(index: number, x: number, y: number): void {
    const guide = this.guides[index];
    if (!guide) return;
    const locked = this.store.prefs.value.stage.lockGuides;
    showMenu(menuAnchor(x, y), [
      {
        label: `Move ${guide.axis === "x" ? "X" : "Y"}: ${Math.round(guide.at)}…`,
        enabled: !locked,
        run: () => this.editGuide(index),
      },
      {
        label: "Delete Guide",
        enabled: !locked,
        run: () => { this.guides.splice(index, 1); this.invalidate(); },
      },
      "-",
      {
        label: "Clear Guides",
        enabled: !locked,
        run: () => this.clearGuides(),
      },
      {
        label: "Lock Guides",
        checked: locked,
        run: () => {
          this.store.prefs.set("stage", { lockGuides: !locked });
          this.store.emit("stage");
        },
      },
    ]);
  }

  /** The coordinate dialog behind a double click, with Delete beside it. */
  private editGuide(index: number): void {
    const guide = this.guides[index];
    if (!guide) return;
    promptNumber({
      title: guide.axis === "x" ? "Vertical Guide" : "Horizontal Guide",
      label: guide.axis === "x" ? "X" : "Y",
      value: guide.at,
      unit: "px",
      extra: {
        label: "Delete",
        run: () => { this.guides.splice(index, 1); this.invalidate(); },
      },
      onOk: (v) => {
        const g = this.guides[index];
        if (!g) return;
        g.at = Math.round(v);
        this.invalidate();
      },
    });
  }

  /**
   * Correct a tool's world-space drag delta so the selection lands on a grid
   * line, a guide, the stage or another object.
   *
   * The arithmetic happens in SCENE space — that is the frame the grid, the
   * guides and the stage rectangle live in — so the delta is converted in
   * through `camera.base` and back out through its inverse. Inside an edited
   * symbol that base carries the instance's own scale and rotation, and
   * snapping without the round trip would quietly land on the wrong lines.
   */
  private beginSnap(moving: Iterable<string>): void {
    const store = this.store;
    const sp = store.prefs.value.snap;
    const pose = this.lastPose;
    this.snapLines = [];
    this.snapSession = null;
    if (!store.ui.snap || !sp.enabled || !pose) return;

    const base = this.camera.base;
    // What moves with the drag, children included: they are the selection's
    // edges (a group or a bone has no artwork of its own) and must not be
    // targets, or the drag catches on where its own contents started.
    const ids = new Set(withDescendants(store.currentSymbol, [...moving] as NodeId[]));
    const when = this.frameContext;
    const refs = selectionRefs(store.project, pose, base, ids, when);
    if (refs.xs.length === 0) return;

    this.snapSession = {
      refs,
      targets: collectSnapTargets(
        store.project, store.currentSymbol, pose, base, this.guides, ids, when, sp,
      ),
    };
  }

  /**
   * Correct a tool's world-space drag delta so the selection lands on a grid
   * line, a guide, the stage or another object.
   *
   * The arithmetic happens in SCENE space — that is the frame the grid, the
   * guides and the stage rectangle live in — so the delta is converted in
   * through `camera.base` and back out through its inverse. Inside an edited
   * symbol that base carries the instance's own scale and rotation, and
   * snapping without the round trip would quietly land on the wrong lines.
   */
  private snapDelta(dx: number, dy: number, free = false): { dx: number; dy: number } {
    const session = this.snapSession;
    if (free || !session) {
      this.snapLines = [];
      return { dx, dy };
    }

    const prefs = this.store.prefs.value;
    const sp = prefs.snap;
    const base = this.camera.base;
    const inv = mat();
    if (!invert(inv, base)) { this.snapLines = []; return { dx, dy }; }

    const res = snapMove(
      session.refs.xs, session.refs.ys,
      base.a * dx + base.c * dy, base.b * dx + base.d * dy,
      session.targets, {
        grid: sp.toGrid ? prefs.stage.gridSize : null,
        pixel: sp.toPixel,
        // Screen pixels -> scene units: the tolerance must feel the same at
        // every zoom, which is what makes it usable at 800%.
        tolerance: sp.tolerancePx / this.camera.zoom,
      });

    this.snapLines = sp.showLines ? res.lines : [];
    return {
      dx: inv.a * res.dx + inv.c * res.dy,
      dy: inv.b * res.dx + inv.d * res.dy,
    };
  }

  /** A guide dragged out of a ruler snaps to the same lines everything else
   *  does — otherwise the one thing meant to be a precise reference is the
   *  one thing placed by eye. */
  private snapGuide(axis: "x" | "y", at: number, exclude = -1): number {
    const store = this.store;
    const prefs = store.prefs.value;
    const sp = prefs.snap;
    if (!store.ui.snap || !sp.enabled || !this.lastPose) return Math.round(at);

    // A guide being moved must not snap to itself.
    const others = exclude < 0 ? this.guides : this.guides.filter((_, i) => i !== exclude);
    const targets = collectSnapTargets(
      store.project, store.currentSymbol, this.lastPose, this.camera.base,
      others, new Set(), this.frameContext, sp,
    );
    return snapValue(at, axis === "x" ? targets.xs : targets.ys, {
      grid: sp.toGrid ? prefs.stage.gridSize : null,
      pixel: true,
      tolerance: sp.tolerancePx / this.camera.zoom,
    });
  }

  /** Set by App so hit testing can probe alpha. */
  assetsRef: AssetStore | null = null;
  /** Set by App, to refit the view after descending into a symbol. */
  onEnterSymbol: (() => void) | null = null;
  /** Set by App; opens the stage context menu at screen coordinates. */
  onContextMenu: ((x: number, y: number) => void) | null = null;

  /** A fit asked for while the stage had no size yet (a page loaded in a
   *  hidden pane): made on the first real resize, since fitting a 1px view
   *  clamped the zoom to 2% and left the stage a dot in the corner. */
  private fitPending = false;

  fitToStage(): void {
    const s = this.store.project.stage;
    this.fitPending = this.camera.width < 100 || this.camera.height < 100;
    if (this.fitPending) return;
    this.camera.fit({ x: 0, y: 0, w: s.width, h: s.height });
    this.store.setUi({ zoom: this.camera.zoom }, "ui");
    this.invalidate();
  }
}
