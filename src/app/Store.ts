import type { Animation, LibraryItem, Node, Project, SymbolItem } from "@/core/doc/types";
import { isSymbol } from "@/core/doc/types";
import type { AnimId, ItemId, NodeId } from "@/core/doc/ids";
import { History } from "@/core/history/History";
import type { Command, TouchSet } from "@/core/history/Command";
import { createProject } from "@/core/doc/defaults";
import { clampFrame } from "@/core/doc/timeline";
import { onionSpan, type OnionSpan } from "@/core/doc/onion";
import { clone, invert, mat, type Matrix2D, mul } from "@/core/math/Matrix2D";
import { invalidateBounds } from "@/core/doc/pose";
import { PrefsStore } from "./Prefs";

export type ToolId =
  | "select" | "freeTransform" | "pivot" | "bone" | "ik" | "hand" | "zoom";

export interface Selection {
  nodes: NodeId[];
  items: ItemId[];
  /** Selected timeline cells, as "nodeId:frame". */
  frames: string[];
}

export interface UiState {
  tool: ToolId;
  /** Edit-in-place stack; the last entry is the symbol being edited. */
  editPath: ItemId[];
  animId: AnimId | null;
  frame: number;
  playing: boolean;
  loop: boolean;
  onionSkin: boolean;
  /** Animate's Edit Multiple Frames: a stage edit applies to every keyframe
   *  between the onion markers, not just the one at the playhead. */
  editMultipleFrames: boolean;
  /** Anchored onion markers, as absolute frames. Null = they follow the
   *  playhead at `prefs.timeline.onionBefore/After`. Session state, like the
   *  guides: a range is about the animation on screen, not the document. */
  onionAnchor: { start: number; end: number } | null;
  zoom: number;
  panX: number;
  panY: number;
  showGrid: boolean;
  showRulers: boolean;
  showGuides: boolean;
  snap: boolean;
  showBones: boolean;
  /** The reference marks on a selected node: its local axes, the artwork a
   *  bone carries, and the dashed axes of the frame its x/y are measured in.
   *  Nothing about them is stored in the document — they are derived from the
   *  pose every draw — so this is a view switch like `showBones`, and it does
   *  not touch the selection box or the Free Transform handles. */
  showGizmos: boolean;
  /** Create a keyframe at the playhead when something is transformed. */
  autoKey: boolean;
  /** Setup pose vs animation editing. Bones and IK need a bind pose, so this
   *  mode is not overhead — it is the standard skeletal-animation model. */
  mode: "setup" | "animate";
  /** The stage is showing the DragonBones runtime instead of the editable
   *  scene — Unity's Play. Nothing about the document changes; what changes
   *  is which of the two is on screen. */
  playMode: boolean;
  /**
   * What Play mode runs: the whole scene, or just the symbol being edited.
   * The scene is the default — pressing Play usually means "show me the
   * thing", and the symbol scope is the narrower question you ask while
   * authoring inside one.
   */
  previewScope: "scene" | "symbol";
}

export type ViewFlag =
  | "showGrid" | "showRulers" | "showGuides" | "snap" | "showBones" | "showGizmos";

/** Where each view switch is remembered between sessions. */
const VIEW_FLAG_PREFS: Record<ViewFlag, { cat: "stage" | "snap" | "gizmos"; key: string }> = {
  showGrid:   { cat: "stage",  key: "showGrid" },
  showRulers: { cat: "stage",  key: "showRulers" },
  showGuides: { cat: "stage",  key: "showGuides" },
  snap:       { cat: "snap",   key: "enabled" },
  showBones:  { cat: "gizmos", key: "showBones" },
  showGizmos: { cat: "gizmos", key: "showGizmos" },
};

/** The five things a drag can snap to, in the order the View submenu and the
 *  Preferences dialog list them. */
export const SNAP_TARGETS = [
  { key: "toGrid", label: "Grid" },
  { key: "toGuides", label: "Guides" },
  { key: "toObjects", label: "Objects" },
  { key: "toStage", label: "Stage Edges & Centre" },
  { key: "toPixel", label: "Whole Pixels" },
] as const;

export type SnapTargetKey = (typeof SNAP_TARGETS)[number]["key"];

export type Topic =
  | "doc" | "selection" | "ui" | "frame" | "tool" | "library"
  | "timeline" | "stage" | "playback";

type Listener = (topic: Topic) => void;

export class Store {
  project: Project;
  readonly history: History;

  selection: Selection = { nodes: [], items: [], frames: [] };
  ui: UiState = {
    tool: "select",
    editPath: [],
    animId: null,
    frame: 0,
    playing: false,
    playMode: false,
    previewScope: "scene",
    loop: true,
    onionSkin: false,
    editMultipleFrames: false,
    onionAnchor: null,
    zoom: 1,
    panX: 0,
    panY: 0,
    showGrid: false,
    showRulers: true,
    showGuides: true,
    snap: true,
    showBones: true,
    showGizmos: true,
    autoKey: true,
    mode: "animate",
  };

  private listeners = new Set<Listener>();

  /**
   * The matrix each entered instance had in its parent's space — the same one
   * the renderer draws its contents with. Editing a symbol in place has to
   * leave the artwork exactly where it was, at the same size and with the
   * same deformation, so the viewport composes these into the camera instead
   * of panning by a translation and losing the rest of the transform.
   */
  private editMatrices: Matrix2D[] = [mat()];
  /** The instance node each level was entered through, for dimming context. */
  private editNodes: Array<NodeId | null> = [null];
  /**
   * Where each ancestor's own playhead stood when it was descended out of.
   *
   * The ghosted context has to be drawn at the pose the user was looking at
   * when they double-clicked, in the mode they were in. Drawing it at
   * `frame 0` in `"setup"` — which is what it did — shows the bind pose of
   * everything around the symbol being edited: an arm that an animation moves
   * on frame 0 sits somewhere the user has never seen it, and the contents in
   * front look misaligned against a reference that is simply wrong.
   */
  private editFrames: Array<{ animId: AnimId | null; frame: number }> =
    [{ animId: null, frame: 0 }];

  /** Set by the viewport; receives the new symbol-space -> scene matrix. */
  onEditContextChange: ((base: Matrix2D) => void) | null = null;
  /** Bumped on every change; canvases compare it to skip redundant repaints. */
  epoch = 0;

  constructor(
    project: Project = createProject(),
    /** Editor preferences. Not part of the document — see `app/Prefs.ts` —
     *  but reachable from everything that already holds the Store, which is
     *  what the tools, the overlay and the timeline need. */
    readonly prefs: PrefsStore = new PrefsStore(),
  ) {
    this.project = project;

    // The View-menu toggles start where the preferences say; they stay quick
    // switches, while the preferences decide the parameters behind them.
    const p = prefs.value;
    this.ui.showGrid = p.stage.showGrid;
    this.ui.showRulers = p.stage.showRulers;
    this.ui.showGuides = p.stage.showGuides;
    this.ui.snap = p.snap.enabled;
    this.ui.showBones = p.gizmos.showBones;
    this.ui.showGizmos = p.gizmos.showGizmos;
    this.ui.editPath = [project.rootSymbolId];
    this.ui.animId = this.currentSymbol.animations[0]?.id ?? null;

    this.history = new History(
      this.project,
      {},
      () => structuredClone(this.selection),
      (s) => { this.selection = s as Selection; this.emit("selection"); },
    );
    this.history.onChange((touches) => this.onDocChanged(touches));
  }

  // ── Subscriptions ──────────────────────────────────────────────────────

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(topic: Topic): void {
    this.epoch++;
    for (const fn of this.listeners) fn(topic);
  }

  private onDocChanged(touches: TouchSet): void {
    // Undoing Convert to Symbol while inside the new symbol deletes it: step
    // out to what still exists, or the stage keeps drawing through the old
    // instance's matrix.
    const depth = validEditDepth(this.ui.editPath, this.project);
    if (depth < this.ui.editPath.length - 1) this.exitToDepth(depth);
    this.emit("doc");
    if (touches.library) this.emit("library");
    if (touches.timeline) this.emit("timeline");
    if (touches.stage || touches.nodes?.length) this.emit("stage");
    if (touches.selection) this.emit("selection");
  }

  // ── Commands ───────────────────────────────────────────────────────────

  apply(command: Command): void { this.history.apply(command); }
  transaction<T>(label: string, fn: () => T): T { return this.history.transaction(label, fn); }
  undo(): void { if (this.history.undo()) this.emit("doc"); }
  redo(): void { if (this.history.redo()) this.emit("doc"); }

  /**
   * Setup pose or animation. It decides what every drag writes — the bone's
   * rest transform or a keyframe — so it repaints the stage as well as the
   * chrome that says which mode is on.
   */
  setMode(mode: UiState["mode"]): void {
    if (this.ui.mode === mode) return;
    this.ui.mode = mode;
    this.emit("doc");
    this.emit("stage");
  }

  /** Jump to a point in the history list (see the History panel). */
  goToHistory(position: number): void {
    if (this.history.goTo(position)) this.emit("doc");
  }

  /**
   * Back to the document as it was opened.
   *
   * When every step is still in the list this is just a walk back to
   * position 0, which keeps redo alive. Once the oldest steps have been
   * trimmed there is nothing to walk back through, so the kept copy of the
   * opened document is swapped in instead — a real revert, and history starts
   * again from there.
   */
  revertToOpened(): void {
    if (this.history.reachesStart) {
      this.goToHistory(0);
      return;
    }
    this.replaceProject(structuredClone(this.history.openedProject));
  }

  /**
   * Swap in a different document — a new project, an opened file, a recovered
   * autosave. Everything derived from the old one has to go with it.
   */
  replaceProject(project: Project): void {
    // Item ids repeat between documents, and a revert keeps them all.
    invalidateBounds();
    this.project = project;
    this.history.reset(project);
    this.selection = { nodes: [], items: [], frames: [] };
    this.ui.editPath = [project.rootSymbolId];
    this.editMatrices = [mat()];
    this.editNodes = [null];
    this.editFrames = [{ animId: null, frame: 0 }];
    this.onEditContextChange?.(mat());
    this.ui.animId = this.currentSymbol.animations[0]?.id ?? null;
    this.ui.frame = 0;
    this.ui.playing = false;
    this.emit("doc");
    this.emit("library");
    this.emit("timeline");
    this.emit("selection");
  }

  // ── Derived reads ──────────────────────────────────────────────────────

  /**
   * The ancestor chain while editing a symbol in place.
   *
   * Each entry says which symbol to draw behind the one being edited, how far
   * to shift it so it lines up, and which of its nodes to leave out — that
   * node is the instance we descended into, and drawing it would double up
   * with the contents in front.
   */
  get editContext(): Array<{
    symbolId: ItemId;
    /** That level's own space -> scene space. */
    matrix: Matrix2D;
    hideNode: NodeId | null;
    /** That level's playhead when it was descended out of. */
    animId: AnimId | null;
    frame: number;
    /**
     * Whether this level should be drawn behind the one being edited. Only
     * true when it was entered through an instance on the stage: opening a
     * symbol from the library is meant to be an isolated environment.
     */
    ghost: boolean;
  }> {
    const out = [];
    let acc = mat();
    for (let i = 0; i < this.ui.editPath.length - 1; i++) {
      // Level i's own space -> scene: the instances entered down to it.
      const at = this.editFrames[i];
      out.push({
        symbolId: this.ui.editPath[i]!,
        matrix: clone(acc),
        hideNode: this.editNodes[i + 1] ?? null,
        animId: at?.animId ?? null,
        frame: at?.frame ?? 0,
        ghost: this.editNodes[i + 1] !== null,
      });
      mul(acc, acc, this.editMatrices[i + 1] ?? mat());
    }
    return out;
  }

  /** The symbol currently being edited -> scene space. */
  get editBase(): Matrix2D {
    const acc = mat();
    for (let i = 1; i < this.editMatrices.length; i++) {
      mul(acc, acc, this.editMatrices[i]!);
    }
    return acc;
  }

  /** Scene space -> the symbol currently being edited. */
  get sceneMatrix(): Matrix2D {
    const inv = mat();
    return invert(inv, this.editBase) ? inv : mat();
  }

  get currentSymbolId(): ItemId {
    return this.ui.editPath[this.ui.editPath.length - 1] ?? this.project.rootSymbolId;
  }

  get currentSymbol(): SymbolItem {
    const item = this.project.items[this.currentSymbolId];
    if (!isSymbol(item)) {
      // A deleted or corrupt edit target must not take the app down.
      const root = this.project.items[this.project.rootSymbolId];
      if (!isSymbol(root)) throw new Error("Project has no root symbol");
      this.ui.editPath = [this.project.rootSymbolId];
      this.editMatrices = [mat()];
      this.editNodes = [null];
      this.editFrames = [{ animId: null, frame: 0 }];
      return root;
    }
    return item;
  }

  get currentAnimation(): Animation | null {
    const sym = this.currentSymbol;
    return sym.animations.find((a) => a.id === this.ui.animId) ?? sym.animations[0] ?? null;
  }

  get maxFrame(): number {
    return Math.max(1, this.currentAnimation?.duration ?? 1) - 1;
  }

  /** The frames between the onion markers — also what Edit Multiple Frames
   *  edits. */
  get onionSpan(): OnionSpan {
    return onionSpan(this.ui.frame, this.maxFrame, this.prefs.value.timeline, this.ui.onionAnchor);
  }

  node(id: NodeId): Node | undefined { return this.currentSymbol.nodes[id]; }
  item(id: ItemId): LibraryItem | undefined { return this.project.items[id]; }

  get selectedNodes(): Node[] {
    const sym = this.currentSymbol;
    return this.selection.nodes.map((id) => sym.nodes[id]).filter((n): n is Node => !!n);
  }

  // ── Selection ──────────────────────────────────────────────────────────

  selectNodes(ids: NodeId[], additive = false): void {
    const next = additive
      ? Array.from(new Set([...this.selection.nodes, ...ids]))
      : [...ids];
    if (sameIds(next, this.selection.nodes)) return;
    this.selection = { ...this.selection, nodes: next };
    this.emit("selection");
  }

  toggleNode(id: NodeId): void {
    const has = this.selection.nodes.includes(id);
    this.selectNodes(has ? this.selection.nodes.filter((n) => n !== id) : [...this.selection.nodes, id]);
  }

  /**
   * Hand ⌘C / ⌘V back to the stage. They act on frames while a frame range
   * is selected (`App.copy`), and a range used to survive clicks on the
   * stage and the layer list — so copying an object right after touching
   * the timeline copied frames instead.
   */
  clearFrameSelection(): void {
    if (!this.selection.frames.length) return;
    this.selection = { ...this.selection, frames: [] };
    this.emit("selection");
  }

  clearSelection(): void {
    if (!this.selection.nodes.length && !this.selection.items.length && !this.selection.frames.length) return;
    this.selection = { nodes: [], items: [], frames: [] };
    this.emit("selection");
  }

  selectItems(ids: ItemId[]): void {
    if (sameIds(ids, this.selection.items)) return;
    this.selection = { ...this.selection, items: [...ids] };
    this.emit("selection");
  }

  // ── UI state ───────────────────────────────────────────────────────────

  /**
   * A view switch that is also a preference: Rulers, Grid, Guides, Snapping,
   * Show Bones, Show Gizmos.
   *
   * The View menu, the stage bar and the Preferences dialog all reach the
   * same state through here, so flipping one never silently disagrees with
   * another — and the choice survives a reload, which none of `ui.*` does.
   */
  setViewFlag(key: ViewFlag, on: boolean): void {
    const map = VIEW_FLAG_PREFS[key];
    this.prefs.set(map.cat, { [map.key]: on } as never);
    this.setUi({ [key]: on } as Partial<UiState>, "stage");
  }

  /**
   * Is snapping actually doing anything?
   *
   * The switch and the five targets are separate settings, and a drag with
   * every target off snaps to nothing — so the stage bar would show a lit
   * button that does nothing at all. This is what the button and the menu
   * check mark both read.
   */
  get snappingOn(): boolean {
    return this.ui.snap && SNAP_TARGETS.some((t) => this.prefs.value.snap[t.key]);
  }

  /**
   * The stage bar's button, and the View menu's Snapping row.
   *
   * Turning it off leaves the five targets exactly as they are, so turning it
   * back on restores the set the user had chosen. The one case that needs a
   * decision is "on" with nothing selected to snap to: that would be a lit
   * button that does nothing, so it turns everything back on instead.
   */
  toggleSnapping(): void {
    if (this.snappingOn) { this.setViewFlag("snap", false); return; }
    const snap = this.prefs.value.snap;
    if (!SNAP_TARGETS.some((t) => snap[t.key])) {
      this.prefs.set("snap", {
        toGrid: true, toGuides: true, toObjects: true, toStage: true, toPixel: true,
      });
    }
    this.setViewFlag("snap", true);
  }

  setSnapTarget(key: SnapTargetKey, on: boolean): void {
    this.prefs.set("snap", { [key]: on } as never);
    this.emit("stage");
  }

  // ── Onion markers ──────────────────────────────────────────────────────

  /** Anchor the markers where they are now, or let them follow the playhead
   *  again at the distances they were anchored with. */
  setOnionAnchored(on: boolean): void {
    if (on === !!this.ui.onionAnchor) return;
    if (on) {
      this.setUi({ onionAnchor: { ...this.onionSpan } }, "stage");
      return;
    }
    const span = this.onionSpan;
    this.setUi({ onionAnchor: null }, "stage");
    this.setOnionSpan(span);
  }

  /**
   * Put the markers on `span`. Anchored, that is the span itself; following,
   * it is stored as the two distances from the playhead, which is what the
   * preference holds so the next session starts with the same range.
   */
  setOnionSpan(span: OnionSpan): void {
    if (this.ui.onionAnchor) {
      this.setUi({ onionAnchor: { start: span.start, end: span.end } }, "stage");
      return;
    }
    const f = this.ui.frame;
    this.prefs.set("timeline", {
      onionBefore: Math.max(0, f - span.start),
      onionAfter: Math.max(0, span.end - f),
    });
    this.emit("stage");
  }

  setUi(patch: Partial<UiState>, topic: Topic = "ui"): void {
    const ui = this.ui as unknown as Record<string, unknown>;
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (ui[k] !== v) { ui[k] = v; changed = true; }
    }
    if (changed) this.emit(topic);
  }

  /**
   * Move the playhead. The limit is the TIMELINE's, not the animation's: the
   * grid is drawn to `MAX_FRAMES` and parking the playhead past the last
   * keyed frame is how a timeline is extended — F5 or F6 out there is what
   * grows it. Clamping to `maxFrame` here made every click past the end
   * snap back and left the empty frames unreachable.
   */
  setFrame(frame: number): void {
    const clamped = clampFrame(frame);
    if (clamped === this.ui.frame) return;
    this.ui.frame = clamped;
    this.emit("frame");
  }

  setTool(tool: ToolId): void {
    if (this.ui.tool === tool) return;
    this.ui.tool = tool;
    // Picking a skeleton tool while bones are hidden would leave the user
    // clicking at things they cannot see.
    if ((tool === "bone" || tool === "ik") && !this.ui.showBones) {
      this.ui.showBones = true;
      this.emit("stage");
    }
    this.emit("tool");
  }

  /**
   * Descend into a symbol for edit-in-place.
   *
   * `matrix` is the transform the instance being opened has in the CURRENT
   * symbol's space — the very matrix its contents are drawn with. Passing it
   * leaves the artwork on screen untouched, deformations included. Omitting
   * it (opening a symbol straight from the library, where there is no
   * instance to align with) opens the symbol in its own, undeformed space.
   */
  enterSymbol(
    id: ItemId,
    matrix: Matrix2D = mat(),
    viaNode: NodeId | null = null,
  ): void {
    if (!isSymbol(this.project.items[id])) return;
    // Freeze this level's playhead before leaving it: it is what the ghost
    // behind the symbol is drawn at.
    this.editFrames[this.ui.editPath.length - 1] =
      { animId: this.ui.animId, frame: this.ui.frame };
    this.ui.editPath = [...this.ui.editPath, id];
    this.editMatrices.push(clone(matrix));
    this.editNodes.push(viaNode);
    this.editFrames.push({ animId: null, frame: 0 });
    this.onEditContextChange?.(this.editBase);
    this.afterContextChange();
  }

  /**
   * Open a symbol from the library: an isolated environment, undeformed and
   * with nothing ghosted behind it. Unlike `enterSymbol` this does not stack
   * on top of whatever was already being edited — there is no instance
   * relating the two, so inheriting the ancestors' transform would deform the
   * contents for no reason.
   */
  openSymbol(id: ItemId): void {
    if (!isSymbol(this.project.items[id])) return;
    const root = this.project.rootSymbolId;
    this.ui.editPath = id === root ? [root] : [root, id];
    this.editMatrices = this.ui.editPath.map(() => mat());
    this.editNodes = this.ui.editPath.map(() => null);
    this.editFrames = this.ui.editPath.map(() => ({ animId: null, frame: 0 }));
    this.onEditContextChange?.(this.editBase);
    this.afterContextChange();
  }

  /** Pop to a given depth in the breadcrumb. */
  exitToDepth(depth: number): void {
    // The current level too: clicking its own breadcrumb reset the animation
    // and the playhead to whatever the level had when it was entered.
    if (depth < 0 || depth >= this.ui.editPath.length - 1) return;
    const back = this.editFrames[depth];
    this.ui.editPath = this.ui.editPath.slice(0, depth + 1);
    this.editMatrices = this.editMatrices.slice(0, depth + 1);
    this.editNodes = this.editNodes.slice(0, depth + 1);
    this.editFrames = this.editFrames.slice(0, depth + 1);
    this.onEditContextChange?.(this.editBase);
    // Coming back up lands where you left, not on frame 0: the ghost you were
    // aligning against WAS that frame, so snapping the playhead would move
    // everything the moment the symbol closed.
    this.afterContextChange(back);
  }

  private afterContextChange(restore?: { animId: AnimId | null; frame: number }): void {
    this.selection = { nodes: [], items: [], frames: [] };
    const sym = this.currentSymbol;
    const anim = restore?.animId && sym.animations.some((a) => a.id === restore.animId)
      ? restore.animId : null;
    this.ui.animId = anim ?? sym.animations[0]?.id ?? null;
    this.ui.frame = anim ? Math.max(0, restore!.frame) : 0;
    this.emit("doc");
    this.emit("selection");
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The deepest level of an edit path whose symbols all still exist. */
export function validEditDepth(path: readonly ItemId[], project: Project): number {
  const broken = path.findIndex((id) => !isSymbol(project.items[id]));
  return broken < 0 ? path.length - 1 : Math.max(0, broken - 1);
}
