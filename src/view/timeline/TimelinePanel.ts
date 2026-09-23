import { clear, cls, drag, h, on } from "@/view/widgets/dom";
import { promptText } from "@/view/widgets/dialogs";
import { onAccelChange, withAccel } from "@/view/widgets/accel";
import { icon } from "@/view/icons";
import type { Panel } from "@/view/widgets/Dock";
import { type MenuEntry, showMenu } from "@/view/widgets/Dock";
import { attachOptionsMenu } from "./onionButton";
import type { Store } from "@/app/Store";
import type { NodeId } from "@/core/doc/ids";
import type { Keyframe, Layer, RotateDir } from "@/core/doc/types";
import { FrameGrid, ROW_HEIGHT } from "./FrameGrid";
import { LayerList } from "./LayerList";
import { Playback } from "./Playback";
import {
    doClearKeyframe,
    doClearKeyframes,
    doConvertToKeyframes,
    doInsertBlankKeyframe,
    doInsertFrame,
    doInsertFrames,
    doInsertKeyframe,
    doMoveKeyframes,
    doRemoveFrame,
    doRemoveFrames,
    doSetEndFrame,
    doSetRotation,
    doSetTween,
    easeTargets,
} from "@/app/TimelineOps";
import { EASE_PRESETS, easeLabel, sameEase, type TweenSpec } from "@/core/math/easing";
import { openEaseDialog } from "./EaseDialog";
import { FrameClipboard, type PasteMode } from "@/app/FrameClipboard";
import type { Clipboard } from "@/app/Clipboard";
import { keyIndexAt, MAX_FRAMES, spanKeyAt } from "@/core/doc/timeline";
import { promptNumber } from "@/view/widgets/promptNumber";
import { AddAnimation, RemoveAnimation, RenameAnimation, SetAnimationDuration } from "@/core/history/timelineCommands";
import { AddNode, RemoveNodes, SetLayerExcluded, SetParent } from "@/core/history/commands";
import { createLayer, createNode } from "@/core/doc/defaults";
import { groupPlan, layerRows } from "@/core/doc/layerTree";
import { evaluateSymbol } from "@/core/doc/pose";
import { mayReparent } from "@/view/widgets/ikReparentGuard";
import { uiPx } from "@/core/prefs/fonts";

/** The timeline: layer column, frame grid, transport. */
export class TimelinePanel implements Panel {
  readonly id = "timeline";
  readonly title = "Timeline";
  readonly icon = "outlinePanel" as const;
  readonly el: HTMLElement;

  readonly grid: FrameGrid;
  readonly layers: LayerList;
  readonly playback: Playback;
  readonly frames = new FrameClipboard();

  private animSelect: HTMLSelectElement;
  private frameLabel: HTMLElement;
  private elapsedLabel: HTMLElement;
  private tweenLabel: HTMLElement;
  private playBtn: HTMLButtonElement;
  private hScroll: HTMLElement;
  private hScrollInner: HTMLElement;
  /** The last `scrollX` the two ends agreed on; see `syncHScroll`. */
  private pushedScrollX = 0;
  /** What the play button currently shows, so it is only rebuilt on change. */
  private playIconState: boolean | null = null;
  private fpsLabel: HTMLElement;

  constructor(
    private readonly store: Store,
    /** Shared with the stage: copying layers and copying objects are the same
     *  clipboard object, in two separate slots. */
    private readonly clipboard: Clipboard,
    /** The onion skin's options, for press-and-hold on its buttons. */
    private readonly onionMenu: () => Array<MenuEntry | "-"> = () => [],
  ) {
    this.grid = new FrameGrid(store, {
      onScrub: (frame) => { this.playback.pause(); store.setFrame(frame); },
      onSelectCell: (row, frame, additive) => this.selectCell(row, frame, additive),
      onSelectRange: (rowFrom, rowTo, from, to) => this.selectRange(rowFrom, rowTo, from, to),
      onMoveKeyframes: (nodeId, from, to, delta, base) => doMoveKeyframes(store, nodeId, from, to, delta, base),
      onDragSpanEnd: (nodeId, endFrame) => doSetEndFrame(store, nodeId, endFrame),
      onDragFrames: (row, frame, copy) => this.dragFrames(row, frame, copy),
      onBeginInteraction: (kind) => store.history.beginInteraction(kind),
      onEndInteraction: () => store.history.endInteraction(),
      onContextMenu: (row, frame, x, y) => this.frameMenu(row, frame, x, y),
      onRulerContextMenu: (frame, x, y) => this.rulerMenu(frame, x, y),
      onWheelY: (dy) => this.layers.scrollByY(dy),
      onGeometry: () => this.syncHScroll(),
    });

    this.layers = new LayerList(store, {
      // A getter, not a number: the rows follow Interface ▸ Text, and
      // `LayerList.render` reads it again on every pass. It has to give the
      // same answer as `FrameGrid.rowHeight` or the names stop lining up
      // with their frames.
      get rowHeight() { return uiPx(ROW_HEIGHT, store.prefs.value.interface.fontSize); },
      onScrollY: (y) => this.grid.setScrollY(y),
      onContextMenu: (_nodeId, x, y) => this.layerMenu(x, y),
      onOnionOptions: (anchor) => showMenu(anchor, this.onionMenu()),
    });

    this.playback = new Playback(store, (frame) => this.grid.revealFrame(frame));

    this.fpsLabel = h("span", { class: "fps" });
    this.animSelect = h("select", { class: "tl-anim", title: "Animation" });
    this.frameLabel = h("span", { class: "cur", title: "Current frame. Click to jump to a frame." }, "1");
    on(this.frameLabel, "click", () => this.goToFrame());
    this.elapsedLabel = h("span", { class: "elapsed" }, "0.0 s");
    this.tweenLabel = h("button", { class: "tween", title: "Easing of the tween at the current frame. Click to edit it." }, "");
    on(this.tweenLabel, "pointerup", () => this.openEase());
    this.playBtn = h("button", { class: "iconbtn", title: "Play (space)" }) as HTMLButtonElement;

    this.hScrollInner = h("div");
    this.hScroll = h("div", { class: "hscroll" }, this.hScrollInner);
    this.grid.el.appendChild(this.hScroll);
    on(this.hScroll, "scroll", () => {
      this.grid.scrollX = this.hScroll.scrollLeft;
      this.pushedScrollX = this.grid.scrollX;
      this.grid.invalidate();
    });

    const splitter = h("div", { class: "splitter v" });
    let startW = 186;
    drag(splitter, {
      cursor: "ew-resize",
      onStart: () => { startW = this.layers.el.offsetWidth; splitter.classList.add("dragging"); },
      onMove: (dx) => {
        const w = Math.max(110, Math.min(400, startW + dx));
        main.style.setProperty("--tl-layers", `${w}px`);
        this.grid.invalidate();
      },
      onEnd: () => splitter.classList.remove("dragging"),
    });

    const main = h("div", { class: "tl-main" }, this.layers.el, splitter, this.grid.el);
    this.el = h("div", { class: "tl" }, main, this.buildFooter());

    store.subscribe((topic) => {
      if (topic === "doc" || topic === "timeline" || topic === "selection") {
        this.layers.render();
        this.grid.invalidate();
        this.syncAnimations();
      }
      if (topic === "frame" || topic === "playback" || topic === "stage" || topic === "doc") {
        this.grid.invalidate();
        this.syncReadout();
      }
    });

    // The text scale moves the row height on both sides of the splitter.
    store.prefs.subscribe(() => { this.layers.render(); this.grid.invalidate(); });

    this.syncAnimations();
    this.syncReadout();
  }

  onShow(): void { this.grid.invalidate(); this.layers.render(); }

  // ── Footer transport ───────────────────────────────────────────────────

  private buildFooter(): HTMLElement {
    const iconBtn = (name: Parameters<typeof icon>[0], title: string, run: () => void) => {
      const b = h("button", { class: "iconbtn", title });
      b.appendChild(icon(name, 13));
      on(b, "click", run);
      return b;
    };

    const newLayer = iconBtn("newLayer", "New layer, above the selected one", () => this.addEmptyLayer());
    const newGroup = iconBtn("newFolder", "", () => this.addGroup());
    const groupTitle = () => { newGroup.title = `${withAccel("New group", "modify.group")}, containing the selected layers`; };
    groupTitle();
    onAccelChange(groupTitle);
    const del = iconBtn("trash", "Delete layer", () => this.deleteSelectedLayers());

    clear(this.playBtn);
    this.playBtn.appendChild(icon("play", 13));
    this.playIconState = false;
    on(this.playBtn, "click", () => this.playback.toggle());

    const loopBtn = iconBtn("loop", "Loop", () => {
      this.store.setUi({ loop: !this.store.ui.loop }, "playback");
      cls(loopBtn, "on", this.store.ui.loop);
    });
    cls(loopBtn, "on", this.store.ui.loop);

    const onionBtn = iconBtn("onion", "Onion skin (hold or right-click for options)", () => {
      this.store.setUi({ onionSkin: !this.store.ui.onionSkin }, "stage");
    });
    attachOptionsMenu(onionBtn, () => showMenu(onionBtn, this.onionMenu()));
    const multiBtn = iconBtn("multiFrames", "Edit multiple frames: a change applies to every frame between the onion markers", () => {
      this.store.setUi({ editMultipleFrames: !this.store.ui.editMultipleFrames }, "stage");
    });
    // Both follow the STATE: the View menu and the layer-list button change
    // it too.
    const syncOnion = () => {
      cls(onionBtn, "on", this.store.ui.onionSkin);
      cls(multiBtn, "on", this.store.ui.editMultipleFrames);
    };
    this.store.subscribe((t) => { if (t === "stage" || t === "ui") syncOnion(); });
    syncOnion();

    on(this.animSelect, "change", () => {
      const anim = this.store.currentSymbol.animations.find((a) => a.id === this.animSelect.value);
      if (anim) {
        this.store.setUi({ animId: anim.id, frame: 0 }, "doc");
        this.store.emit("timeline");
      }
    });

    const animMenu = iconBtn("hamburger", "Animation options", () => {
      const sym = this.store.currentSymbol;
      const anim = this.store.currentAnimation;
      showMenu(animMenu, [
        { label: "New Animation", run: () => this.addAnimation() },
        { label: "Rename Animation…", enabled: !!anim, run: () => this.renameAnimation() },
        {
          label: "Delete Animation", enabled: !!anim && sym.animations.length > 1,
          run: () => {
            if (!anim) return;
            this.store.apply(new RemoveAnimation(this.store.currentSymbolId, anim.id));
            this.store.setUi({ animId: this.store.currentSymbol.animations[0]?.id ?? null }, "doc");
            this.store.emit("timeline");
          },
        },
        "-",
        { label: "Set Duration…", enabled: !!anim, run: () => this.setDuration() },
      ]);
    });

    const zoom = h("input", { type: "range", min: "4", max: "40", value: String(this.grid.frameWidth) });
    on(zoom, "input", () => this.grid.setFrameWidth(Number(zoom.value)));

    this.fpsLabel = h("span", { class: "fps" }, `${this.store.project.frameRate} fps`);

    return h("div", { class: "tl-foot" },
      newLayer, newGroup, del,
      h("div", { class: "sep-v" }),
      iconBtn("first", "First frame", () => this.playback.toStart()),
      iconBtn("prev", "Previous frame", () => this.playback.stepBy(-1)),
      this.playBtn,
      iconBtn("next", "Next frame", () => this.playback.stepBy(1)),
      iconBtn("last", "Last frame", () => this.playback.toEnd()),
      loopBtn, onionBtn, multiBtn,
      h("div", { class: "sep-v" }),
      this.animSelect, animMenu,
      h("div", { class: "readout" },
        this.frameLabel, this.fpsLabel, this.elapsedLabel, this.tweenLabel),
      h("div", { class: "spacer" }),
      h("div", { class: "tl-zoom" }, h("span", { class: "mark" }, "▁"), zoom, h("span", { class: "mark" }, "▆")),
    );
  }

  private syncReadout(): void {
    const frame = this.store.ui.frame;
    this.frameLabel.textContent = String(frame + 1);
    this.elapsedLabel.textContent = `${(frame / this.store.project.frameRate).toFixed(1)} s`;
    // The frame rate is a document setting and can change under us.
    const fps = `${this.store.project.frameRate} fps`;
    if (this.fpsLabel.textContent !== fps) this.fpsLabel.textContent = fps;

    // Only rebuild the icon when the state actually changes.
    //
    // This runs on every frame during playback. Replacing the button's child
    // SVG that often meant a real click — which spans a good 100ms between
    // pointerdown and pointerup — lost its target mid-press, so the browser
    // retargeted the click and the Pause button appeared dead. Synthetic
    // clicks worked fine, which is exactly why it survived the first pass.
    if (this.playIconState !== this.store.ui.playing) {
      this.playIconState = this.store.ui.playing;
      clear(this.playBtn);
      this.playBtn.appendChild(icon(this.store.ui.playing ? "pause" : "play", 13));
      this.playBtn.title = this.store.ui.playing ? "Pause (space)" : "Play (space)";
    }

    this.tweenLabel.textContent = this.tweenAtPlayhead();

    this.syncHScroll();
  }

  /**
   * The horizontal scrollbar is a sibling of the canvas, not the canvas's own
   * overflow, so nothing updates it implicitly. Its inner width has to follow
   * `contentWidth` — which the zoom slider changes without emitting any store
   * event, so the bar simply never appeared when the frames were widened —
   * and its thumb has to follow a `scrollX` the grid moved itself, as
   * `revealFrame` does while playing.
   */
  private syncHScroll(): void {
    const width = `${this.grid.contentWidth}px`;
    if (this.hScrollInner.style.width !== width) this.hScrollInner.style.width = width;

    // Push the thumb only when the GRID moved, never merely because the two
    // disagree. A `scroll` event is delivered asynchronously, so a draw
    // queued by something else — playback runs one every frame — can land
    // between the bar being dragged and the event arriving, and a plain
    // comparison there would shove the thumb back under the pointer.
    if (this.grid.scrollX !== this.pushedScrollX) {
      this.pushedScrollX = this.grid.scrollX;
      this.hScroll.scrollLeft = this.grid.scrollX;
    }
  }

  /**
   * The easing governing the span under the playhead on the selected layer —
   * the same thing the "in"/"out" tag on the frame grid says, spelled out.
   * Blank when the selection does not settle on one span.
   */
  private tweenAtPlayhead(): string {
    const ids = this.store.selection.nodes;
    if (ids.length !== 1) return "";
    const track = this.store.currentAnimation?.tracks[ids[0]!];
    if (!track) return "";
    const key = spanKeyAt(track, this.store.ui.frame);
    if (!key) return "";
    const overrides = key.tween.kind !== "none" && key.eases ? " *" : "";
    return easeLabel(key.tween) + overrides + rotationName(key);
  }

  private syncAnimations(): void {
    const sym = this.store.currentSymbol;
    const current = this.store.currentAnimation;
    clear(this.animSelect);
    for (const a of sym.animations) {
      this.animSelect.appendChild(h("option", { value: a.id }, a.name));
    }
    if (current) this.animSelect.value = current.id;
    this.syncReadout();
  }

  // ── Actions ────────────────────────────────────────────────────────────

  private selectCell(row: number, frame: number, additive: boolean): void {
    const layer = this.grid.visibleRows()[row]?.layer;
    if (!layer) return;
    this.playback.pause();
    this.store.selectNodes([layer.nodeId], additive);
    this.store.selection = {
      ...this.store.selection,
      frames: [`${layer.nodeId}:${frame}`],
    };
    this.store.setFrame(frame);
    this.store.emit("selection");
  }

  /**
   * A frame selection dropped somewhere else — Flash's "drag timeline frames
   * to a new location on the same layer or to a different layer". It is a move
   * unless ⌥ was held, and one undo step either way.
   */
  private dragFrames(row: number, frame: number, copy: boolean): void {
    const sel = FrameClipboard.selectionOf(this.store);
    const target = this.grid.visibleRows()[row]?.layer.nodeId;
    if (!sel || !target) return;
    this.playback.pause();
    this.frames.dragTo(this.store, sel, target, frame, copy);
  }

  /** A rectangle of cells: every frame in `from..to` on every row in range. */
  private selectRange(rowFrom: number, rowTo: number, from: number, to: number): void {
    const rows = this.grid.visibleRows();
    const frames: string[] = [];
    const nodes: NodeId[] = [];
    for (let r = rowFrom; r <= rowTo; r++) {
      const layer = rows[r]?.layer;
      if (!layer) continue;
      nodes.push(layer.nodeId);
      for (let f = from; f <= to; f++) frames.push(`${layer.nodeId}:${f}`);
    }
    if (!frames.length) return;
    this.store.selection = { ...this.store.selection, nodes, frames };
    this.store.emit("selection");
  }

  /**
   * The current frame selection as a rectangle. Cells are stored one by one,
   * but every producer writes a rectangle, so reading it back as bounds is
   * enough for the range operations.
   */
  private frameSelection(): { ids: NodeId[]; from: number; to: number } | null {
    const cells = this.store.selection.frames;
    if (cells.length < 2) return null;
    const ids: NodeId[] = [];
    let from = Infinity, to = -Infinity;
    for (const cell of cells) {
      const cut = cell.lastIndexOf(":");
      const id = cell.slice(0, cut) as NodeId;
      const f = Number(cell.slice(cut + 1));
      if (!Number.isFinite(f)) continue;
      if (!ids.includes(id)) ids.push(id);
      from = Math.min(from, f);
      to = Math.max(to, f);
    }
    if (!ids.length || to < from) return null;
    return { ids, from, to };
  }

  /**
   * Every layer of the current symbol, for the "all layers" operations —
   * including the ones folded away inside a collapsed group. Taking only the
   * visible rows shifted every other layer's keys and left those behind.
   */
  private allLayerIds(): NodeId[] {
    return layerRows(this.store.currentSymbol, true).map((r) => r.layer.nodeId);
  }

  /**
   * The layers an INSERTING F-key acts on: the selection, or every layer when
   * there is none. Flash always has exactly one current layer, so the case
   * does not arise there and the keys simply did nothing here — pressing F5
   * on a fresh scene to make room was a dead key. Only inserting takes this
   * fallback; ⇧F5 and ⇧F6 destroy content and keep needing a selection.
   */
  insertTargets(): NodeId[] {
    const sel = this.store.selection.nodes;
    return sel.length ? [...sel] : this.allLayerIds();
  }

  /**
   * Create an empty layer.
   *
   * A layer IS an object here, so an empty one needs something to hold it
   * open: an "empty" node, which carries no library item and exports as
   * nothing at all — not even a bone. Dropping a library item on it converts
   * that same node in place (`SetNodeItem`), so the layer keeps its id, its
   * name, its z-order and its mask links instead of being replaced by a
   * freshly created one somewhere else in the stack.
   */
  addEmptyLayer(): void {
    const sym = this.store.currentSymbol;
    const selected = [...this.store.selection.nodes].filter((id) => sym.nodes[id]);

    // Above the topmost selected layer, or at the very top with no selection —
    // Flash's rule, and the reason a new layer never lands out of sight.
    const at = selected.length
      ? Math.max(0, Math.min(...selected
          .map((id) => sym.layers.findIndex((l) => l.nodeId === id))
          .filter((i) => i >= 0)))
      : 0;

    const node = createNode("empty", uniqueLayerName(this.store));
    const layer = createLayer(node.id, node.name, sym.layers.length);
    this.store.apply(new AddNode("New Layer", this.store.currentSymbolId, node, layer, at));
    this.store.selectNodes([node.id]);
    this.store.emit("doc");
  }

  /**
   * Create a group.
   *
   * A group is a transform-only parent that moves its children together — as
   * distinct from an empty layer, which holds a slot in the stack open and
   * has no children. It adopts the current selection when there is one.
   */
  addGroup(): void {
    const sym = this.store.currentSymbol;
    const setup = evaluateSymbol(sym, null, 0, "setup");
    const plan = groupPlan(sym, this.store.selection.nodes, (id) => {
      const w = setup.byNode.get(id)?.world;
      return { x: w?.tx ?? 0, y: w?.ty ?? 0 };
    });
    if (!mayReparent(this.store, plan.members)) return;

    // Put the group where the selection is, so its origin is a sensible pivot,
    // above the topmost selected layer so it reads as their parent.
    const node = createNode("group", uniqueGroupName(this.store), {
      x: plan.origin.x, y: plan.origin.y, parentId: plan.parent,
    });
    const layer = createLayer(node.id, node.name, sym.layers.length);

    this.store.transaction("Group", () => {
      this.store.apply(new AddNode("Group", this.store.currentSymbolId, node, layer, plan.index));
      if (plan.members.length) {
        this.store.apply(new SetParent(this.store.currentSymbolId, plan.members, node.id));
      }
    });
    this.store.selectNodes([node.id]);
    this.store.emit("doc");
  }

  private deleteSelectedLayers(): void {
    const ids = [...this.store.selection.nodes];
    if (!ids.length) return;
    this.store.apply(new RemoveNodes(this.store.currentSymbolId, ids));
    this.store.clearSelection();
    this.store.emit("doc");
  }

  private addAnimation(): void {
    const sym = this.store.currentSymbol;
    const name = uniqueAnimationName(sym.animations.map((a) => a.name));
    const cmd = new AddAnimation(this.store.currentSymbolId, name);
    this.store.apply(cmd);
    this.store.setUi({ animId: cmd.animation.id, frame: 0 }, "doc");
    this.store.emit("timeline");
  }

  private async renameAnimation(): Promise<void> {
    const anim = this.store.currentAnimation;
    if (!anim) return;
    const symbolId = this.store.currentSymbolId;
    const name = await promptText({ title: "Rename Animation", label: "Name", value: anim.name, ok: "Rename" });
    if (!name || name === anim.name) return;
    if (!this.store.project.items[symbolId] || this.store.currentAnimation?.id !== anim.id) return;
    this.store.apply(new RenameAnimation(symbolId, anim.id, name));
    this.store.emit("timeline");
  }

  private setDuration(): void {
    const anim = this.store.currentAnimation;
    if (!anim) return;
    const symbolId = this.store.currentSymbolId;
    promptNumber({
      title: "Animation Duration", label: "Frames", value: anim.duration, min: 1, max: 100000,
      onOk: (n) => {
        if (this.store.currentAnimation?.id !== anim.id || !Number.isFinite(n) || n < 1) return;
        this.store.apply(new SetAnimationDuration(symbolId, anim.id, Math.round(n)));
        this.store.emit("timeline");
      },
    });
  }

  /** A 0×0 fixed anchor at a screen point, for `showMenu`. */
  private menuAnchor(x: number, y: number): HTMLElement {
    const anchor = h("div");
    anchor.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:0;height:0`;
    document.body.appendChild(anchor);
    setTimeout(() => anchor.remove(), 0);
    return anchor;
  }

  /**
   * The menu on a layer row.
   *
   * The layer column had no context menu at all, which left New Layer buried
   * in the footer, Select All Frames unreachable, and every layer-level
   * operation split between the menubar and a drag. This is their home.
   */
  private layerMenu(x: number, y: number): void {
    const sym = this.store.currentSymbol;
    const selected = this.store.selection.nodes.filter((id) => sym.nodes[id]);
    const layers = selected
      .map((id) => sym.layers.find((l) => l.nodeId === id))
      .filter((l): l is Layer => !!l);
    const n = layers.length;
    const plural = n > 1 ? `${n} Layers` : "Layer";
    // A mixed selection reads as "not excluded", so the toggle turns it on.
    const excluded = n > 0 && layers.every((l) => l.excludeFromExport);

    showMenu(this.menuAnchor(x, y), [
      { label: "New Layer", run: () => this.addEmptyLayer() },
      { label: "New Group", command: "modify.group", run: () => this.addGroup() },
      "-",
      { label: `Copy ${plural}`, enabled: n > 0, run: () => this.copyLayers() },
      { label: "Paste Layers", enabled: this.clipboard.hasLayers, run: () => this.pasteLayers() },
      { label: `Duplicate ${plural}`, enabled: n > 0, run: () => this.duplicateLayers() },
      { label: `Delete ${plural}`, enabled: n > 0, run: () => this.deleteSelectedLayers() },
      "-",
      { label: "Select All Frames", command: "edit.selectAllFrames", enabled: n > 0, run: () => this.selectAllFrames() },
      "-",
      {
        label: excluded ? "Include in Export" : "Exclude from Export",
        enabled: n > 0,
        checked: excluded,
        run: () => this.store.apply(new SetLayerExcluded(
          this.store.currentSymbolId, layers.map((l) => l.id), !excluded)),
      },
    ]);
  }

  /**
   * Every frame of every selected layer.
   *
   * A long animation makes the last frame a scroll away, and a range select
   * that has to reach it is a drag into the edge of the panel. The selection
   * itself needs no new state: it is the same rectangle a drag produces.
   */
  selectAllFrames(): void {
    const rows = this.grid.visibleRows();
    const selected = new Set(this.store.selection.nodes);
    const indices = rows
      .map((r, i) => (selected.has(r.layer.nodeId) ? i : -1))
      .filter((i) => i >= 0);
    if (!indices.length) return;
    const duration = this.store.currentAnimation?.duration ?? 1;
    this.selectRange(Math.min(...indices), Math.max(...indices), 0, duration - 1);
  }

  copyLayers(): number {
    const n = this.clipboard.copyLayers(this.store);
    this.store.emit("selection");
    return n;
  }

  pasteLayers(): number { return this.clipboard.pasteLayers(this.store); }
  duplicateLayers(): number { return this.clipboard.duplicateLayers(this.store); }

  /**
   * The menu on the frame ruler. There is no layer under the pointer up
   * there, so everything in it works on EVERY layer, starting at the playhead
   * — which the right-click moves, exactly as a left-click would.
   */
  private rulerMenu(frame: number, x: number, y: number): void {
    this.playback.pause();
    this.store.setFrame(frame);

    // A selection the click lands inside says how many frames and from
    // where; anywhere else the gesture itself is the answer, so the stale
    // selection goes rather than silently governing the operation.
    let range = this.frameSelection();
    if (range && (frame < range.from || frame > range.to)) {
      this.store.selection = { ...this.store.selection, frames: [] };
      this.store.emit("selection");
      range = null;
    }
    const from = range?.from ?? frame;
    const count = range ? range.to - range.from + 1 : 1;
    const ids = this.allLayerIds();
    const label = count > 1 ? `${count} Frames` : "Frame";

    showMenu(this.menuAnchor(x, y), [
      { label: `Insert ${label} (All Layers)`, command: "timeline.insertFrameAll",
        enabled: ids.length > 0,
        run: () => doInsertFrames(this.store, ids, from, count) },
      { label: `Remove ${label} (All Layers)`, command: "timeline.removeFrameAll",
        enabled: ids.length > 0,
        run: () => doRemoveFrames(this.store, ids, from, count) },
      "-",
      { label: "Convert to Keyframes (All Layers)",
        enabled: ids.length > 0,
        run: () => doConvertToKeyframes(this.store, ids, from, from + count - 1) },
      "-",
      { label: "Set Duration…", enabled: !!this.store.currentAnimation,
        run: () => this.setDuration() },
      { label: "Go to Frame…", command: "timeline.goToFrame", run: () => this.goToFrame() },
      "-",
      // The markers live on the ruler, so their options are here too.
      { label: "Onion Skin", items: this.onionMenu() },
    ]);
  }

  /**
   * Park the playhead on a frame by number, past the end of the animation
   * included — the empty frames out there are where F5 and F6 lengthen a
   * timeline, and reaching frame 400 by dragging the scrollbar is not a
   * gesture anyone should have to perform.
   */
  goToFrame(): void {
    this.playback.pause();
    promptNumber({
      title: "Go to Frame",
      label: "Frame",
      value: this.store.ui.frame + 1,
      min: 1,
      max: MAX_FRAMES,
      onOk: (v) => {
        this.store.setFrame(Math.round(v) - 1);
        this.grid.revealFrame(this.store.ui.frame);
      },
    });
  }

  private frameMenu(row: number, frame: number, x: number, y: number): void {
    const layer = this.grid.visibleRows()[row]?.layer;
    if (!layer) return;
    const nodeId = layer.nodeId;
    // Right-clicking outside the selection moves it, as in Flash; inside it,
    // the selection is what the menu acts on.
    if (!this.store.selection.frames.includes(`${nodeId}:${frame}`)) {
      this.store.selectNodes([nodeId]);
      this.store.selection = { ...this.store.selection, frames: [`${nodeId}:${frame}`] };
      this.store.emit("selection");
    }
    this.store.setFrame(frame);

    const track = this.store.currentAnimation?.tracks[nodeId];
    const onKey = !!track && keyIndexAt(track, frame) >= 0;
    const range = this.frameSelection();
    const count = range ? range.to - range.from + 1 : 1;

    const anchor = this.menuAnchor(x, y);

    // A radio group, like the Rotate submenu below: the preset the key
    // already carries is ticked.
    const keyHere = onKey ? track!.keys[keyIndexAt(track!, frame)]! : null;
    const tweenItems = [
      ...EASE_PRESETS.map((p) => ({
        label: p.label,
        enabled: onKey,
        checked: !!keyHere && sameEase(keyHere.tween, p.spec),
        run: () => this.applyTween(nodeId, frame, p.spec),
      })),
      { label: "Ease…", enabled: easeTargets(this.store).length > 0, run: () => this.openEase() },
    ];

    const sel = FrameClipboard.selectionOf(this.store);
    const runLabel = sel && sel.to > sel.from ? `${sel.to - sel.from + 1} Frames` : "Frame";

    // With a range selected the frame operations work on it; otherwise they
    // keep their single-cell meaning.
    const frameItems = range
      ? [
        { label: `Insert ${count} Frames`, command: "timeline.insertFrame",
          run: () => doInsertFrames(this.store, range.ids, range.from, count) },
        { label: `Remove ${count} Frames`, command: "timeline.removeFrame",
          run: () => doRemoveFrames(this.store, range.ids, range.from, count) },
        "-" as const,
        { label: "Convert to Keyframes", command: "timeline.insertKeyframe",
          run: () => doConvertToKeyframes(this.store, range.ids, range.from, range.to) },
        { label: "Insert Blank Keyframe", command: "timeline.insertBlankKeyframe",
          run: () => doInsertBlankKeyframe(this.store, frame) },
        { label: "Clear Keyframes", command: "timeline.clearKeyframe",
          run: () => doClearKeyframes(this.store, range.ids, range.from, range.to) },
      ]
      : [
        { label: "Insert Frame", command: "timeline.insertFrame", run: () => doInsertFrame(this.store, frame) },
        { label: "Remove Frame", command: "timeline.removeFrame", run: () => doRemoveFrame(this.store, frame) },
        "-" as const,
        { label: "Insert Keyframe", command: "timeline.insertKeyframe", run: () => doInsertKeyframe(this.store, frame) },
        { label: "Insert Blank Keyframe", command: "timeline.insertBlankKeyframe", run: () => doInsertBlankKeyframe(this.store, frame) },
        { label: "Clear Keyframe", command: "timeline.clearKeyframe", enabled: onKey, run: () => doClearKeyframe(this.store, frame) },
      ];

    // The "all layers" pair only earns its place when it would reach layers
    // the items above do not: with every layer already in the selection the
    // two would do exactly the same thing, which just reads as a puzzle.
    const allIds = this.allLayerIds();
    const targetCount = range ? range.ids.length : this.store.selection.nodes.length || 1;
    const allLayerItems = allIds.length > targetCount
      ? [
        { label: count > 1 ? `Insert ${count} Frames (All Layers)` : "Insert Frame (All Layers)",
          run: () => doInsertFrames(this.store, allIds, range?.from ?? frame, count) },
        { label: count > 1 ? `Remove ${count} Frames (All Layers)` : "Remove Frame (All Layers)",
          run: () => doRemoveFrames(this.store, allIds, range?.from ?? frame, count) },
        "-" as const,
      ]
      : [];

    showMenu(anchor, [
      ...frameItems,
      "-",
      ...allLayerItems,
      { label: `Copy ${runLabel}`, command: "edit.copy", run: () => this.copyFrames() },
      { label: `Cut ${runLabel}`, command: "edit.cut", run: () => this.frames.cut(this.store) },
      {
        label: this.frames.hasContent ? `Paste ${this.frames.span} Frame(s)` : "Paste Frames",
        command: "edit.paste",
        enabled: this.frames.hasContent,
        run: () => this.frames.paste(this.store, nodeId, frame),
      },
      {
        label: "Paste and Overwrite Frames",
        command: "edit.pasteOverwriteFrames",
        enabled: this.frames.hasContent,
        run: () => this.frames.paste(this.store, nodeId, frame, "overwrite"),
      },
      "-",
      ...tweenItems,
      "-",
      this.rotationMenu(nodeId, frame, keyHere),
    ]);
  }

  /**
   * Which way the tween leaving this keyframe turns — Flash's Rotate: Auto /
   * CW / CCW ×N. Without it the only way to reverse a spin was to retype the
   * angle 360° away, and the Properties panel shows the angle, not the path.
   */
  private rotationMenu(nodeId: NodeId, frame: number, key: Keyframe | null) {
    const dir = key?.rotateDir ?? null;
    const turns = Math.abs(key?.rotateTurns ?? 0);
    const set = (d: RotateDir | null, t: number) => doSetRotation(this.store, nodeId, frame, d, t);
    return {
      label: "Rotate",
      enabled: !!key,
      items: [
        { label: "As Keyed", checked: !dir && !turns, run: () => set(null, 0) },
        { label: "Clockwise", checked: dir === "cw", run: () => set("cw", turns) },
        { label: "Counter-clockwise", checked: dir === "ccw", run: () => set("ccw", turns) },
        "-" as const,
        {
          label: turns ? `Extra Turns: ${turns}…` : "Extra Turns…",
          run: () => promptNumber({
            title: "Extra Turns",
            label: "Turns",
            value: turns,
            min: 0,
            max: 100,
            onOk: (v) => set(dir, v),
          }),
        },
      ],
    };
  }

  /**
   * F5 / ⇧F5 / F6 / ⇧F6 with a frame selection: the keys act on the whole
   * rectangle. Returns false when there is nothing selected, so the caller
   * falls back to the single-frame behaviour.
   */
  applyRangeOp(op: "insert" | "remove" | "keyframes" | "clear"): boolean {
    const range = this.frameSelection();
    if (!range) return false;
    const count = range.to - range.from + 1;
    if (op === "insert") doInsertFrames(this.store, range.ids, range.from, count);
    else if (op === "remove") doRemoveFrames(this.store, range.ids, range.from, count);
    else if (op === "keyframes") doConvertToKeyframes(this.store, range.ids, range.from, range.to);
    else doClearKeyframes(this.store, range.ids, range.from, range.to);
    return true;
  }

  /** Insert or remove one frame on every layer, at the playhead. */
  allLayersFrameOp(op: "insert" | "remove"): void {
    const range = this.frameSelection();
    const from = range?.from ?? this.store.ui.frame;
    const count = range ? range.to - range.from + 1 : 1;
    const ids = this.allLayerIds();
    if (op === "insert") doInsertFrames(this.store, ids, from, count);
    else doRemoveFrames(this.store, ids, from, count);
  }

  private applyTween(nodeId: NodeId, frame: number, spec: TweenSpec): void {
    doSetTween(this.store, nodeId, frame, spec);
  }

  /** The Ease panel, on the spans under the frame selection or the playhead. */
  openEase(): void {
    const targets = easeTargets(this.store);
    if (!targets.length) return;
    this.playback.pause();
    openEaseDialog(this.store, targets);
  }

  /** True when the timeline owns the current selection, so ⌘C should copy
   *  frames rather than stage objects. */
  get hasFrameSelection(): boolean {
    return FrameClipboard.selectionOf(this.store) !== null;
  }

  copyFrames(): number { return this.frames.copy(this.store); }
  cutFrames(): number { return this.frames.cut(this.store); }
  pasteFrames(mode: PasteMode = "insert"): number {
    return this.frames.paste(this.store, undefined, undefined, mode);
  }

  dispose(): void { this.playback.dispose(); }
}

function uniqueLayerName(store: Store): string {
  const taken = new Set(store.currentSymbol.layers.map((l) => l.name));
  for (let i = 1; ; i++) {
    const name = `Layer ${i}`;
    if (!taken.has(name)) return name;
  }
}

function uniqueGroupName(store: Store): string {
  const taken = new Set(store.currentSymbol.layers.map((l) => l.name));
  for (let i = 1; ; i++) {
    const name = `Group ${i}`;
    if (!taken.has(name)) return name;
  }
}

function uniqueAnimationName(taken: string[]): string {
  const set = new Set(taken);
  for (let i = 1; ; i++) {
    const name = `animation${i === 1 ? "" : `_${i}`}`;
    if (!set.has(name)) return name;
  }
}

function rotationName(key: Keyframe): string {
  const turns = Math.abs(key.rotateTurns ?? 0);
  if (!key.rotateDir) return turns ? ` · ${key.rotateTurns! > 0 ? "CW" : "CCW"} +${turns}` : "";
  return ` · ${key.rotateDir === "cw" ? "CW" : "CCW"}${turns ? ` +${turns}` : ""}`;
}

