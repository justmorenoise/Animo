import type { Store } from "./Store";
import type { AssetStore } from "./AssetStore";
import { createProject } from "@/core/doc/defaults";
import { reseed } from "@/core/doc/ids";
import { invalidateBounds } from "@/core/doc/pose";
import type { Diagnostic } from "@/core/doc/schema";
import { deserializeProject, PROJECT_EXTENSION, serializeProject, } from "@/io/project/ProjectFile";
import {
    type FileRef,
    hasNativeFiles,
    pickOpenFile,
    pickSaveLocation,
    readFileRef,
    writeFile,
} from "@/io/project/FileSystem";
import { clearRecents, listRecents, type RecentEntry, rememberRecent, } from "@/io/project/Recents";
import { Autosaver, type AutosaveRecord, clearAutosave, readAutosave, } from "@/io/project/Autosave";
import { type RunBusy, runQuietly } from "./busy";

export interface ProjectServiceEvents {
  onLoaded?(diagnostics: Diagnostic[]): void;
  onStatus?(message: string, isError?: boolean): void;
  onRecentsChanged?(recents: RecentEntry[]): void;
  /** Asks before unsaved work is dropped. Without it the work is kept (false). */
  confirmDiscard?(): Promise<boolean>;
  /** Runs a slow step under the app's progress indicator. */
  busy?: RunBusy;
}

/**
 * Opening, saving and recovering projects.
 *
 * Keeping this out of App means the same logic serves the menu, the keyboard
 * shortcut, the autosaver and (later) an Electron main process.
 */
export class ProjectService {
  private ref: FileRef | null = null;
  readonly autosaver: Autosaver;
  /**
   * A cache of the recent list, because a menu is built synchronously when it
   * opens and IndexedDB is not.
   */
  private recentCache: RecentEntry[] = [];

  constructor(
    private readonly store: Store,
    private readonly assets: AssetStore,
    private readonly events: ProjectServiceEvents = {},
    private readonly onProjectReplaced: () => void = () => {},
  ) {
    const general = store.prefs.value.general;
    this.autosaver = new Autosaver(
      () => this.store.history.isDirty,
      async () => ({
        blob: await serializeProject(this.store.project, this.assets),
        name: this.fileName,
      }),
      general.autosaveSeconds * 1000,
    );
    this.store.subscribe((topic) => {
      if (topic === "doc" || topic === "timeline" || topic === "library") this.autosaver.touch();
    });
    if (general.autosave) this.autosaver.start();

    // The interval and the switch are preferences, so a change has to reach a
    // service that read them once at construction.
    store.prefs.subscribe((p) => this.applyAutosavePrefs(p.general.autosave, p.general.autosaveSeconds));
    void this.refreshRecents();

    window.addEventListener("beforeunload", (e) => {
      if (!this.store.history.isDirty) return;
      e.preventDefault();
      e.returnValue = "";
    });
  }

  get fileName(): string {
    return this.ref?.name ?? `${safeName(this.store.project.name)}.${PROJECT_EXTENSION}`;
  }

  get hasLocation(): boolean { return !!this.ref?.handle; }

  // ── Recent files ───────────────────────────────────────────────────────

  /** The cached list, safe to read while building a menu. */
  get recents(): RecentEntry[] { return this.recentCache; }

  private async refreshRecents(): Promise<void> {
    this.recentCache = await listRecents();
    this.events.onRecentsChanged?.(this.recentCache);
  }

  private async remember(ref: FileRef): Promise<void> {
    this.recentCache = await rememberRecent(ref);
    this.events.onRecentsChanged?.(this.recentCache);
  }

  async clearRecentList(): Promise<void> {
    await clearRecents();
    this.recentCache = [];
    this.events.onRecentsChanged?.(this.recentCache);
  }

  /**
   * Open a file from the recent list. A handle can go stale — the file moved,
   * or the permission lapsed — in which case this falls back to the picker
   * rather than reporting a failure the user can do nothing about.
   */
  async openRecent(entry: RecentEntry): Promise<boolean> {
    if (!(await this.confirmDiscard())) return false;
    const data = entry.handle ? await readFileRef({ name: entry.name, handle: entry.handle }) : null;
    if (!data) {
      this.events.onStatus?.(`Could not reopen ${entry.name}. Choose it again.`, true);
      const picked = await pickOpenFile();
      if (!picked) return false;
      return this.loadFrom(picked.data, picked.ref);
    }
    return this.loadFrom(data, { name: entry.name, handle: entry.handle });
  }

  // ── New ────────────────────────────────────────────────────────────────

  /** Asks first, as Open does: this used to drop unsaved work without a
   *  word — and clear the autosave that could have brought it back. */
  async newProject(name = "Untitled"): Promise<boolean> {
    if (!(await this.confirmDiscard())) return false;
    reseed();
    this.assets.clear();
    invalidateBounds();
    const p = this.store.prefs.value.general;
    this.store.replaceProject(createProject(name, {
      width: p.newDocWidth, height: p.newDocHeight,
      frameRate: p.newDocFps, background: p.newDocBackground,
    }));
    this.ref = null;
    this.onProjectReplaced();
    void clearAutosave();
    this.events.onStatus?.("New project");
    return true;
  }

  // ── Save ───────────────────────────────────────────────────────────────

  async save(): Promise<boolean> {
    // Without a file handle there is nowhere to write back to, so Save has to
    // behave like Save As rather than silently downloading a second copy.
    if (!this.ref || (!this.ref.handle && hasNativeFiles())) return this.saveAs();
    return this.writeTo(this.ref);
  }

  async saveAs(): Promise<boolean> {
    const ref = await pickSaveLocation(this.fileName);
    if (!ref) return false;
    this.ref = ref;
    return this.writeTo(ref);
  }

  private async writeTo(ref: FileRef): Promise<boolean> {
    try {
      const revision = this.store.history.revision;
      await this.busy(`Saving ${ref.name}`, async () => {
        await writeFile(ref, await serializeProject(this.store.project, this.assets));
      });
      if (this.store.history.revision === revision) {
        this.store.history.markSaved();
        // The autosave now holds nothing the file does not; left in place, the
        // next launch offered to "recover" work that was saved.
        void clearAutosave();
      } else {
        // Edited while the file was being written: the file lacks that edit,
        // so the document is not saved and its autosave must stay.
        this.store.history.markDirty();
      }
      this.store.emit("doc");
      void this.remember(ref);
      this.events.onStatus?.(`Saved ${ref.name}`);
      return true;
    } catch (err) {
      this.events.onStatus?.(`Could not save: ${message(err)}`, true);
      return false;
    }
  }

  // ── Open ───────────────────────────────────────────────────────────────

  async open(): Promise<boolean> {
    if (!(await this.confirmDiscard())) return false;
    const picked = await pickOpenFile();
    if (!picked) return false;
    return this.loadFrom(picked.data, picked.ref);
  }

  /**
   * `remember` is false for a recovered autosave: it has a name but no file
   * behind it, and a recent entry that can only ever reopen the picker is
   * worse than no entry.
   */
  async loadFrom(data: ArrayBuffer, ref: FileRef | null, remember = true): Promise<boolean> {
    try {
      const { project, diagnostics } = await this.busy(`Opening ${ref?.name ?? "project"}`,
        (report) => deserializeProject(data, this.assets, report));
      invalidateBounds();
      this.store.replaceProject(project);
      this.ref = ref;
      if (ref && remember) void this.remember(ref);
      this.onProjectReplaced();
      this.events.onLoaded?.(diagnostics);
      this.events.onStatus?.(
        diagnostics.length
          ? `Opened ${ref?.name ?? "project"} with ${diagnostics.length} warning(s)`
          : `Opened ${ref?.name ?? "project"}`,
      );
      return true;
    } catch (err) {
      this.events.onStatus?.(`Could not open: ${message(err)}`, true);
      return false;
    }
  }

  // ── Recovery ───────────────────────────────────────────────────────────

  /** An autosave newer than the last clean save means the tab died. */
  async findRecovery(): Promise<AutosaveRecord | null> {
    return readAutosave();
  }

  async recover(record: AutosaveRecord): Promise<boolean> {
    if (!(await this.confirmDiscard())) return false;
    const ok = await this.loadFrom(await record.blob.arrayBuffer(), { name: record.name }, false);
    if (ok) {
      // Recovered work is unsaved by definition. `loadFrom` leaves the history
      // clean, which dropped the title's marker and the warning on closing.
      this.store.history.markDirty();
      this.store.emit("doc");
      this.events.onStatus?.("Recovered unsaved work");
    }
    return ok;
  }

  /** Clears the record only while it is still the one offered: once this
   *  session has autosaved, the record is ITS work, not the old tab's. */
  async discardRecovery(record: AutosaveRecord): Promise<void> {
    const now = await readAutosave();
    if (now && now.savedAt === record.savedAt) await clearAutosave();
  }

  private applyAutosavePrefs(enabled: boolean, seconds: number): void {
    this.autosaver.setInterval(seconds * 1000);
    if (enabled) this.autosaver.start(); else this.autosaver.stop();
  }

  private async confirmDiscard(): Promise<boolean> {
    if (!this.store.history.isDirty) return true;
    if (!this.store.prefs.value.general.confirmDiscard) return true;
    return (await this.events.confirmDiscard?.()) ?? false;
  }

  private get busy(): RunBusy { return this.events.busy ?? runQuietly; }
}

function safeName(name: string): string {
  return name.trim().replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "project";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
