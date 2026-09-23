import { withStore } from "./idb";

/**
 * Crash recovery, in IndexedDB.
 *
 * The whole `.animo` blob is stored rather than a diff or a JSON snapshot:
 * recovery then has exactly the same code path as opening a file, so there is
 * no second, less-tested deserialiser to get wrong at the worst moment.
 */

const KEY = "current";

export interface AutosaveRecord {
  blob: Blob;
  name: string;
  savedAt: number;
}

export async function writeAutosave(blob: Blob, name: string): Promise<void> {
  const record: AutosaveRecord = { blob, name, savedAt: Date.now() };
  await withStore("autosave", "readwrite", (s) => s.put(record, KEY));
}

export async function readAutosave(): Promise<AutosaveRecord | null> {
  try {
    const record = await withStore<AutosaveRecord | undefined>("autosave", "readonly", (s) => s.get(KEY));
    return record ?? null;
  } catch {
    return null;                     // private mode, blocked storage, etc.
  }
}

export async function clearAutosave(): Promise<void> {
  try { await withStore("autosave", "readwrite", (s) => s.delete(KEY)); } catch { /* ignore */ }
}

/**
 * Periodic autosave.
 *
 * It only writes when the document has actually changed and the editor has
 * been idle for a moment, so a long drag never competes with a zip of the
 * whole project for the main thread.
 */
export class Autosaver {
  private timer = 0;
  private idleTimer = 0;
  private running = false;

  constructor(
    private readonly isDirty: () => boolean,
    private readonly snapshot: () => Promise<{ blob: Blob; name: string }>,
    private intervalMs = 30_000,
    private readonly idleMs = 1_500,
  ) {}

  /** Does nothing when already running. The preferences reach this on every
   *  write — a view toggle, an onion marker drag — and restarting here threw
   *  away the save a pending idle timer was about to make. */
  start(): void {
    if (this.timer) return;
    this.timer = window.setInterval(() => this.maybeSave(), this.intervalMs);
  }

  /** Change the period. Restarts the interval when one is already running, so
   *  a preference change takes effect without waiting out the old one; a
   *  pending idle save is kept. */
  setInterval(ms: number): void {
    if (ms === this.intervalMs) return;
    this.intervalMs = ms;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.maybeSave(), this.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.idleTimer);
    this.timer = 0;
  }

  /**
   * Called on every document change; defers the save until things go quiet.
   * Nothing while stopped: re-arming the idle timer regardless kept writing
   * after the preference turned autosave off.
   */
  touch(): void {
    if (!this.timer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => void this.maybeSave(), this.idleMs);
  }

  private async maybeSave(): Promise<void> {
    if (this.running || !this.isDirty()) return;
    this.running = true;
    try {
      const { blob, name } = await this.snapshot();
      await writeAutosave(blob, name);
    } catch (err) {
      console.warn("[Autosave] skipped:", err);
    } finally {
      this.running = false;
    }
  }
}
