import type { Store } from "@/app/Store";
import type { AssetStore } from "@/app/AssetStore";
import type { PreviewHost } from "./previewHost";
import { buildExport, type ExportResult } from "@/io/export/ExportBundle";
import type { ExtensionManifest } from "@/runtime/animo-pixi";
import { symbolBounds } from "@/core/doc/pose";
import { isSymbol } from "@/core/doc/types";

/**
 * Which armature a view wants: the whole scene, or the symbol being edited.
 *
 * They are genuinely different questions. "Is the rig right?" is asked of the
 * scene; "does the animation I am authoring inside this symbol run?" is asked
 * of the symbol, and previewing the scene for that seeks the runtime on a
 * timeline that is not the user's.
 */
export type PreviewScope = "scene" | "symbol";

export interface PreviewOptions {
  debugDraw: boolean;
  showStage: boolean;
  play: boolean;
  scope?: PreviewScope;
}

/** What one view of the runtime wants of it. */
export interface PreviewView {
  host: PreviewHost;
  /** On screen, and therefore worth loading into. */
  active(): boolean;
  options(): PreviewOptions;
  onStatus(text: string, isError?: boolean): void;
  /** Extensions in the last build, for the runtime badges. */
  onExtras?(extensions: ExtensionManifest | null): void;
}

/** An export with no artwork and no slots: there is nothing to render. */
function isEmpty(result: ExportResult): boolean {
  return result.pages.length === 0 && result.skeleton.armature.every((a) => a.slot.length === 0);
}

/**
 * One export, many runtimes.
 *
 * The preview panel and the stage's Play mode both need the project run
 * through the ACTUAL DragonBones runtime, and both must be fed the exact
 * bytes that would go to disk — that is what makes either of them ground
 * truth. What they must not do is build those bytes twice: re-packing the
 * atlas is by far the expensive half, and a drag emits dozens of document
 * changes a second.
 *
 * Each view keeps its own iframe. Sharing one would mean moving it between
 * the dock and the stage, and moving an iframe reloads it — the dock alone
 * rebuilds its DOM on every focus and every tab drag.
 */
export class PreviewSession {
  private views = new Set<PreviewView>();
  private stale = true;
  private busy = false;
  /** A refresh was asked for while a build ran; run again when it ends. */
  private rerun = false;
  private refreshTimer = 0;
  /** Animation names from the last successful load, for the transport menus. */
  private animations: string[] = [];
  private animListeners = new Set<(names: string[]) => void>();

  constructor(
    private readonly store: Store,
    private readonly assets: AssetStore,
    /** Every build's outcome: the error, or null when it succeeded. */
    private readonly onBuilt: (error: unknown) => void = () => {},
  ) {
    this.store.subscribe((topic) => {
      // Every edit goes through History, which emits "doc" first. "stage" and
      // "timeline" also come from view state — entering Play mode, a view
      // flag, folding a group — and each one rebuilt the export and restarted
      // the animation a quarter of a second after it had begun.
      if (topic === "doc" || topic === "library") {
        this.stale = true;
        if (this.hasActiveView) this.scheduleRefresh();
        return;
      }
      // While a view is paused, follow the editor's playhead: scrubbing the
      // timeline and watching the runtime agree frame by frame is the whole
      // point of having the real runtime on hand.
      if (topic === "frame") {
        for (const v of this.views) {
          if (v.active() && !v.options().play && this.followsPlayhead(v)) {
            v.host.post({ type: "seek", frame: this.store.ui.frame });
          }
        }
      }
    });
  }

  register(view: PreviewView): void {
    this.views.add(view);
    view.host.onMessage((msg) => {
      if (msg.type === "loaded") {
        this.animations = msg.animations;
        for (const fn of this.animListeners) fn(msg.animations);
      }
    });
  }

  unregister(view: PreviewView): void { this.views.delete(view); }

  onAnimations(fn: (names: string[]) => void): () => void {
    this.animListeners.add(fn);
    fn(this.animations);
    return () => this.animListeners.delete(fn);
  }

  /**
   * Whether the editor's playhead means anything to this view. A scene-scoped
   * view running the root while the user is inside a symbol is on a different
   * timeline, and seeking it to their frame would scrub something they are
   * not looking at.
   */
  followsPlayhead(view: PreviewView): boolean {
    if ((view.options().scope ?? "symbol") === "symbol") return true;
    return this.store.currentSymbolId === this.store.project.rootSymbolId;
  }

  private get hasActiveView(): boolean {
    for (const v of this.views) if (v.active()) return true;
    return false;
  }

  /** Rebuild when the document has moved on. */
  invalidate(): void {
    this.stale = true;
    if (this.hasActiveView) this.scheduleRefresh();
  }

  /** A view that has just come on screen wants whatever is current. */
  show(view: PreviewView): void {
    if (this.stale || !this.result) this.scheduleRefresh();
    else this.loadInto(view, this.result);
  }

  /**
   * `show`, without waiting for the coalescing timer. When nothing changed
   * only this view is loaded: rebuilding for everyone restarted the Preview
   * panel's animation every time Play mode was entered.
   */
  present(view: PreviewView): void {
    if (!this.stale && this.result) this.loadInto(view, this.result);
    else void this.refresh(true);
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    // Coalesce: a drag emits dozens of changes a second, and each refresh
    // re-packs the atlas.
    this.refreshTimer = window.setTimeout(() => void this.refresh(), 250);
  }

  /**
   * Build and load. `force` skips the "nothing changed" guard, which is what
   * entering Play mode and revealing the panel both need — the document may
   * be untouched but this view has never been given it.
   */
  async refresh(force = false): Promise<void> {
    clearTimeout(this.refreshTimer);
    if (this.busy) {
      // The build in flight started before this request, so what it produces
      // may already be out of date.
      this.rerun = true;
      if (this.result && force) this.loadAll(this.result);
      return;
    }
    if (!this.stale && !force) return;
    this.busy = true;
    // Cleared when the build STARTS: a change landing while it runs marks the
    // session stale again. Clearing it at the end swallowed that change, and
    // the preview stayed on the older document until the next edit.
    this.stale = false;
    this.status("Building…");
    try {
      const result = await buildExport(this.store.project, this.assets);
      reportDiagnostics(result.diagnostics);
      this.result = result;

      this.loadAll(result);
      this.onBuilt(null);
    } catch (err) {
      this.stale = true;
      this.status(err instanceof Error ? err.message : String(err), true);
      this.onBuilt(err);
    } finally {
      this.busy = false;
      if (this.rerun) {
        this.rerun = false;
        if (this.stale && this.hasActiveView) this.scheduleRefresh();
      }
    }
  }

  private result: ExportResult | null = null;

  private loadAll(result: ExportResult): void {
    for (const view of this.views) if (view.active()) this.loadInto(view, result);
  }

  private loadInto(view: PreviewView, result: ExportResult): void {
    // Nothing to show. The frame has to be told so: leaving the previous
    // load up is how a new project kept showing the old one, behind a
    // status line saying there was nothing to show.
    if (isEmpty(result)) {
      view.host.clear();
      view.onStatus("Nothing on the stage to preview yet.");
      view.onExtras?.(null);
      return;
    }

    const opts = view.options();
    const target = this.targetFor(opts.scope ?? "symbol", result);
    view.onStatus("");
    view.host.load(
      result.skeleton,
      result.pages.map((p) => ({ json: p.json, png: p.blob })),
      {
        armature: target.armature,
        animation: target.animation,
        debugDraw: opts.debugDraw,
        play: opts.play,
        frame: target.frame,
        stage: opts.showStage ? { ...this.store.project.stage } : undefined,
        fit: target.fit,
        extensions: result.extensions,
      },
    );
    view.onExtras?.(result.extensions);
  }

  /**
   * Which armature, on which timeline, at which frame.
   *
   * In `"symbol"` scope this is what is being EDITED, not the scene: the
   * playhead belongs to the open symbol, so running the root while the user
   * is inside a symbol seeks the runtime on a timeline that is not theirs —
   * an animation authored inside `eye_left` then sits at whatever frame the
   * scene's own (often one-frame) animation wraps to, and looks like it is
   * simply not happening.
   *
   * In `"scene"` scope the root runs on its own clock. The editor's playhead
   * is only handed over when the two are the same timeline; otherwise it
   * means nothing here and the scene starts at 0.
   */
  private targetFor(
    scope: PreviewScope, result: ExportResult,
  ): { armature?: string; animation?: string; frame: number; fit: { x: number; y: number; w: number; h: number } } {
    const project = this.store.project;
    const edited = this.store.currentSymbol;
    const root = project.items[project.rootSymbolId];
    const sym = scope === "scene" && root && isSymbol(root) ? root : edited;
    const here = sym.id === edited.id;

    const armature = result.skeleton.armature.some((a) => a.name === sym.name)
      ? sym.name
      : result.skeleton.armature[result.skeleton.armature.length - 1]?.name;
    const animation = here
      ? this.store.currentAnimation?.name
      : sym.animations[0]?.name;
    // The editor knows the rig's extent; Pixi cannot measure it.
    const b = symbolBounds(project, sym.id);
    return {
      armature,
      animation,
      frame: here ? this.store.ui.frame : 0,
      fit: { x: b.x, y: b.y, w: b.w, h: b.h },
    };
  }

  private status(text: string, isError = false): void {
    for (const v of this.views) if (v.active()) v.onStatus(text, isError);
  }
}

function reportDiagnostics(diags: { severity: string; message: string }[]): void {
  for (const d of diags) {
    if (d.severity === "error") console.error(`[Export] ${d.message}`);
    else console.warn(`[Export] ${d.message}`);
  }
}
