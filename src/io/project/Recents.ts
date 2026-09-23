import { withStore } from "./idb";
import type { FileRef } from "./FileSystem";

/**
 * The recent-files list.
 *
 * It lives in IndexedDB rather than localStorage because the useful part of
 * an entry is the `FileSystemFileHandle`: it is structured-cloneable but not
 * stringifiable, and without it a "recent file" can only reopen the picker.
 * Permission still has to be re-requested on a later visit — the handle
 * survives, the grant does not.
 */

const KEY = "list";
const MAX = 10;

export interface RecentEntry {
  name: string;
  at: number;
  handle?: FileSystemFileHandle;
}

export async function listRecents(): Promise<RecentEntry[]> {
  try {
    const list = await withStore<RecentEntry[] | undefined>("recents", "readonly", (s) => s.get(KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];                        // private mode, blocked storage
  }
}

/** Record a file the user just opened or saved. Most recent first. */
export async function rememberRecent(ref: FileRef): Promise<RecentEntry[]> {
  const entry: RecentEntry = { name: ref.name, at: Date.now(), handle: ref.handle };
  const previous = await listRecents();
  const rest: RecentEntry[] = [];
  for (const e of previous) {
    if (await sameFile(e, entry)) continue;
    rest.push(e);
  }
  const next = [entry, ...rest].slice(0, MAX);
  try {
    await withStore("recents", "readwrite", (s) => s.put(next, KEY));
  } catch { /* ignore */ }
  return next;
}

export async function clearRecents(): Promise<void> {
  try { await withStore("recents", "readwrite", (s) => s.delete(KEY)); } catch { /* ignore */ }
}

/**
 * Two entries are the same file when their handles say so. `isSameEntry` is
 * the only honest answer — two files can share a name in different folders,
 * and the handle carries no readable path to compare instead.
 */
async function sameFile(a: RecentEntry, b: RecentEntry): Promise<boolean> {
  if (a.handle && b.handle) {
    try { return await a.handle.isSameEntry(b.handle); } catch { /* fall through */ }
  }
  if (a.handle || b.handle) return false;
  return a.name === b.name;
}
