import type { Project } from "@/core/doc/types";
import type { ItemId, NodeId } from "@/core/doc/ids";

/**
 * What a command changed. Consumers use it to invalidate exactly what needs
 * invalidating — symbol bounds caches, library thumbnails, tinted-bitmap
 * caches, timeline repaint regions — instead of re-deriving it by diffing.
 * Getting change DESCRIPTIONS for free is the main reason this is a command
 * system rather than a snapshot or patch system.
 */
export interface TouchSet {
  symbols?: ItemId[];
  nodes?: NodeId[];
  library?: boolean;
  stage?: boolean;
  timeline?: boolean;
  selection?: boolean;
}

export interface Command {
  /** Shown as "Undo <label>". */
  readonly label: string;
  /** Merge eligibility during an interaction; see History.beginInteraction. */
  readonly kind: string;
  readonly touches: TouchSet;
  /** Must be a pure function of (project, payload). Never read UI state. */
  apply(project: Project): void;
  revert(project: Project): void;
  /** Fold a same-kind follow-up into this command; return false to refuse. */
  mergeWith?(next: Command): boolean;
  estimateSize?(): number;
}

/**
 * Fold a follow-up step's `before` into a merged command. An id only the later
 * step touched was still untouched when that step ran, so its value there is
 * the original, and undo has to put it back. Returns the ids it added.
 */
export function adoptBefore<K, V>(into: Map<K, V>, from: ReadonlyMap<K, V>): K[] {
  const added: K[] = [];
  for (const [id, v] of from) {
    if (into.has(id)) continue;
    into.set(id, v);
    added.push(id);
  }
  return added;
}

export function mergeTouches(a: TouchSet, b: TouchSet): TouchSet {
  const uniq = <T,>(x?: T[], y?: T[]) =>
    x || y ? Array.from(new Set([...(x ?? []), ...(y ?? [])])) : undefined;
  return {
    symbols: uniq(a.symbols, b.symbols),
    nodes: uniq(a.nodes, b.nodes),
    library: a.library || b.library || undefined,
    stage: a.stage || b.stage || undefined,
    timeline: a.timeline || b.timeline || undefined,
    selection: a.selection || b.selection || undefined,
  };
}

/** Several commands undone and redone as one entry. */
export class CompositeCommand implements Command {
  readonly kind = "composite";
  constructor(
    readonly label: string,
    private readonly parts: Command[],
  ) {}

  get touches(): TouchSet {
    return this.parts.reduce<TouchSet>((acc, c) => mergeTouches(acc, c.touches), {});
  }

  apply(p: Project): void {
    for (const c of this.parts) c.apply(p);
  }

  revert(p: Project): void {
    for (let i = this.parts.length - 1; i >= 0; i--) this.parts[i]!.revert(p);
  }

  estimateSize(): number {
    return this.parts.reduce((n, c) => n + (c.estimateSize?.() ?? 64), 0);
  }

  get size(): number { return this.parts.length; }
}

/**
 * The generic escape hatch: snapshot a whole subtree. Correct for any
 * mutation, at the cost of memory, so it is for operations whose precise
 * inverse would be more code than it is worth (e.g. "distribute to layers").
 */
export class SnapshotCommand implements Command {
  readonly kind = "snapshot";
  private before: string | null = null;

  constructor(
    readonly label: string,
    readonly touches: TouchSet,
    private readonly read: (p: Project) => unknown,
    private readonly write: (p: Project, value: unknown) => void,
    private readonly mutate: (p: Project) => void,
  ) {}

  apply(p: Project): void {
    if (this.before === null) this.before = JSON.stringify(this.read(p));
    this.mutate(p);
  }

  revert(p: Project): void {
    if (this.before !== null) this.write(p, JSON.parse(this.before));
  }

  estimateSize(): number { return (this.before?.length ?? 0) * 2; }
}
