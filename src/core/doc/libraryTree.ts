import type { FolderId, ItemId } from "./ids";
import type { LibraryFolder, LibraryItem, Project } from "./types";

/**
 * The library as a tree of folders, flattened into the rows the panel shows.
 * Pure: the panel, the keyboard and the delete rules all read it, and the
 * tests read it without a DOM.
 *
 * Folders are organisation only. Item names stay unique across the whole
 * library (the runtime finds textures and armatures by name), whatever
 * folder they sit in.
 */

export type LibraryRow =
  | { kind: "folder"; id: FolderId; name: string; depth: number; open: boolean; empty: boolean }
  | { kind: "item"; id: ItemId; name: string; depth: number; item: LibraryItem };

export interface RowOptions {
  /** Folders the user closed. Ignored while filtering: every match shows. */
  collapsed: ReadonlySet<FolderId>;
  /** Lower-case search text; "" shows everything. */
  filter: string;
  sortDir: 1 | -1;
}

/** "folder:f1" / "item:i3": one key space for both kinds of row. */
export function rowKey(row: { kind: "folder" | "item"; id: string }): string {
  return `${row.kind}:${row.id}`;
}

/** The folder an item or folder lives in, or null at the top level. A link to
 *  a folder that does not exist counts as the top level. */
export function parentFolder(p: Project, entry: LibraryItem | LibraryFolder): FolderId | null {
  const id = "kind" in entry ? entry.folderId : entry.parentId;
  return id && p.folders[id] ? id : null;
}

export function libraryRows(p: Project, opts: RowOptions): LibraryRow[] {
  const folders = Object.values(p.folders);
  const items = p.itemOrder
    .map((id) => p.items[id])
    .filter((i): i is LibraryItem => !!i && i.id !== p.rootSymbolId);

  const childFolders = new Map<FolderId | null, LibraryFolder[]>();
  for (const f of folders) push(childFolders, parentFolder(p, f), f);
  const childItems = new Map<FolderId | null, LibraryItem[]>();
  for (const i of items) push(childItems, parentFolder(p, i), i);

  // `numeric` so leg_2 sorts before leg_10, which is how rigs are named.
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }) * opts.sortDir;

  const filtering = opts.filter !== "";
  const matches = (name: string) => name.toLowerCase().includes(opts.filter);
  // While filtering: an item shows when it matches or a folder above it does;
  // a folder shows when it matches or holds something that shows.
  const shows = new Map<FolderId, boolean>();
  const folderShows = (f: LibraryFolder, ancestorMatched: boolean, seen: Set<FolderId>): boolean => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    const self = ancestorMatched || matches(f.name);
    let any = self;
    for (const c of childFolders.get(f.id) ?? []) any = folderShows(c, self, seen) || any;
    for (const i of childItems.get(f.id) ?? []) any = self || matches(i.name) || any;
    shows.set(f.id, any);
    return any;
  };
  if (filtering) for (const f of childFolders.get(null) ?? []) folderShows(f, false, new Set());

  const rows: LibraryRow[] = [];
  const walk = (parent: FolderId | null, depth: number, ancestorMatched: boolean, seen: Set<FolderId>) => {
    for (const f of [...(childFolders.get(parent) ?? [])].sort(byName)) {
      if (seen.has(f.id)) continue;                 // a loop the schema did not catch
      if (filtering && !shows.get(f.id)) continue;
      const open = filtering || !opts.collapsed.has(f.id);
      const empty = !(childFolders.get(f.id)?.length || childItems.get(f.id)?.length);
      rows.push({ kind: "folder", id: f.id, name: f.name, depth, open, empty });
      if (open) walk(f.id, depth + 1, ancestorMatched || (filtering && matches(f.name)), new Set([...seen, f.id]));
    }
    for (const i of [...(childItems.get(parent) ?? [])].sort(byName)) {
      if (filtering && !ancestorMatched && !matches(i.name)) continue;
      rows.push({ kind: "item", id: i.id, name: i.name, depth, item: i });
    }
  };
  walk(null, 0, false, new Set());
  return rows;
}

/** The row `delta` steps from `key`, clamped to the list; the first row when
 *  nothing is current. Null only for an empty list. */
export function stepRow(rows: readonly LibraryRow[], key: string | null, delta: number): LibraryRow | null {
  if (rows.length === 0) return null;
  const at = key === null ? -1 : rows.findIndex((r) => rowKey(r) === key);
  if (at < 0) return delta < 0 ? rows[rows.length - 1]! : rows[0]!;
  return rows[Math.max(0, Math.min(rows.length - 1, at + delta))]!;
}

/** A folder and every folder inside it, at any depth. */
export function folderSubtree(p: Project, id: FolderId): Set<FolderId> {
  const out = new Set<FolderId>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of Object.values(p.folders)) {
      const parent = parentFolder(p, f);
      if (parent && out.has(parent) && !out.has(f.id)) { out.add(f.id); grew = true; }
    }
  }
  return out;
}

/** Whether `folder` may move into `into`: not into itself or its own inside. */
export function canMoveFolder(p: Project, folder: FolderId, into: FolderId | null): boolean {
  return into === null || !folderSubtree(p, folder).has(into);
}

/** Whether a sibling in `parent` already uses `name`. */
export function folderNameTaken(p: Project, parent: FolderId | null, name: string, except?: FolderId): boolean {
  return Object.values(p.folders)
    .some((f) => f.id !== except && parentFolder(p, f) === parent && f.name === name);
}

/** "untitled folder", then "untitled folder 2"… among the siblings in `parent`. */
export function uniqueFolderName(p: Project, parent: FolderId | null, base = "untitled folder"): string {
  if (!folderNameTaken(p, parent, base)) return base;
  for (let n = 2; ; n++) if (!folderNameTaken(p, parent, `${base} ${n}`)) return `${base} ${n}`;
}

export interface DeletePlan {
  /** Every item that goes, folders' contents included. */
  items: ItemId[];
  /** Every folder that goes, deepest first so a revert rebuilds parents first
   *  when it runs in reverse. */
  folders: FolderId[];
  /** Items placed somewhere: while there are any, nothing is deleted. */
  inUse: ItemId[];
}

/** What deleting these entries takes with it, and what stops it. */
export function deletePlan(
  p: Project, items: readonly ItemId[], folders: readonly FolderId[], usage: ReadonlyMap<ItemId, number>,
): DeletePlan {
  const allFolders = new Set<FolderId>();
  for (const f of folders) if (p.folders[f]) for (const id of folderSubtree(p, f)) allFolders.add(id);
  const allItems = new Set<ItemId>(items.filter((id) => p.items[id] && id !== p.rootSymbolId));
  for (const i of Object.values(p.items)) {
    const parent = parentFolder(p, i);
    if (parent && allFolders.has(parent) && i.id !== p.rootSymbolId) allItems.add(i.id);
  }
  const depth = (id: FolderId): number => {
    let d = 0;
    for (let f: FolderId | null = id; f && d < 1000; f = parentFolder(p, p.folders[f]!)) d++;
    return d;
  };
  return {
    items: [...allItems],
    folders: [...allFolders].sort((a, b) => depth(b) - depth(a)),
    inUse: [...allItems].filter((id) => (usage.get(id) ?? 0) > 0),
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}
