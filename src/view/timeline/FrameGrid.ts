import { h, on, raf } from "@/view/widgets/dom";
import type { Store } from "@/app/Store";
import type { Layer, Track } from "@/core/doc/types";
import type { NodeId } from "@/core/doc/ids";
import { describeFrame, ensureTrack } from "@/app/TimelineOps";
import { keyIndexAt, MAX_FRAMES, spanIndexAt } from "@/core/doc/timeline";
import { easeTag } from "@/core/math/easing";
import { type LayerRow, layerRows } from "@/core/doc/layerTree";
import { withAlpha } from "@/view/viewport/overlayColors";
import { DEFAULT_PREFS } from "@/core/prefs/prefs";
import { uiFont, type UiFontSize, uiPx } from "@/core/prefs/fonts";
import { dragMarkers, type MarkerDrag } from "@/core/doc/onion";

/** The unscaled row and ruler heights. The layer list is DOM and the grid is
 *  canvas, so the same two numbers have to reach both — see `TimelinePanel`. */
export const ROW_HEIGHT = 20;
export const HEADER_HEIGHT = 22;

export interface FrameGridCallbacks {
  onScrub(frame: number): void;
  onSelectCell(layerIndex: number, frame: number, additive: boolean): void;
  /**
   * A rectangle of cells, from a drag or a shift-click: rows `rowFrom..rowTo`
   * over frames `from..to`, both inclusive.
   */
  onSelectRange(rowFrom: number, rowTo: number, from: number, to: number): void;
  onMoveKeyframes(nodeId: NodeId, from: number, to: number, delta: number, base?: Track): void;
  /** A frame selection dragged somewhere else: its top-left cell lands on
   *  `row`/`frame`. `copy` is ⌥ held at the release. */
  onDragFrames(row: number, frame: number, copy: boolean): void;
  onDragSpanEnd(nodeId: NodeId, endFrame: number): void;
  onBeginInteraction(kind: string): void;
  onEndInteraction(): void;
  onContextMenu(layerIndex: number, frame: number, x: number, y: number): void;
  /** Right-click on the ruler: frame operations that span every layer. */
  onRulerContextMenu(frame: number, x: number, y: number): void;
  /** A vertical wheel over the grid. The layer list owns the only vertical
   *  scroll in the panel, so the grid forwards rather than scrolling itself. */
  onWheelY(delta: number): void;
  /** The drawn geometry changed — `contentWidth` or `scrollX`. The horizontal
   *  scrollbar is a sibling element, so it has to be told; it used to be
   *  refreshed only on store events, and the zoom slider emits none. */
  onGeometry(): void;
}

/** A rectangle of cells: visible rows `top..bottom` over frames `from..to`. */
interface FrameRect { top: number; bottom: number; from: number; to: number }

/** The frame grid's palette. A value rather than a constant so the
 *  Preferences dialog can recolour the playhead, tweens and the selection —
 *  the three things a user squints at on a long timeline. */
const DEFAULT_GRID_COLORS = {
  headerBg: "#3c3c3c",
  headerAlt: "#464646",
  headerLine: "#2a2a2a",
  tick: "#8a8a8a",
  text: "#a8a8a8",
  /** The empty cell, and every fifth one a shade darker. The grid of little
   *  rectangles IS the ruler down in the rows: it is what makes a frame
   *  countable without reading the header.
   *
   *  ONE pair, for every empty cell on every row. Lighting the cells inside
   *  the animation's length and dimming the rest made a row's empty frames
   *  change tone under a neighbouring layer that happened to reach further —
   *  the length is a property of the animation, not of the cell, and the end
   *  mark on each track already says where a layer stops. */
  cell: "#464646",
  cellAlt: "#414141",
  /** Behind the cells, and the whole area below the last layer. */
  bodyBg: "#383838",
  /** The line down the left of a keyframe, and the end of a span. */
  spanEdge: "rgba(0,0,0,0.55)",
  occupied: "#6e6e6e",
  blank: "#4a4a4a",
  tween: "#7a7fb0",
  tweenLine: "#c2c6ec",
  keyDot: "#161616",
  keyRing: "#161616",
  endMark: "#161616",
  playhead: "#e8483f",
  selected: DEFAULT_PREFS.timeline.selected,
  rowLine: "rgba(0,0,0,0.22)",
  currentRow: "rgba(255,255,255,0.045)",
  group: "#585858",
  emptyRow: "#565656",
  excluded: "rgba(0,0,0,0.30)",
};

/**
 * The frame grid, drawn on a canvas.
 *
 * DOM rows would be tens of thousands of elements for a long animation with
 * many layers; a canvas draws only what is on screen and keeps scrubbing
 * smooth. The layer list beside it stays DOM, because those rows are few and
 * need real inputs and drag targets.
 */
export class FrameGrid {
  /** The palette in force. Rebuilt when the preferences change, not per draw. */
  private C = { ...DEFAULT_GRID_COLORS };

  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  frameWidth = 12;
  /** Kept in step with the layer list beside it: both come from the UI text
   *  scale, and one row of names that does not line up with its strip of
   *  frames is the first thing that breaks. */
  rowHeight = 20;
  headerHeight = 22;
  private fontSize: UiFontSize = "small";
  /**
   * Reserved strip along the bottom. The horizontal scrollbar is an overlay
   * inside this element, so without it the last row is drawn underneath the
   * bar and its pointer events go to the bar instead of the grid.
   */
  bottomGutter = 14;
  scrollX = 0;
  scrollY = 0;
  /** Where a frame drag currently points; drawn, not applied, until release. */
  private drop: FrameRect | null = null;

  readonly invalidate: () => void;

  constructor(
    private readonly store: Store,
    private readonly cb: FrameGridCallbacks,
  ) {
    this.canvas = h("canvas");
    this.el = h("div", { class: "tl-frames" }, this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.invalidate = raf(() => this.draw());
    this.applyPrefs();
    store.prefs.subscribe(() => { this.applyPrefs(); this.invalidate(); });

    new ResizeObserver(() => this.resize()).observe(this.el);
    this.resize();
    this.wireInput();
  }

  private applyPrefs(): void {
    const t = this.store.prefs.value.timeline;
    this.frameWidth = t.frameWidth;
    this.fontSize = this.store.prefs.value.interface.fontSize;
    this.rowHeight = uiPx(ROW_HEIGHT, this.fontSize);
    this.headerHeight = uiPx(HEADER_HEIGHT, this.fontSize);
    this.C = {
      ...DEFAULT_GRID_COLORS,
      playhead: t.playhead,
      tween: t.tween,
      selected: t.selected,
      keyDot: t.keyframe,
      keyRing: t.keyframe,
      endMark: t.keyframe,
    };
  }

  private resize(): void {
    const r = this.el.getBoundingClientRect();
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.invalidate();
  }

  get viewWidth(): number { return this.el.clientWidth; }
  get viewHeight(): number {
    return this.el.clientHeight - this.headerHeight - this.bottomGutter;
  }
  /** Bottom of the drawable row area, above the scrollbar strip. */
  private get bodyBottom(): number {
    return Math.max(this.headerHeight, this.el.clientHeight - this.bottomGutter);
  }

  /** How far the grid can be scrolled, in pixels. */
  get contentWidth(): number {
    // The frames past the end of the animation are not padding: the ruler
    // numbers them, the playhead can be parked on one, and F5/F6 out there is
    // how a timeline is made longer. So there is always a full viewport of
    // them to scroll into, and the reach follows the playhead — parking it at
    // 400 leaves room to keep going rather than stopping dead at 401.
    const duration = this.store.currentAnimation?.duration ?? 1;
    const reach = Math.max(duration, this.store.ui.frame + 1);
    const slack = Math.max(this.viewWidth, this.frameWidth * 24);
    const frames = Math.min(MAX_FRAMES, reach + Math.ceil(slack / this.frameWidth));
    return frames * this.frameWidth;
  }

  /** The rows currently on screen, matching the layer column exactly. */
  visibleRows(): LayerRow[] {
    return layerRows(this.store.currentSymbol);
  }

  frameAtX(x: number): number {
    const f = Math.floor((x + this.scrollX) / this.frameWidth);
    return Math.max(0, Math.min(MAX_FRAMES - 1, f));
  }
  xOfFrame(frame: number): number {
    return frame * this.frameWidth - this.scrollX;
  }
  rowAtY(y: number): number {
    if (y >= this.bodyBottom) return -1;      // the scrollbar strip, not a row
    return Math.floor((y - this.headerHeight + this.scrollY) / this.rowHeight);
  }

  // ── Drawing ────────────────────────────────────────────────────────────

  private draw(): void {
    const ctx = this.ctx;
    const w = this.el.clientWidth;
    const h = this.bodyBottom;
    if (w <= 0 || this.el.clientHeight <= 0) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, this.el.clientHeight);

    const sym = this.store.currentSymbol;
    const anim = this.store.currentAnimation;
    const duration = anim?.duration ?? 1;
    const fps = this.store.project.frameRate;
    // The grid must show exactly the rows the layer column shows, collapsed
    // groups included, or the two panes drift apart by a row.
    const rows = layerRows(sym);

    // The visible range, NOT the animation's: the ruler is numbered and the
    // cells are drawn all the way out to `MAX_FRAMES`, so the playhead can be
    // put on a frame past the end and given content there. Stopping at
    // `duration` left the grid finishing at frame 16 with nothing to click.
    const first = Math.max(0, Math.floor(this.scrollX / this.frameWidth));
    const last = Math.min(MAX_FRAMES - 1, first + Math.ceil(w / this.frameWidth) + 1);

    this.drawBody(ctx, rows, first, last, w, h, duration);
    this.drawHeader(ctx, first, last, w, fps);
    this.drawOnionMarkers(ctx);
    this.drawPlayhead(ctx, h);

    // Every route that changes the geometry ends here — the zoom slider, a
    // ctrl-wheel, `revealFrame`, a longer animation — so this is the one
    // place the scrollbar can be kept in step without each of them
    // remembering to.
    this.cb.onGeometry();
  }

  private drawHeader(
    ctx: CanvasRenderingContext2D, first: number, last: number,
    w: number, fps: number,
  ): void {
    const H = this.headerHeight;
    ctx.fillStyle = this.C.headerBg;
    ctx.fillRect(0, 0, w, H);

    // A lighter band each second, the way Animate marks time. Across the
    // whole visible strip, not just the animation, so the seconds keep
    // counting out into the empty frames.
    if (fps > 0) {
      ctx.fillStyle = this.C.headerAlt;
      const start = Math.floor(first / fps) * fps;
      for (let f = start; f <= last; f += fps) {
        if (Math.floor(f / fps) % 2 !== 0) continue;
        ctx.fillRect(this.xOfFrame(f), 0, fps * this.frameWidth, H);
      }
    }

    ctx.font = uiFont(9, this.fontSize);
    ctx.textBaseline = "middle";
    ctx.strokeStyle = this.C.tick;
    ctx.lineWidth = 1;
    ctx.beginPath();

    // Two passes, because the two kinds of label are on different rhythms —
    // seconds every `fps` frames, numbers every `step` — and out at frame
    // 15900 a five-digit number is wide enough to land on top of the "662s"
    // one frame along. The seconds go down first and the numbers give way to
    // them: the second is the coarser mark and the one that orients you.
    const taken: Array<[number, number]> = [];
    const label = (f: number, text: string, second: boolean): void => {
      const x = this.xOfFrame(f);
      const left = x + 3;
      const right = left + ctx.measureText(text).width;
      if (taken.some(([a, b]) => left < b + 3 && right + 3 > a)) return;
      taken.push([left, right]);
      ctx.moveTo(Math.round(x) + 0.5, H - 5);
      ctx.lineTo(Math.round(x) + 0.5, H - 1);
      ctx.fillStyle = second ? "#e0e0e0" : this.C.text;
      ctx.fillText(text, left, H / 2 - 1);
    };

    if (fps > 0) {
      const start = Math.max(fps, Math.ceil(first / fps) * fps);
      for (let f = start; f <= last; f += fps) label(f, `${f / fps}s`, true);
    }

    // Labels land on the DISPLAYED number, which is 1-based: 1, then 5, 10,
    // 15. Stepping over the internal index instead would print 1, 6, 11.
    const step = this.frameWidth >= 10 ? 5 : this.frameWidth >= 5 ? 10 : 20;
    for (let f = first; f <= last; f++) {
      const shown = f + 1;
      if (f !== 0 && shown % step !== 0) continue;
      label(f, String(shown), false);
    }
    ctx.stroke();

    ctx.strokeStyle = this.C.headerLine;
    ctx.beginPath();
    ctx.moveTo(0, H - 0.5);
    ctx.lineTo(w, H - 0.5);
    ctx.stroke();
  }

  /** The markers are shown whenever something reads them: the onion skin,
   *  or Edit Multiple Frames. */
  private get markersShown(): boolean {
    const ui = this.store.ui;
    return (ui.onionSkin || ui.editMultipleFrames) && ui.mode === "animate" && !!this.store.currentAnimation;
  }

  /**
   * Animate's onion markers: a band over the ruler from the start marker to
   * the end one, with a bracket at each end in the past and future colours.
   * An anchored range gets a solid knob on each bracket, a following one a
   * hollow knob — the one thing that says whether the range will move with
   * the playhead.
   */
  private drawOnionMarkers(ctx: CanvasRenderingContext2D): void {
    if (!this.markersShown) return;
    const span = this.store.onionSpan;
    const o = this.store.prefs.value.timeline;
    const H = this.headerHeight;
    const x0 = Math.round(this.xOfFrame(span.start)) + 0.5;
    const x1 = Math.round(this.xOfFrame(span.end + 1)) - 0.5;
    const top = 1.5, bottom = H - 2.5;

    ctx.fillStyle = "rgba(255,255,255,0.13)";
    ctx.fillRect(x0, top, x1 - x0, bottom - top);

    const anchored = !!this.store.ui.onionAnchor;
    const bracket = (x: number, dir: 1 | -1, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + dir * 3, top);
      ctx.lineTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.lineTo(x + dir * 3, bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, H / 2, 3, 0, Math.PI * 2);
      ctx.fillStyle = anchored ? color : this.C.headerBg;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    bracket(x0, 1, o.onionPastColor);
    bracket(x1, -1, o.onionFutureColor);
  }

  /** Which marker a press on the ruler at `x` grabs, if any. */
  private markerAt(x: number, e: PointerEvent): MarkerDrag | null {
    if (!this.markersShown) return null;
    const span = this.store.onionSpan;
    const x0 = this.xOfFrame(span.start);
    const x1 = this.xOfFrame(span.end + 1);
    const near = (a: number) => Math.abs(x - a) <= 5;
    if (e.shiftKey && x >= x0 - 5 && x <= x1 + 5) return "range";
    const which: MarkerDrag | null = near(x0) ? "start" : near(x1) ? "end" : null;
    if (!which) return null;
    return e.metaKey || e.ctrlKey ? "both" : which;
  }

  private beginMarkerDrag(e: PointerEvent, which: MarkerDrag): void {
    this.el.setPointerCapture(e.pointerId);
    const base = this.store.onionSpan;
    const startX = e.clientX;
    const maxFrame = this.store.maxFrame;
    // A following range must keep the playhead inside it: what it stores is
    // two distances from it.
    const playhead = this.store.ui.onionAnchor ? undefined : this.store.ui.frame;
    let last = 0;
    const move = (m: PointerEvent) => {
      const delta = Math.round((m.clientX - startX) / this.frameWidth);
      if (delta === last) return;
      last = delta;
      this.store.setOnionSpan(dragMarkers(base, which, delta, maxFrame, playhead));
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  private drawBody(
    ctx: CanvasRenderingContext2D, rows: LayerRow[],
    first: number, last: number, w: number, h: number, duration: number,
  ): void {
    const anim = this.store.currentAnimation;
    const H = this.headerHeight;
    const rowH = this.rowHeight;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, H, w, h - H);
    ctx.clip();

    // Below the last layer there are no frames: nothing to count, nothing to
    // click, so nothing is drawn there. The cell grid and the animation's
    // extent used to be painted across the FULL height of the panel, which is
    // why deleting a layer left a lit block of frames hanging in the empty
    // space underneath — the rows were gone and their background was not.
    ctx.fillStyle = this.C.bodyBg;
    ctx.fillRect(0, H, w, h - H);

    const selectedFrames = new Set(this.store.selection.frames);
    const selectedNodes = new Set(this.store.selection.nodes);

    for (let i = 0; i < rows.length; i++) {
      const { layer, node } = rows[i]!;
      const y = H + i * rowH - this.scrollY;
      if (y + rowH < H || y > h) continue;

      // The empty grid first: it is the ground every span is drawn on.
      this.drawCells(ctx, y, first, last);

      if (selectedNodes.has(layer.nodeId)) {
        ctx.fillStyle = this.C.currentRow;
        ctx.fillRect(0, y, w, rowH);
      }

      const track: Track | undefined = anim?.tracks[layer.nodeId];
      // A group has no artwork of its own, so it gets a thinner band: it is
      // a container, and drawing it like content would suggest otherwise. An
      // empty layer gets an outlined band with a hollow keyframe — Flash's
      // "one empty frame", and visibly not something that will be exported.
      this.drawTrackRow(ctx, track, layer, y, first, last, duration,
                        node.kind === "group" ? "group"
                          : node.kind === "empty" ? "empty" : "node");

      // An excluded layer is darkened across its whole width: it still draws
      // on the stage, so the timeline is the only place that can say it will
      // not be in the file.
      if (layer.excludeFromExport) {
        ctx.fillStyle = this.C.excluded;
        ctx.fillRect(0, y, w, rowH - 1);
      }

      // The selection wash sits on top and is drawn per row rather than per
      // track, so a layer with no track of its own still shows what is
      // selected on it.
      for (let f = first; f <= last; f++) {
        if (!selectedFrames.has(`${layer.nodeId}:${f}`)) continue;
        ctx.fillStyle = this.C.selected;
        ctx.fillRect(this.xOfFrame(f), y + 1, this.frameWidth - 1, rowH - 3);
      }
    }

    if (this.drop) this.drawFrameDrop(ctx, this.drop, w);

    // Vertical separators are the cells' own gutters now, drawn per row —
    // full-height lines were the other half of the block left behind by a
    // deleted layer, and they were the thing that had to be clipped to the
    // animation's length and so kept disappearing halfway across the panel.
    ctx.strokeStyle = this.C.rowLine;
    ctx.beginPath();
    for (let i = 0; i <= rows.length; i++) {
      const y = Math.round(H + i * rowH - this.scrollY) + 0.5;
      if (y < H || y > h) continue;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    ctx.restore();
  }

  /** Where a dragged frame selection would land: a wash and an outline, so
   *  the destination is readable over the cells it covers. */
  private drawFrameDrop(ctx: CanvasRenderingContext2D, d: FrameRect, w: number): void {
    const x = this.xOfFrame(d.from);
    const y = this.headerHeight + d.top * this.rowHeight - this.scrollY;
    const width = (d.to - d.from + 1) * this.frameWidth - 1;
    const height = (d.bottom - d.top + 1) * this.rowHeight - 1;
    if (x > w || x + width < 0) return;
    ctx.fillStyle = this.C.selected;
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = this.C.playhead;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, width - 1, height - 1);
  }

  /**
   * One row of empty cells: rectangles with a one-pixel gutter of background
   * between them, every fifth a shade darker. Two paths and two fills, not a
   * fill per cell — this runs for every visible row of every draw, and
   * playback draws every frame.
   */
  private drawCells(
    ctx: CanvasRenderingContext2D, y: number, first: number, last: number,
  ): void {
    const fw = this.frameWidth;
    const paths = [new Path2D(), new Path2D()];
    for (let f = first; f <= last; f++) {
      const p = paths[(f + 1) % 5 === 0 ? 1 : 0]!;
      p.rect(Math.round(this.xOfFrame(f)), y, Math.max(1, fw - 1), this.rowHeight - 1);
    }
    ctx.fillStyle = this.C.cell;
    ctx.fill(paths[0]!);
    ctx.fillStyle = this.C.cellAlt;
    ctx.fill(paths[1]!);
  }

  /** The line down the left of a keyframe, or the right end of a span. */
  private drawSpanEdge(ctx: CanvasRenderingContext2D, x: number, y: number, pad: number): void {
    ctx.fillStyle = this.C.spanEdge;
    ctx.fillRect(Math.round(x), y + pad, 1, this.rowHeight - pad * 2 - 1);
  }

  private drawTrackRow(
    ctx: CanvasRenderingContext2D, track: Track | undefined, layer: Layer,
    y: number, first: number, last: number,
    duration = 1, band: "node" | "group" | "empty" = "node",
  ): void {
    const fw = this.frameWidth;
    const isGroup = band === "group";

    // A node with no track still shows its bind pose at every frame, so draw
    // the span it actually occupies. Leaving the row blank would suggest the
    // object is not on stage, and creating a real track just to say "static"
    // would put a useless timeline into the export.
    if (!track) {
      const x0 = this.xOfFrame(0);
      const x1 = this.xOfFrame(duration);

      if (band === "empty") {
        // Outline, not fill: the layer occupies the stack but holds nothing,
        // and the hollow dot at frame 0 is the empty keyframe.
        ctx.strokeStyle = this.C.emptyRow;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, y + 1.5, x1 - x0 - 2, this.rowHeight - 4);
        ctx.beginPath();
        ctx.arc(x0 + fw / 2 - 0.5, y + this.rowHeight - 6, 3, 0, Math.PI * 2);
        ctx.strokeStyle = this.C.keyRing;
        ctx.stroke();
        return;
      }

      const inset = isGroup ? 6 : 1;
      ctx.fillStyle = isGroup ? this.C.group : this.C.occupied;
      ctx.fillRect(x0, y + inset, x1 - x0, this.rowHeight - inset * 2 - 1);
      if (isGroup) return;
      // The implicit keyframe at 0, and the end of the span: the only two
      // edges a static layer has.
      this.drawSpanEdge(ctx, x0, y, inset);
      this.drawSpanEdge(ctx, x1 - 1, y, inset);
      ctx.beginPath();
      ctx.arc(x0 + fw / 2 - 0.5, y + this.rowHeight - 6, 3, 0, Math.PI * 2);
      ctx.fillStyle = this.C.keyDot;
      ctx.fill();
      ctx.fillStyle = this.C.endMark;
      ctx.fillRect(this.xOfFrame(duration - 1) + fw - 4, y + 3, 2, this.rowHeight - 8);
      return;
    }

    const rowH = this.rowHeight;
    const pad = 1;

    // Span backgrounds first, so dots and arrows land on top.
    for (let i = 0; i < track.keys.length; i++) {
      const key = track.keys[i]!;
      const nextKey = track.keys[i + 1];
      const spanEnd = nextKey ? nextKey.frame : track.endFrame + 1;
      if (spanEnd < first || key.frame > last) continue;

      const x0 = this.xOfFrame(key.frame);
      const x1 = this.xOfFrame(spanEnd);
      const tweening = !!nextKey && key.tween.kind !== "none" && key.displayIndex >= 0;

      // Full width, no gutter: two spans of the same kind side by side are
      // ONE rectangle, the way Flash draws them. What separates them is the
      // edge line every keyframe carries, drawn once the fills are down.
      ctx.fillStyle = key.displayIndex < 0 ? this.C.blank : tweening ? this.C.tween : this.C.occupied;
      ctx.fillRect(x0, y + pad, x1 - x0, rowH - pad * 2 - 1);

      if (tweening && x1 - x0 > fw * 1.5) {
        // The tween arrow: a line from this keyframe to the next.
        const cy = y + rowH / 2;
        ctx.strokeStyle = this.C.tweenLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0 + fw * 0.7, cy);
        ctx.lineTo(x1 - fw * 0.5, cy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x1 - fw * 0.5, cy);
        ctx.lineTo(x1 - fw * 0.5 - 4, cy - 3);
        ctx.lineTo(x1 - fw * 0.5 - 4, cy + 3);
        ctx.closePath();
        ctx.fillStyle = this.C.tweenLine;
        ctx.fill();

        // Which easing it is, so an ease in is distinguishable from an ease
        // out without opening a menu.
        const base = easeTag(key.tween);
        const tag = base !== null || key.eases ? `${base ?? ""}${key.eases ? "*" : ""}` : null;
        if (tag && x1 - x0 > fw * 3) {
          ctx.font = uiFont(8, this.fontSize);
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillStyle = this.C.tweenLine;
          ctx.fillText(tag, x0 + fw * 0.9, cy - 5);
          ctx.textAlign = "start";
        }
      }
    }

    // Edges: one down the left of every keyframe, one closing the track.
    for (const key of track.keys) {
      if (key.frame < first - 1 || key.frame > last + 1) continue;
      this.drawSpanEdge(ctx, this.xOfFrame(key.frame), y, pad);
    }
    if (track.endFrame >= first - 1 && track.endFrame <= last + 1) {
      this.drawSpanEdge(ctx, this.xOfFrame(track.endFrame + 1) - 1, y, pad);
    }

    // Keyframe markers.
    const cy = y + rowH - 6;
    for (const key of track.keys) {
      if (key.frame < first - 1 || key.frame > last + 1) continue;
      const cx = this.xOfFrame(key.frame) + fw / 2 - 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      if (key.displayIndex < 0) {
        // A blank keyframe reads as a hollow circle, as in Flash.
        ctx.strokeStyle = this.C.keyRing;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else {
        ctx.fillStyle = this.C.keyDot;
        ctx.fill();
      }
    }

    // End-of-span marker.
    if (track.endFrame >= first && track.endFrame <= last) {
      const x = this.xOfFrame(track.endFrame);
      ctx.fillStyle = this.C.endMark;
      ctx.fillRect(x + fw - 4, y + 3, 2, rowH - 8);
    }

    void layer;
  }

  private drawPlayhead(ctx: CanvasRenderingContext2D, h: number): void {
    const H = this.headerHeight;
    // Centred on the CELL, which starts at a rounded x and is `frameWidth - 1`
    // wide — half of `frameWidth` from the unrounded left edge put the line a
    // pixel to the right of centre, and that is visible against a grid.
    const cellX = Math.round(this.xOfFrame(this.store.ui.frame));
    const cellW = Math.max(1, this.frameWidth - 1);
    const x = cellX + Math.floor((cellW - 1) / 2) + 0.5;
    if (x < -this.frameWidth || x > this.el.clientWidth + this.frameWidth) return;

    // The marker is a WINDOW over the current frame's cell in the ruler, with
    // the tip of its arrow on the line under the header. A plain triangle at
    // the top of the header was easy to lose and sat on the frame number.
    const tip = H - 1;                       // the `headerLine` pixel row
    const arrow = Math.max(3, Math.min(5, cellW / 2 + 1));
    const boxBottom = Math.max(6, tip - arrow);

    ctx.fillStyle = withAlpha(this.C.playhead, 0.2);
    ctx.fillRect(cellX + 0.5, 0.5, cellW - 1, boxBottom - 0.5);
    ctx.strokeStyle = this.C.playhead;
    ctx.lineWidth = 1;
    ctx.strokeRect(cellX + 0.5, 0.5, cellW - 1, boxBottom - 0.5);

    ctx.fillStyle = this.C.playhead;
    ctx.beginPath();
    ctx.moveTo(x - arrow, boxBottom);
    ctx.lineTo(x + arrow, boxBottom);
    ctx.lineTo(x, tip);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = this.C.playhead;
    ctx.beginPath();
    ctx.moveTo(x, boxBottom);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  // ── Input ──────────────────────────────────────────────────────────────

  private wireInput(): void {
    const el = this.el;

    on(el, "wheel", (ev) => {
      const e = ev as unknown as WheelEvent;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.setFrameWidth(this.frameWidth * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
        return;
      }
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        this.scrollX = Math.max(0, this.scrollX + e.deltaX);
        this.invalidate();
        return;
      }
      // Vertical: the rows the wheel is over live in the LAYER LIST, whose
      // native scroll drives `setScrollY`. Without this the grid swallowed
      // the wheel and a rig with thirty layers only scrolled while the
      // pointer sat on the names.
      if (e.deltaY !== 0) {
        e.preventDefault();
        this.cb.onWheelY(e.deltaY);
      }
    }, { passive: false });

    on(el, "contextmenu", (ev) => {
      const e = ev as unknown as MouseEvent;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const localY = e.clientY - r.top;
      const frame = this.frameAtX(e.clientX - r.left);
      // The ruler belongs to no layer, so it gets the menu whose operations
      // are about the animation as a whole.
      if (localY < this.headerHeight) {
        this.cb.onRulerContextMenu(frame, e.clientX, e.clientY);
        return;
      }
      this.cb.onContextMenu(this.rowAtY(localY), frame, e.clientX, e.clientY);
    });

    on(el, "pointerdown", (ev) => {
      const e = ev as unknown as PointerEvent;
      if (e.button !== 0) return;
      const r = el.getBoundingClientRect();
      const localX = e.clientX - r.left;
      const localY = e.clientY - r.top;
      const frame = this.frameAtX(localX);

      // The ruler scrubs, except on an onion marker: a marker is a few
      // pixels drawn over the ruler, and whatever is behind it is the ruler.
      if (localY < this.headerHeight) {
        const marker = this.markerAt(localX, e);
        if (marker) { this.beginMarkerDrag(e, marker); return; }
        this.beginScrub(e, frame);
        return;
      }

      const row = this.rowAtY(localY);
      const layer = this.visibleRows()[row]?.layer;
      // Below the last layer there are no frames: a press there deselects
      // them, as a press on the empty stage does.
      if (!layer) { this.store.clearFrameSelection(); return; }

      const track = this.store.currentAnimation?.tracks[layer.nodeId];
      // A layer with no track still shows a full-length span, so its end is
      // draggable too — the drag is what materialises the track.
      const endFrame = track?.endFrame
        ?? Math.max(0, (this.store.currentAnimation?.duration ?? 1) - 1);

      // Shift extends the existing selection rather than starting a new one.
      if (e.shiftKey && this.anchor) {
        const a = this.anchor;
        this.cb.onSelectRange(
          Math.min(a.row, row), Math.max(a.row, row),
          Math.min(a.frame, frame), Math.max(a.frame, frame),
        );
        this.beginRangeSelect(e, a.row, a.frame);
        return;
      }

      // The very end of a span is the stretch handle, and it wins even inside
      // a selection — that is the gesture the right edge is there for.
      const onSpanEnd = frame === endFrame
        && localX > this.xOfFrame(frame) + this.frameWidth * 0.55;

      // Flash's frame drag: a press INSIDE the current selection picks the
      // whole rectangle up and drops it on another frame or another layer,
      // rather than starting a new selection. The selection is left standing
      // until the pointer is released without having moved, which is then an
      // ordinary click.
      const rect = onSpanEnd ? null : this.frameSelectionRect();
      if (rect && row >= rect.top && row <= rect.bottom
          && frame >= rect.from && frame <= rect.to) {
        this.anchor = { row, frame };
        this.beginFrameDrag(e, row, frame, rect);
        return;
      }

      this.anchor = { row, frame };
      this.cb.onSelectCell(row, frame, false);

      // Dragging the very end of a span extends or trims it.
      if (onSpanEnd) {
        this.beginSpanDrag(e, layer.nodeId, endFrame);
        return;
      }
      if (track && keyIndexAt(track, frame) >= 0) {
        this.beginKeyDrag(e, layer.nodeId, frame);
        return;
      }
      // A layer with no track shows an implicit keyframe at 0 (a group shows
      // none), and dragging it is how an instance just dropped on the stage
      // starts later: the drag materialises the track, as the end drag does.
      const node = this.store.currentSymbol.nodes[layer.nodeId];
      if (!track && frame === 0 && node && node.kind !== "group") {
        this.beginKeyDrag(e, layer.nodeId, frame, ensureTrack(this.store, node));
        return;
      }
      // Dragging across the body selects a run of frames, the way it does in
      // Flash. Scrubbing lives on the ruler.
      this.beginRangeSelect(e, row, frame);
    });
  }

  private anchor: { row: number; frame: number } | null = null;

  /**
   * The frame selection as a rectangle of VISIBLE rows, or null when there is
   * nothing to pick up: a single cell is a click, not a span, and its keyframe
   * drag is the gesture that already covers it.
   */
  private frameSelectionRect(): FrameRect | null {
    const frames = this.store.selection.frames;
    if (frames.length < 2) return null;
    const rows = this.visibleRows();
    const index = new Map(rows.map((r, i) => [r.layer.nodeId, i] as const));
    let top = Infinity, bottom = -Infinity, from = Infinity, to = -Infinity;
    for (const cell of frames) {
      const cut = cell.lastIndexOf(":");
      const row = index.get(cell.slice(0, cut) as NodeId);
      const frame = Number(cell.slice(cut + 1));
      if (row === undefined || !Number.isFinite(frame)) continue;
      top = Math.min(top, row); bottom = Math.max(bottom, row);
      from = Math.min(from, frame); to = Math.max(to, frame);
    }
    if (!Number.isFinite(top)) return null;
    return { top, bottom, from, to };
  }

  /**
   * Dragging the selection. The document is edited once, on release: the drop
   * is a cut and an overwrite over as many rows as the rectangle is tall, and
   * showing it a frame at a time would be a hundred of those. What moves under
   * the pointer is the outline `drawFrameDrop` paints.
   */
  private beginFrameDrag(e: PointerEvent, row: number, frame: number, rect: FrameRect): void {
    this.el.setPointerCapture(e.pointerId);
    const r = this.el.getBoundingClientRect();
    const height = rect.bottom - rect.top + 1;
    const rowCount = this.visibleRows().length;
    let drop: { row: number; frame: number } | null = null;
    // ⌥ anywhere during the drag copies, as it does in Flash — not only ⌥ still
    // down at the release, which is a hair's timing to ask of anyone.
    let copy = false;

    const move = (m: PointerEvent) => {
      copy = copy || m.altKey;
      const f = Math.max(0, rect.from + this.frameAtX(m.clientX - r.left) - frame);
      const y = Math.min(this.bodyBottom - 1, Math.max(this.headerHeight, m.clientY - r.top));
      // Clamped so the whole rectangle stays on existing rows: dragging frames
      // off the bottom of the stack would otherwise create layers, which no
      // frame drag in Flash does.
      const top = Math.max(0, Math.min(rowCount - height, rect.top + this.rowAtY(y) - row));
      if (drop && drop.row === top && drop.frame === f) return;
      drop = { row: top, frame: f };
      this.drop = top === rect.top && f === rect.from
        ? null
        : { top, bottom: top + height - 1, from: f, to: f + (rect.to - rect.from) };
      this.invalidate();
    };
    const up = (ev: Event) => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
      const moved = !!this.drop;
      this.drop = null;
      this.invalidate();
      if (moved && drop) this.cb.onDragFrames(drop.row, drop.frame, copy || (ev as PointerEvent).altKey);
      // A press that went nowhere is a plain click: it collapses the selection
      // onto the cell, which is what the press itself would have done.
      else if (!moved) this.cb.onSelectCell(row, frame, false);
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  private beginRangeSelect(e: PointerEvent, fromRow: number, fromFrame: number): void {
    this.el.setPointerCapture(e.pointerId);
    const r = this.el.getBoundingClientRect();
    let lastFrame = fromFrame;
    let lastRow = fromRow;
    const move = (m: PointerEvent) => {
      const frame = this.frameAtX(m.clientX - r.left);
      // Clamped, so dragging into the header or the scrollbar strip keeps the
      // rectangle on the rows rather than collapsing it.
      const rowCount = this.visibleRows().length;
      const rawRow = Math.floor(
        (Math.min(this.bodyBottom - 1, Math.max(this.headerHeight, m.clientY - r.top))
          - this.headerHeight + this.scrollY) / this.rowHeight,
      );
      const row = Math.max(0, Math.min(rowCount - 1, rawRow));
      if (frame === lastFrame && row === lastRow) return;
      lastFrame = frame;
      lastRow = row;
      this.cb.onSelectRange(
        Math.min(fromRow, row), Math.max(fromRow, row),
        Math.min(fromFrame, frame), Math.max(fromFrame, frame),
      );
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    // A pointer the browser cancels sends no pointerup; left alone, the drag's
    // interaction stayed open and swallowed the next timeline edit.
    const offCancel = on(this.el, "pointercancel", up);
  }

  setFrameWidth(px: number): void {
    const w = Math.max(4, Math.min(40, px));
    this.frameWidth = w;
    // Through the preferences, so the zoom the user settles on survives a
    // reload and the Preferences dialog shows the value they are looking at.
    this.store.prefs.set("timeline", { frameWidth: Math.round(w) });
    this.invalidate();
  }

  private beginScrub(e: PointerEvent, frame: number): void {
    this.el.setPointerCapture(e.pointerId);
    this.cb.onScrub(frame);
    const r = this.el.getBoundingClientRect();
    const move = (m: PointerEvent) => this.cb.onScrub(this.frameAtX(m.clientX - r.left));
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  private beginKeyDrag(e: PointerEvent, nodeId: NodeId, frame: number, virtual?: Track): void {
    this.el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    let lastDelta = 0;
    let started = false;
    // Every step is computed from the track as it was at pointerdown, so a
    // key the drag merely passes over is still there when it moves on.
    const base = this.store.currentAnimation?.tracks[nodeId] ?? virtual;

    const move = (m: PointerEvent) => {
      const delta = Math.round((m.clientX - startX) / this.frameWidth);
      if (delta === lastDelta) return;
      if (!started && delta !== 0) {
        started = true;
        this.cb.onBeginInteraction("timeline.move");
      }
      if (started) {
        this.cb.onMoveKeyframes(nodeId, frame, frame, delta, base);
        lastDelta = delta;
      }
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
      if (started) this.cb.onEndInteraction();
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  private beginSpanDrag(e: PointerEvent, nodeId: NodeId, endFrame: number): void {
    this.el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    let started = false;
    const move = (m: PointerEvent) => {
      const delta = Math.round((m.clientX - startX) / this.frameWidth);
      if (!started && delta === 0) return;
      if (!started) { started = true; this.cb.onBeginInteraction("timeline.span"); }
      this.cb.onDragSpanEnd(nodeId, Math.max(0, endFrame + delta));
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
      if (started) this.cb.onEndInteraction();
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  /** Keep the playhead in view while scrubbing or playing. */
  revealFrame(frame: number): void {
    const x = this.xOfFrame(frame);
    const margin = this.frameWidth * 2;
    if (x < margin) {
      this.scrollX = Math.max(0, frame * this.frameWidth - margin);
      this.invalidate();
    } else if (x > this.viewWidth - margin) {
      this.scrollX = frame * this.frameWidth - this.viewWidth + margin;
      this.invalidate();
    }
  }

  setScrollY(y: number): void {
    if (this.scrollY === y) return;
    this.scrollY = y;
    this.invalidate();
  }
}


export { spanIndexAt, describeFrame };
