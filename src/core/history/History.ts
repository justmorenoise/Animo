import type { Project } from "@/core/doc/types";
import { freezeValues, valueFreeze } from "@/core/doc/freeze";
import { type Command, CompositeCommand, mergeTouches, type TouchSet } from "./Command";

export interface HistoryEntry {
  command: Command;
  selectionBefore: unknown;
  selectionAfter: unknown;
}

export interface HistoryOptions {
  maxEntries?: number;
  maxBytes?: number;
}

export type HistoryListener = (touches: TouchSet, reason: "apply" | "undo" | "redo") => void;

/** Steps the history keeps whatever the byte budget says. */
export const MIN_ENTRIES = 20;

/**
 * Undo/redo over a mutable Project.
 *
 * Two rules keep this safe, and both are worth stating out loud because the
 * whole design leans on them:
 *   1. Only History holds a mutable reference to the Project. Everyone else
 *      reads it through the Store as readonly.
 *   2. Structural deletes keep the removed objects alive INSIDE the command,
 *      and ids are never remapped, so redo and any later command still
 *      resolve their references.
 */
export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners: Set<HistoryListener> = new Set<HistoryListener>();

  private txDepth = 0;
  private txLabel = "";
  private txParts: Command[] = [];
  private txTouches: TouchSet | null = null;

  private interactionKind: string | null = null;
  private interactionEntry: HistoryEntry | null = null;
  /** Bumped by every `beginInteraction`, so a caller can tell one drag from
   *  the next and keep state captured at its pointer-down. */
  interactionSerial = 0;

  get inInteraction(): boolean { return this.interactionKind !== null; }

  private savedAt = 0;
  private changes = 0;
  /** True once any step has been dropped, so position 0 is no longer the
   *  document as it was opened. */
  private trimmed = false;
  /** The document as opened, kept for Revert; never overwritten by editing. */
  private opened: Project;

  constructor(
    private project: Project,
    private readonly opts: HistoryOptions = {},
    /** Supplies the current selection so it can be restored with an undo.
     *  Selection is not itself undoable, but it is restored — matching Flash. */
    private readonly readSelection: () => unknown = () => null,
    private readonly writeSelection: (s: unknown) => void = () => {},
  ) {
    this.opened = structuredClone(project);
    this.settle();
  }

  onChange(fn: HistoryListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(touches: TouchSet, reason: "apply" | "undo" | "redo"): void {
    for (const fn of this.listeners) fn(touches, reason);
  }

  /** Mutable access, for commands only. */
  get doc(): Project { return this.project; }

  // ── Applying ───────────────────────────────────────────────────────────

  apply(command: Command): void {
    if (this.txDepth > 0) {
      command.apply(this.project);
      this.settle();
      this.txParts.push(command);
      // Listeners hear the transaction once, when it closes: a PSD import
      // applies dozens of commands, and redrawing after each froze the page.
      this.txTouches = mergeTouches(this.txTouches ?? {}, command.touches);
      return;
    }

    const selectionBefore = this.readSelection();
    command.apply(this.project);
    this.settle();

    // Inside an interaction, fold same-kind commands into the open entry so a
    // 60fps drag lands in history as a single undo step.
    //
    // The test is against the kind of the entry ALREADY OPEN, not against the
    // string `beginInteraction` was given: which command a drag ends up
    // emitting depends on the mode it runs in — a stage drag writes
    // `SetBindTransform` ("node.transform") in Setup mode and `EditTracks`
    // ("timeline.transform") in Animate mode — and comparing against the
    // tool's own label silently stopped merging in one of the two, leaving a
    // hundred undo steps behind a single 100px drag.
    if (
      this.interactionKind !== null &&
      this.interactionEntry !== null &&
      command.kind === this.interactionEntry.command.kind &&
      this.interactionEntry.command.mergeWith?.(command)
    ) {
      this.interactionEntry.selectionAfter = this.readSelection();
      this.emit(command.touches, "apply");
      return;
    }

    const entry: HistoryEntry = {
      command,
      selectionBefore,
      selectionAfter: this.readSelection(),
    };
    this.push(entry);
    if (this.interactionKind !== null) this.interactionEntry = entry;
    this.emit(command.touches, "apply");
  }

  private push(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    this.redoStack.length = 0;
    // The saved state was at or past the entry just replaced, and redo is
    // gone: nothing can take the document back to it. `>` alone missed the
    // common case — save, undo, edit — and showed the new state as saved.
    if (this.savedAt >= this.undoStack.length) this.savedAt = -1;
    this.trim();
  }

  private trim(): void {
    // A floor the byte cap cannot go under either: the History panel promises
    // at least this many steps back, and one fat command (a big paste) must
    // not be able to swallow the whole list.
    const floor = Math.max(MIN_ENTRIES, 0);
    const maxEntries = Math.max(floor, this.opts.maxEntries ?? 200);
    const maxBytes = this.opts.maxBytes ?? 64 * 1024 * 1024;
    while (this.undoStack.length > maxEntries) {
      this.dropOldest();
    }
    let bytes = 0;
    for (const e of this.undoStack) bytes += e.command.estimateSize?.() ?? 64;
    while (bytes > maxBytes && this.undoStack.length > floor) {
      bytes -= this.undoStack[0]!.command.estimateSize?.() ?? 64;
      this.dropOldest();
    }
  }

  /** Forget the oldest step. The document as opened stays reachable through
   *  `openedProject`, which is what "Revert" restores. */
  private dropOldest(): void {
    this.undoStack.shift();
    this.trimmed = true;
    if (this.savedAt >= 0) this.savedAt--;
  }

  // ── Transactions ───────────────────────────────────────────────────────

  /** Group everything `fn` applies into one undo entry. Nesting flattens. */
  transaction<T>(label: string, fn: () => T): T {
    const outermost = this.txDepth === 0;
    if (outermost) { this.txLabel = label; this.txParts = []; }
    this.txDepth++;
    try {
      return fn();
    } finally {
      this.txDepth--;
      if (this.txDepth === 0) {
        const parts = this.txParts;
        this.txParts = [];
        if (parts.length === 1) {
          this.push({
            command: parts[0]!,
            selectionBefore: this.readSelection(),
            selectionAfter: this.readSelection(),
          });
        } else if (parts.length > 1) {
          this.push({
            command: new CompositeCommand(this.txLabel, parts),
            selectionBefore: this.readSelection(),
            selectionAfter: this.readSelection(),
          });
        }
        const touches = this.txTouches;
        this.txTouches = null;
        if (touches) this.emit(touches, "apply");
      }
    }
  }

  // ── Interactions (drags) ───────────────────────────────────────────────

  /**
   * Open an interaction (a drag). `kind` is descriptive: what actually merges
   * is decided by the commands themselves — the first one applied opens the
   * entry, and later commands of the same kind fold into it.
   */
  beginInteraction(kind: string): void {
    this.interactionSerial++;
    this.interactionKind = kind;
    this.interactionEntry = null;
  }

  endInteraction(): void {
    this.interactionKind = null;
    this.interactionEntry = null;
  }

  /** Escape during a drag: revert everything it did and drop the entry. */
  abortInteraction(): void {
    const entry = this.interactionEntry;
    this.interactionKind = null;
    this.interactionEntry = null;
    if (!entry) return;
    const idx = this.undoStack.lastIndexOf(entry);
    if (idx < 0) return;
    entry.command.revert(this.project);
    this.settle();
    this.undoStack.splice(idx, 1);
    this.writeSelection(entry.selectionBefore);
    this.emit(entry.command.touches, "undo");
  }

  // ── Undo / redo ────────────────────────────────────────────────────────

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.command.label ?? null;
  }
  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.command.label ?? null;
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    entry.command.revert(this.project);
    this.settle();
    this.redoStack.push(entry);
    this.writeSelection(entry.selectionBefore);
    this.emit(mergeTouches(entry.command.touches, { selection: true }), "undo");
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    entry.command.apply(this.project);
    this.settle();
    this.undoStack.push(entry);
    this.writeSelection(entry.selectionAfter);
    this.emit(mergeTouches(entry.command.touches, { selection: true }), "redo");
    return true;
  }

  // ── The list, for a History panel ──────────────────────────────────────

  /**
   * Every step, oldest first: those already applied followed by the ones
   * `redo` would replay. `position` is how many of them are applied, so
   * position 0 is the document before the first step.
   */
  get entries(): ReadonlyArray<{ label: string; kind: string }> {
    const out = this.undoStack.map((e) => ({ label: e.command.label, kind: e.command.kind }));
    for (let i = this.redoStack.length - 1; i >= 0; i--) {
      const e = this.redoStack[i]!;
      out.push({ label: e.command.label, kind: e.command.kind });
    }
    return out;
  }

  get position(): number { return this.undoStack.length; }

  /** Whether position 0 really is the document as opened. */
  get reachesStart(): boolean { return !this.trimmed; }

  /** The document as it was opened — the target of a Revert. */
  get openedProject(): Project { return this.opened; }

  /**
   * Travel to a point in the list. Undo and redo the whole way there rather
   * than jumping: every command's inverse is exact, and replaying them keeps
   * the caches and listeners in step.
   */
  goTo(position: number): boolean {
    const target = Math.max(0, Math.min(this.entries.length, Math.round(position)));
    if (target === this.position) return false;
    let touches: TouchSet = { selection: true };
    const reason: "undo" | "redo" = target < this.position ? "undo" : "redo";
    // Step without emitting, then tell everyone once: a ten-step jump should
    // repaint the stage once, not ten times.
    const silent = this.listeners;
    this.listeners = new Set();
    try {
      while (this.position > target) {
        const entry = this.undoStack[this.undoStack.length - 1];
        if (!entry || !this.undo()) break;
        touches = mergeTouches(touches, entry.command.touches);
      }
      while (this.position < target) {
        const entry = this.redoStack[this.redoStack.length - 1];
        if (!entry || !this.redo()) break;
        touches = mergeTouches(touches, entry.command.touches);
      }
    } finally {
      this.listeners = silent;
    }
    this.emit(touches, reason);
    return true;
  }

  // ── Dirty tracking ─────────────────────────────────────────────────────

  markSaved(): void { this.savedAt = this.undoStack.length; }
  /** Unsaved with no step to show for it — a recovered autosave. */
  markDirty(): void { this.savedAt = -1; }
  get isDirty(): boolean { return this.savedAt !== this.undoStack.length; }
  /** Moves on every change to the document — apply, merge, undo, redo, reset.
   *  An async save compares it before and after writing: an edit made while
   *  the file was being written is not in the file. */
  get revision(): number { return this.changes; }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.savedAt = 0;
    this.trimmed = false;
  }

  /**
   * Point history at a different document.
   *
   * The stacks MUST be dropped: every command holds references into the old
   * object graph, so undoing one against a freshly loaded project would write
   * into objects nothing else can see.
   */
  reset(project: Project): void {
    this.project = project;
    this.opened = structuredClone(project);
    this.trimmed = false;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.interactionKind = null;
    this.interactionEntry = null;
    this.txDepth = 0;
    this.txParts = [];
    this.savedAt = 0;
    this.settle();
  }

  /** See `core/doc/freeze.ts`: after every change, so the next command
   *  cannot write into a value an undo step still holds. */
  private settle(): void {
    this.changes++;
    if (valueFreeze.enabled) freezeValues(this.project);
  }
}
