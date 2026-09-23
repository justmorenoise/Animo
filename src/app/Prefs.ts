import { DEFAULT_PREFS, mergePrefs, type Prefs, type PrefsCategory, resetCategory, } from "@/core/prefs/prefs";

const KEY = "animo.prefs";

/**
 * The live preferences, backed by localStorage.
 *
 * localStorage rather than the document: these are the editor's own settings,
 * they follow the user across projects, and a colour tweak must not dirty a
 * `.animo`. The read/write pattern — one `animo.*` key, every access wrapped —
 * is the one the dock layout and the library sort order already use.
 */
export class PrefsStore {
  private prefs: Prefs = load();
  private listeners = new Set<(p: Prefs) => void>();

  get value(): Prefs { return this.prefs; }

  set<K extends PrefsCategory>(cat: K, patch: Partial<Prefs[K]>): void {
    const next = { ...this.prefs[cat], ...patch };
    this.prefs = { ...this.prefs, [cat]: next };
    this.commit();
  }

  /** Replace a category wholesale — `set` merges, so it cannot drop a key. */
  replace<K extends PrefsCategory>(cat: K, value: Prefs[K]): void {
    this.prefs = { ...this.prefs, [cat]: value };
    this.commit();
  }

  /** A copy to restore from — what Cancel in the Preferences dialog holds. */
  snapshot(): Prefs { return structuredClone(this.prefs); }

  restore(p: Prefs): void {
    this.prefs = mergePrefs(p);
    this.commit();
  }

  resetCategory(cat: PrefsCategory): void {
    this.prefs = resetCategory(this.prefs, cat);
    this.commit();
  }

  resetAll(): void {
    this.prefs = structuredClone(DEFAULT_PREFS);
    this.commit();
  }

  subscribe(fn: (p: Prefs) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private commit(): void {
    save(this.prefs);
    for (const fn of this.listeners) fn(this.prefs);
  }
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return mergePrefs(raw ? JSON.parse(raw) : null);
  } catch { /* private mode, or a blob we cannot parse */ }
  return structuredClone(DEFAULT_PREFS);
}

function save(p: Prefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ }
}
