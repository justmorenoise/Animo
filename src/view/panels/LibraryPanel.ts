import { clear, cls, drag, h, on } from "@/view/widgets/dom";
import { busy } from "@/view/widgets/Busy";
import { icon } from "@/view/icons";
import type { Panel } from "@/view/widgets/Dock";
import type { Store } from "@/app/Store";
import type { AssetStore } from "@/app/AssetStore";
import { isImage, isSymbol, type LibraryItem } from "@/core/doc/types";
import { type AssetId, type FolderId, type ItemId, newFolderId } from "@/core/doc/ids";
import {
  deletePlan, folderNameTaken, type LibraryRow, libraryRows, parentFolder, rowKey, stepRow, uniqueFolderName,
  canMoveFolder,
} from "@/core/doc/libraryTree";
import { AddFolder, MoveToFolder, RemoveFolder, RenameFolder } from "@/core/history/libraryCommands";
import { alertDialog, confirmDialog } from "@/view/widgets/dialogs";
import { menuAnchor, showMenu } from "@/view/widgets/Dock";
import { itemsOf } from "@/core/doc/displays";
import { AddLibraryItem, RemoveLibraryItem, RenameLibraryItem } from "@/core/history/commands";
import { createImageItem } from "@/core/doc/defaults";
import { importPsd } from "@/app/PsdImport";
import { SceneRenderer } from "@/view/viewport/SceneRenderer";
import { toPngBlob } from "@/io/atlas/AtlasBuilder";
import { type FrameContext, SETUP_CONTEXT, symbolBounds } from "@/core/doc/pose";
import { matOf } from "@/core/math/Matrix2D";

/**
 * The library. Items are references, so editing one updates every instance
 * automatically — the "modify once, all instances change" behaviour falls out
 * of the model rather than needing propagation code.
 */
const SORT_KEY = "animo.library.sort";
const PREVIEW_H_KEY = "animo.library.previewH";
const PREVIEW_MIN_H = 64;
const PREVIEW_MAX_H = 640;
/** The selected item fills the box, but a 3px sprite in a 600px box is a
 *  canvas nobody asked for. */
const PREVIEW_MAX_SCALE = 8;

function readSortDir(): 1 | -1 {
  try { return localStorage.getItem(SORT_KEY) === "-1" ? -1 : 1; } catch { return 1; }
}

function readPreviewH(): number | null {
  try {
    const n = Number(localStorage.getItem(PREVIEW_H_KEY));
    return Number.isFinite(n) && n > 0 ? clampPreviewH(n) : null;
  } catch { return null; }
}

function clampPreviewH(n: number, available = PREVIEW_MAX_H): number {
  return Math.max(PREVIEW_MIN_H, Math.min(PREVIEW_MAX_H, available, Math.round(n)));
}

/** What the search field, the column heads and a few rows need below it. */
const LIST_MIN_H = 118;

export class LibraryPanel implements Panel {
  readonly id = "library";
  readonly title = "Library";
  readonly icon = "folderItem" as const;
  readonly el: HTMLElement;
  readonly footer: HTMLElement;

  private preview: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private filter = "";
  /** Name order, ascending by default. A view concern only: `itemOrder` in the
   *  document is never rewritten, so nothing here is undoable or saved. */
  private sortDir: 1 | -1 = readSortDir();
  private sortHead: HTMLElement;

  /** The rows on screen, in order: what the arrow keys walk. */
  private rows: LibraryRow[] = [];
  /** Folders the user closed. View state, reset with the document: folder
   *  ids restart with every project. */
  private collapsed = new Set<FolderId>();
  /** A selected folder. Items are selected in the store; a folder is not a
   *  thing the rest of the editor can act on, so its selection lives here. */
  private selectedFolder: FolderId | null = null;
  private shownProject: unknown = null;

  /** Draws symbol thumbnails with the same code that draws the stage. */
  private readonly renderer: SceneRenderer;

  /** What the preview is showing, so a resize can redraw it without
   *  rebuilding the whole list. */
  private shown: LibraryItem | null = null;
  private redrawQueued = false;
  /** The height the user dragged to, kept across panel resizes that had to
   *  squeeze the preview to leave the list something. */
  private wantedH: number | null = null;

  constructor(
    private readonly store: Store,
    private readonly assets: AssetStore,
    private readonly onPlace: (itemId: ItemId, x: number, y: number) => void,
    private readonly onEditSymbol: (itemId: ItemId) => void = () => {},
    private readonly onNewSymbol: () => void = () => {},
    private readonly onContextMenu: (itemId: ItemId, x: number, y: number) => void = () => {},
    /** Progress and problems, shown wherever the host puts them. */
    private readonly onStatus: (message: string, isError?: boolean) => void = () => {},
  ) {
    this.renderer = new SceneRenderer(() => this.store.project, this.assets);
    this.preview = h("div", { class: "lib-preview" });
    this.search = h("input", { type: "text", placeholder: "Search" });
    // Focusable, so the keys below act on the library only while it has the
    // focus: Delete and the arrows mean something else on the stage.
    this.list = h("div", { class: "lib-list", tabindex: 0 });
    this.wireKeys();
    this.wireListDrop();

    on(this.search, "input", () => {
      this.filter = this.search.value.trim().toLowerCase();
      this.renderList();
    });

    this.sortHead = h("span", { class: "sortable", title: "Sort by name" });
    on(this.sortHead, "click", () => {
      this.sortDir = this.sortDir === 1 ? -1 : 1;
      try { localStorage.setItem(SORT_KEY, String(this.sortDir)); } catch { /* private mode */ }
      this.renderList();
    });

    this.wantedH = readPreviewH();
    if (this.wantedH !== null) this.preview.style.height = `${this.wantedH}px`;

    this.el = h("div", { class: "lib" },
      this.preview,
      this.buildPreviewSplitter(),
      h("div", { class: "lib-search" }, icon("search", 12), this.search),
      h("div", { class: "lib-cols" }, this.sortHead, h("span", { style: "text-align:right" }, "Use")),
      this.list,
    );

    // The fit is measured, so every reason the box changes size — the
    // splitter, the panel, the window, docking — goes through one path.
    const ro = new ResizeObserver(() => { this.applyPreviewH(); this.queueRedraw(); });
    ro.observe(this.preview);
    ro.observe(this.el);

    this.footer = this.buildFooter();
    this.wireDrop();

    store.subscribe((t) => {
      if (t === "library" || t === "doc" || t === "selection") this.renderList();
    });
    this.renderList();
  }

  /** Drag the bottom edge of the preview to make it taller or shorter. */
  private buildPreviewSplitter(): HTMLElement {
    const sp = h("div", { class: "splitter h", title: "Drag to resize the preview" });
    let start = 96;
    drag(sp, {
      cursor: "ns-resize",
      onStart: () => { start = this.preview.offsetHeight; sp.classList.add("dragging"); },
      onMove: (_dx, dy) => {
        this.wantedH = clampPreviewH(start + dy, this.availableH());
        this.preview.style.height = `${this.wantedH}px`;
      },
      onEnd: () => {
        sp.classList.remove("dragging");
        try {
          localStorage.setItem(PREVIEW_H_KEY, String(this.wantedH ?? this.preview.offsetHeight));
        } catch { /* private mode */ }
      },
    });
    return sp;
  }

  /** The preview may not take the panel: the list has to stay usable. */
  private availableH(): number {
    const panel = this.el.clientHeight;
    return panel > 0 ? Math.max(PREVIEW_MIN_H, panel - LIST_MIN_H) : PREVIEW_MAX_H;
  }

  /** Re-apply the dragged height against the panel's current size. */
  private applyPreviewH(): void {
    if (this.wantedH === null) return;
    const h = clampPreviewH(this.wantedH, this.availableH());
    if (Math.round(this.preview.offsetHeight) !== h) this.preview.style.height = `${h}px`;
  }

  /** One redraw per frame: a drag fires a ResizeObserver per pointermove. */
  private queueRedraw(): void {
    if (this.redrawQueued) return;
    this.redrawQueued = true;
    requestAnimationFrame(() => {
      this.redrawQueued = false;
      this.renderPreview(this.shown);
    });
  }

  private buildFooter(): HTMLElement {
    const importBtn = h("button", { class: "iconbtn", title: "Import images…" });
    importBtn.appendChild(icon("imageItem", 13));
    on(importBtn, "click", () => this.pickFiles());

    const newSymbol = h("button", { class: "iconbtn", title: "New symbol" });
    newSymbol.appendChild(icon("symbolItem", 13));
    on(newSymbol, "click", () => this.onNewSymbol());

    const newFolder = h("button", { class: "iconbtn", title: "New folder" });
    newFolder.appendChild(icon("newFolder", 13));
    on(newFolder, "click", () => this.newFolder());

    const del = h("button", { class: "iconbtn", title: "Delete" });
    del.appendChild(icon("trash", 13));
    on(del, "click", () => void this.deleteSelected());

    return h("div", { class: "pfooter" },
      importBtn, newSymbol, newFolder, h("div", { class: "spacer" }), del);
  }

  // ── Import ─────────────────────────────────────────────────────────────

  private pickFiles(): void {
    const input = h("input", { type: "file", accept: "image/*,.psd", multiple: true });
    input.style.display = "none";
    document.body.appendChild(input);
    on(input, "change", async () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      await this.importFiles(files);
    });
    input.click();
  }

  /**
   * Import dropped or chosen files. Returns the items the caller should place
   * on the stage — a PSD places itself (as one document symbol), so it
   * contributes nothing here even though it adds a whole tree to the library.
   */
  async importFiles(files: File[], at?: { x: number; y: number }): Promise<ItemId[]> {
    for (const file of files.filter(isPsd)) await this.importPsdFile(file, at);

    const images = files.filter((f) => !isPsd(f) && f.type.startsWith("image/"));
    const added: ItemId[] = [];
    const label = images.length === 1 ? `Importing ${images[0]!.name}` : `Importing ${images.length} images`;
    if (images.length) await busy(label, async (report) => {
      for (const [n, file] of images.entries()) {
        report(n / images.length);
        try {
          const asset = await this.assets.addFromFile(file);
          const name = uniqueName(this.store, asset.name);
          const item = createImageItem(name, asset.id, asset.width, asset.height);
          this.store.apply(new AddLibraryItem(`Import ${name}`, item));
          added.push(item.id);
        } catch (err) {
          console.error(`[Animo] Could not import ${file.name}:`, err);
          this.onStatus(`Could not import ${file.name}`, true);
        }
      }
    });
    if (added.length) this.store.selectItems(added);
    this.store.emit("library");
    return added;
  }

  private async importPsdFile(file: File, at?: { x: number; y: number }): Promise<void> {
    try {
      const result = await busy(`Importing ${file.name}`,
        (report) => importPsd(this.store, this.assets, file, at, report));
      for (const w of result.warnings) console.warn(`[PSD] ${w}`);
      const parts = [
        `Imported ${result.symbolName}:`,
        `${result.images} image${result.images === 1 ? "" : "s"}`,
        `in ${result.symbols} symbol${result.symbols === 1 ? "" : "s"},`,
        `in the folder "${result.folderName}"`,
      ];
      if (result.stage) parts.push(`· stage set to ${result.stage.width} × ${result.stage.height}`);
      if (result.warnings.length) {
        parts.push(`· ${result.warnings.length} warning(s), listed in the browser console`);
      }
      this.onStatus(parts.join(" "));
    } catch (err) {
      console.error(`[Animo] Could not import ${file.name}:`, err);
      this.onStatus(`Could not import ${file.name}: ${err instanceof Error ? err.message : err}`, true);
    }
  }

  /** Drag image files straight onto the panel. */
  private wireDrop(): void {
    const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    on(this.el, "dragover", (e) => {
      stop(e);
      if ((e as unknown as DragEvent).dataTransfer?.types.includes("Files")) cls(this.el, "dropping", true);
    });
    on(this.el, "dragleave", () => cls(this.el, "dropping", false));
    on(this.el, "drop", async (ev) => {
      stop(ev);
      cls(this.el, "dropping", false);
      const dt = (ev as unknown as DragEvent).dataTransfer;
      if (dt?.files?.length) await this.importFiles(Array.from(dt.files));
    });
  }

  // ── List ───────────────────────────────────────────────────────────────

  private rendering = false;

  /**
   * Never re-entrant, like `PropertiesPanel.rebuild`. A re-render while the
   * rename field has focus — ⌘Z works inside text fields — removes the field,
   * its `blur` commits the rename, the commit re-renders, and the outer
   * `clear` then throws on a node the inner one already removed, in the
   * middle of the store's emit. The outer pass reads the names after `clear`,
   * so it already shows the committed one.
   */
  private renderList(): void {
    if (this.rendering) return;
    this.rendering = true;
    try {
      this.buildList();
    } finally {
      this.rendering = false;
    }
  }

  private buildList(): void {
    clear(this.list);
    this.sortHead.textContent = `Name ${this.sortDir === 1 ? "▲" : "▼"}`;
    const project = this.store.project;
    if (project !== this.shownProject) {
      this.shownProject = project;
      this.collapsed.clear();
      this.selectedFolder = null;
    }
    // An item selected from anywhere (the stage, Show in Library) wins.
    if (this.selectedFolder && (!project.folders[this.selectedFolder] || this.store.selection.items.length)) {
      this.selectedFolder = null;
    }

    this.rows = libraryRows(project, { collapsed: this.collapsed, filter: this.filter, sortDir: this.sortDir });
    if (this.rows.length === 0) {
      this.list.appendChild(h("div", { class: "empty" },
        this.filter ? "No matching items" : "Import images with the button below, or drop them here"));
      this.renderPreview(null);
      return;
    }

    const usage = countUsages(this.store);
    const current = this.currentKey();
    for (const row of this.rows) this.list.appendChild(this.buildRow(row, usage, rowKey(row) === current));

    const sel = this.store.selection.items[0];
    this.renderPreview(!this.selectedFolder && sel ? project.items[sel] ?? null : null);
  }

  private buildRow(row: LibraryRow, usage: Map<ItemId, number>, selected: boolean): HTMLElement {
    const key = rowKey(row);
    const folder = row.kind === "folder";
    const twisty = h("span", { class: "lib-twisty" }, folder && !row.empty ? (row.open ? "▾" : "▸") : "");
    const el = h("div", {
      class: `lib-row${selected ? " selected" : ""}${folder ? " folder" : ""}`,
      draggable: true, data: { key },
    },
      h("div", { class: "nm", style: { paddingLeft: `${row.depth * 14}px` } },
        twisty,
        wrapIcon(folder ? "folderItem" : isSymbol(row.item) ? "symbolItem" : "imageItem"),
        h("span", { class: "lbl" }, row.name)),
      h("div", { class: "use" }, folder ? "" : String(usage.get(row.id) ?? 0)),
    );

    on(twisty, "click", (ev) => {
      if (!folder) return;
      ev.stopPropagation();
      this.toggle(row.id, !row.open);
    });
    on(el, "click", () => { this.selectRow(row); this.list.focus({ preventScroll: true }); });
    on(el, "dblclick", (ev) => {
      // Double-clicking the NAME renames; anywhere else opens a folder or
      // edits a symbol, as in Flash.
      if ((ev.target as HTMLElement).closest(".lbl")) this.beginRename(el, row);
      else if (folder) this.toggle(row.id, !row.open);
      else if (isSymbol(row.item)) this.onEditSymbol(row.id);
      else this.beginRename(el, row);
    });
    on(el, "dragstart", (ev) => {
      const e = ev as unknown as DragEvent;
      if (!folder) e.dataTransfer?.setData("application/x-animo-item", row.id);
      e.dataTransfer?.setData(LIB_DRAG, key);
      e.dataTransfer!.effectAllowed = "copyMove";
    });
    // Dropped on a folder: into it. On an item: next to it, in its folder.
    const target = (): FolderId | null =>
      folder ? row.id : parentFolder(this.store.project, row.item);
    on(el, "dragover", (ev) => {
      const e = ev as unknown as DragEvent;
      if (!e.dataTransfer?.types.includes(LIB_DRAG)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      this.markDrop(target());
    });
    on(el, "drop", (ev) => {
      const e = ev as unknown as DragEvent;
      const dragged = e.dataTransfer?.getData(LIB_DRAG);
      if (!dragged) return;
      e.preventDefault();
      e.stopPropagation();
      this.markDrop(undefined);
      this.moveEntry(dragged, target());
    });
    on(el, "contextmenu", (ev) => {
      const e = ev as unknown as MouseEvent;
      e.preventDefault();
      this.selectRow(row);
      if (folder) this.folderMenu(row.id, e.clientX, e.clientY);
      else this.onContextMenu(row.id, e.clientX, e.clientY);
    });
    return el;
  }

  // ── Selection and keys ─────────────────────────────────────────────────

  private currentKey(): string | null {
    if (this.selectedFolder) return rowKey({ kind: "folder", id: this.selectedFolder });
    const id = this.store.selection.items[0];
    return id ? rowKey({ kind: "item", id }) : null;
  }

  private selectRow(row: LibraryRow | null | undefined): void {
    if (!row) return;
    this.selectedFolder = row.kind === "folder" ? row.id : null;
    this.store.selectItems(row.kind === "item" ? [row.id] : []);
    this.renderList();
    this.list.querySelector(".lib-row.selected")?.scrollIntoView({ block: "nearest" });
  }

  private toggle(id: FolderId, open: boolean): void {
    if (open) this.collapsed.delete(id); else this.collapsed.add(id);
    this.renderList();
  }

  private wireKeys(): void {
    on(this.list, "keydown", (ev) => {
      const e = ev as unknown as KeyboardEvent;
      // A rename field inside the list types its own keys.
      if (e.target !== this.list || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = this.currentKey();
      const row = this.rows.find((r) => rowKey(r) === key) ?? null;
      const p = this.store.project;
      switch (e.key) {
        case "ArrowDown": this.selectRow(stepRow(this.rows, key, 1)); break;
        case "ArrowUp": this.selectRow(stepRow(this.rows, key, -1)); break;
        case "Home": this.selectRow(this.rows[0]); break;
        case "End": this.selectRow(this.rows[this.rows.length - 1]); break;
        case "ArrowRight":
          if (row?.kind === "folder") {
            if (!row.open) this.toggle(row.id, true);
            else if (!row.empty) this.selectRow(stepRow(this.rows, key, 1));
          }
          break;
        case "ArrowLeft": {
          if (row?.kind === "folder" && row.open && !row.empty) { this.toggle(row.id, false); break; }
          const parent = row && parentFolder(p, row.kind === "item" ? row.item : p.folders[row.id]!);
          if (parent) this.selectRow(this.rows.find((r) => r.kind === "folder" && r.id === parent));
          break;
        }
        case "Enter":
          if (row?.kind === "folder") this.toggle(row.id, !row.open);
          else if (row && isSymbol(row.item)) this.onEditSymbol(row.id);
          break;
        case "F2": {
          const el = row && this.list.querySelector<HTMLElement>(`[data-key="${rowKey(row)}"]`);
          if (row && el) this.beginRename(el, row);
          break;
        }
        case "Delete":
        case "Backspace":
          void this.deleteSelected();
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // ── Folders ────────────────────────────────────────────────────────────

  /** The folder new things go in: the selected folder, or the selected item's. */
  private currentFolder(): FolderId | null {
    const p = this.store.project;
    if (this.selectedFolder && p.folders[this.selectedFolder]) return this.selectedFolder;
    const item = p.items[this.store.selection.items[0]!];
    return item ? parentFolder(p, item) : null;
  }

  /** A new folder where the selection is, with its name ready to type. */
  newFolder(parent: FolderId | null = this.currentFolder()): void {
    const p = this.store.project;
    const folder = { id: newFolderId(), name: uniqueFolderName(p, parent), parentId: parent };
    if (parent) this.collapsed.delete(parent);
    if (this.filter) { this.filter = ""; this.search.value = ""; }
    this.store.apply(new AddFolder(folder));
    this.selectRow({ kind: "folder", id: folder.id, name: folder.name, depth: 0, open: true, empty: true });
    const el = this.list.querySelector<HTMLElement>(`[data-key="${rowKey({ kind: "folder", id: folder.id })}"]`);
    const row = this.rows.find((r) => r.kind === "folder" && r.id === folder.id);
    if (el && row) this.beginRename(el, row);
  }

  private folderMenu(id: FolderId, x: number, y: number): void {
    showMenu(menuAnchor(x, y), [
      {
        label: "Rename…", run: () => {
          const el = this.list.querySelector<HTMLElement>(`[data-key="${rowKey({ kind: "folder", id })}"]`);
          const row = this.rows.find((r) => r.kind === "folder" && r.id === id);
          if (el && row) this.beginRename(el, row);
        },
      },
      { label: "New Folder", run: () => this.newFolder(id) },
      "-",
      { label: "Delete", run: () => void this.deleteSelected() },
    ]);
  }

  private markDrop(folder: FolderId | null | undefined): void {
    for (const el of this.list.querySelectorAll(".drop-into")) el.classList.remove("drop-into");
    cls(this.list, "drop-root", folder === null);
    if (!folder) return;
    this.list.querySelector(`[data-key="${rowKey({ kind: "folder", id: folder })}"]`)?.classList.add("drop-into");
  }

  /** Dropped on the empty part of the list: out to the top level. */
  private wireListDrop(): void {
    on(this.list, "dragover", (ev) => {
      const e = ev as unknown as DragEvent;
      if (!e.dataTransfer?.types.includes(LIB_DRAG)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      this.markDrop(null);
    });
    on(this.list, "dragleave", (ev) => {
      if (!this.list.contains((ev as unknown as DragEvent).relatedTarget as Node | null)) this.markDrop(undefined);
    });
    on(this.list, "drop", (ev) => {
      const e = ev as unknown as DragEvent;
      const dragged = e.dataTransfer?.getData(LIB_DRAG);
      this.markDrop(undefined);
      if (!dragged) return;
      e.preventDefault();
      e.stopPropagation();
      this.moveEntry(dragged, null);
    });
    on(this.list, "dragend", () => this.markDrop(undefined));
  }

  private moveEntry(key: string, into: FolderId | null): void {
    const p = this.store.project;
    const [kind, id] = key.split(":") as ["folder" | "item", string];
    if (kind === "folder") {
      const fid = id as FolderId;
      if (!p.folders[fid] || p.folders[fid]!.parentId === into || !canMoveFolder(p, fid, into)) return;
      if (folderNameTaken(p, into, p.folders[fid]!.name, fid)) {
        this.onStatus(`That folder already holds a folder called "${p.folders[fid]!.name}"`, true);
        return;
      }
      this.store.apply(new MoveToFolder([], [fid], into));
    } else {
      const item = p.items[id as ItemId];
      if (!item || parentFolder(p, item) === into) return;
      this.store.apply(new MoveToFolder([item.id], [], into));
    }
    if (into) this.collapsed.delete(into);
    this.renderList();
  }

  /**
   * One library item as a PNG.
   *
   * An image hands back the bytes it was imported with — re-encoding a PNG
   * through a canvas would be a lossless round trip on paper and a needless
   * one in practice, and it would drop everything the original file carried.
   * A symbol is rasterised at the CURRENT frame and mode, tight to its own
   * bounds, with `SceneRenderer` — the same code that draws the stage, so
   * masks and nested symbols come out the way they look.
   */
  async renderItemPng(itemId: ItemId): Promise<Blob | null> {
    const item = this.store.project.items[itemId];
    if (!item) return null;

    if (isImage(item)) {
      const asset = this.assets.get(item.assetId);
      if (!asset) return null;
      if (asset.blob.type === "image/png") return asset.blob;
      // An imported JPEG or WebP does need the canvas.
      const c = h("canvas");
      c.width = Math.max(1, asset.width);
      c.height = Math.max(1, asset.height);
      c.getContext("2d")!.drawImage(asset.bitmap as CanvasImageSource, 0, 0);
      return toPngBlob(c);
    }

    if (!isSymbol(item)) return null;

    const anim = item.animations[0] ?? null;
    const when: FrameContext = anim && this.store.ui.mode !== "setup"
      ? {
          animationName: anim.name,
          // The symbol may be shorter than the timeline the playhead is on.
          frame: Math.min(this.store.ui.frame, Math.max(0, anim.duration - 1)),
          mode: "animate",
        }
      : SETUP_CONTEXT;

    const box = symbolBounds(this.store.project, item.id, when);
    if (box.w <= 0 || box.h <= 0) return null;

    const c = h("canvas");
    c.width = Math.max(1, Math.ceil(box.w));
    c.height = Math.max(1, Math.ceil(box.h));
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    // `draw` calls setTransform, which REPLACES the context transform, so the
    // crop offset has to travel in the view matrix rather than a translate.
    this.renderer.draw(ctx, item, anim, when.frame, when.mode,
                       matOf(1, 0, 0, 1, -box.x, -box.y));
    return toPngBlob(c);
  }

  /** Ask for one image file, for "Replace Image…". */
  pickImage(): Promise<File | null> {
    return new Promise((resolve) => {
      const input = h("input", { type: "file", accept: "image/*" });
      input.style.display = "none";
      document.body.appendChild(input);
      on(input, "change", () => {
        const file = input.files?.[0] ?? null;
        input.remove();
        resolve(file);
      });
      on(input, "cancel", () => { input.remove(); resolve(null); });
      input.click();
    });
  }

  /** Register a replacement asset. Kept here because the AssetStore is. */
  async addAsset(file: File): Promise<{ assetId: AssetId; width: number; height: number }> {
    const asset = await this.assets.addFromFile(file);
    return { assetId: asset.id, width: asset.width, height: asset.height };
  }

  /**
   * Select a library item and scroll it into view — "Show in Library", from a
   * stage instance. An active search filter is cleared first, or the row the
   * user asked to see may not be in the list at all.
   */
  revealItem(itemId: ItemId): void {
    if (!this.store.project.items[itemId]) return;
    if (this.filter) {
      this.filter = "";
      this.search.value = "";
    }
    // Open every folder on the way to it.
    const p = this.store.project;
    for (let f = parentFolder(p, p.items[itemId]!), n = 0; f && n < 1000; f = parentFolder(p, p.folders[f]!), n++) {
      this.collapsed.delete(f);
    }
    this.selectedFolder = null;
    this.store.selectItems([itemId]);
    this.renderList();
    const row = this.list.querySelector(".lib-row.selected");
    row?.scrollIntoView({ block: "nearest" });
  }

  private beginRename(el: HTMLElement, row: LibraryRow): void {
    const span = el.querySelector(".nm .lbl");
    if (!span) return;
    const input = h("input", { type: "text", value: row.name });
    span.replaceWith(input);
    input.focus();
    input.select();
    // Re-rendering removes the input, which fires `blur`: without the flag,
    // Escape went on to commit the very text it was meant to throw away.
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      const p = this.store.project;
      if (keep && name && name !== row.name) {
        if (row.kind === "item") {
          if (RenameLibraryItem.clashes(p, row.id, name)) {
            this.onStatus(`Another library item is already called "${name}"`, true);
          } else {
            this.store.apply(new RenameLibraryItem(row.id, name));
          }
        } else if (p.folders[row.id]) {
          if (folderNameTaken(p, parentFolder(p, p.folders[row.id]!), name, row.id)) {
            this.onStatus(`A folder next to it is already called "${name}"`, true);
          } else {
            this.store.apply(new RenameFolder(row.id, name));
          }
        }
      }
      this.renderList();
      this.list.focus({ preventScroll: true });
    };
    on(input, "blur", () => finish(true));
    on(input, "keydown", (ev) => {
      const e = ev as unknown as KeyboardEvent;
      // The list's own keys (Delete, the arrows) are not for the field.
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
  }

  private renderPreview(item: LibraryItem | null): void {
    clear(this.preview);
    this.shown = item;
    if (!item) return;
    // The box is measured, not assumed: it is resizable, and the whole point
    // of making it bigger is to see the item bigger.
    const boxW = Math.max(16, this.preview.clientWidth - 8);
    const boxH = Math.max(16, this.preview.clientHeight - 8);
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    if (isImage(item)) {
      const asset = this.assets.get(item.assetId);
      if (!asset) return;
      const scale = Math.min(boxW / asset.width, boxH / asset.height, PREVIEW_MAX_SCALE);
      const c = h("canvas");
      c.width = Math.max(1, Math.round(asset.width * scale * dpr));
      c.height = Math.max(1, Math.round(asset.height * scale * dpr));
      c.style.width = `${Math.round(asset.width * scale)}px`;
      c.style.height = `${Math.round(asset.height * scale)}px`;
      c.getContext("2d")!.drawImage(asset.bitmap as CanvasImageSource, 0, 0, c.width, c.height);
      this.preview.appendChild(c);
      return;
    }

    if (isSymbol(item)) {
      // The thumbnail shows the symbol as it PLAYS, not as it is bound: a
      // rig whose bind pose tucks a limb behind the body (the usual result
      // of importing artwork) reads as a missing limb in setup mode.
      const anim = item.animations[0] ?? null;
      const when: FrameContext =
        anim ? { animationName: anim.name, frame: 0, mode: "animate" } : SETUP_CONTEXT;
      const box = symbolBounds(this.store.project, item.id, when);
      if (box.w <= 0 || box.h <= 0) {
        this.preview.appendChild(h("div", { class: "hint" }, "Empty symbol"));
        return;
      }
      const scale = Math.min(boxW / box.w, boxH / box.h, PREVIEW_MAX_SCALE);
      const c = h("canvas");
      c.width = Math.max(1, Math.round(box.w * scale * dpr));
      c.height = Math.max(1, Math.round(box.h * scale * dpr));
      c.style.width = `${Math.round(box.w * scale)}px`;
      c.style.height = `${Math.round(box.h * scale)}px`;

      const ctx = c.getContext("2d");
      if (ctx) {
        const k = scale * dpr;
        this.renderer.draw(
          ctx, item, anim, when.frame, when.mode,
          matOf(k, 0, 0, k, -box.x * k, -box.y * k),
        );
      }
      this.preview.appendChild(c);
    }
  }

  /** Delete an item from its context menu: the same questions as the key. */
  deleteItem(itemId: ItemId): Promise<void> {
    this.selectedFolder = null;
    this.store.selectItems([itemId]);
    return this.deleteSelected();
  }

  /**
   * Delete the selected folder or items. Something placed on a stage is
   * refused with a message saying where; otherwise it asks (unless the user
   * said not to), and deletes in one undoable step.
   */
  async deleteSelected(): Promise<void> {
    const p = this.store.project;
    const folders = this.selectedFolder && p.folders[this.selectedFolder] ? [this.selectedFolder] : [];
    const items = folders.length ? [] : this.store.selection.items.filter((id) => id !== p.rootSymbolId);
    if (!items.length && !folders.length) return;

    try {
      const usage = countUsages(this.store);
      const plan = deletePlan(p, items, folders, usage);
      const name = (id: ItemId) => `"${p.items[id]?.name ?? id}"`;
      const times = (id: ItemId) => { const n = usage.get(id) ?? 0; return n === 1 ? "once" : `${n} times`; };
      const folderName = folders.length ? `"${p.folders[folders[0]!]!.name}"` : "";

      if (plan.inUse.length) {
        const lines = plan.inUse.slice(0, 6).map((id) => `• ${name(id)}, placed ${times(id)}`);
        if (plan.inUse.length > 6) lines.push(`• and ${plan.inUse.length - 6} more`);
        await alertDialog({
          title: "Can't delete",
          message: folders.length
            ? `The folder ${folderName} holds items that are placed in a symbol or on the stage:\n` +
              `${lines.join("\n")}\n\nDelete their instances first.`
            : plan.inUse.length === 1
              ? `${name(plan.inUse[0]!)} is placed ${times(plan.inUse[0]!)} in a symbol or on the stage, ` +
                "so it cannot be deleted. Delete its instances first; the Use column counts them."
              : `These items are placed in a symbol or on the stage:\n${lines.join("\n")}\n\n` +
                "Delete their instances first.",
        });
        return;
      }

      if (this.store.prefs.value.general.confirmLibraryDelete) {
        const inside = plan.items.length + plan.folders.length - 1;
        const ok = await confirmDialog({
          title: "Delete",
          message: (folders.length
            ? inside > 0
              ? `Delete the folder ${folderName} and the ${inside} ${inside === 1 ? "entry" : "entries"} in it?`
              : `Delete the folder ${folderName}?`
            : items.length === 1
              ? `Delete ${name(items[0]!)} from the library?`
              : `Delete ${items.length} items from the library?`) + " Edit ▸ Undo brings it back.",
          ok: "Delete", danger: true,
          dontAskAgain: {
            label: "Don't ask again (Preferences ▸ General ▸ Library turns it back on)",
            remember: () => this.store.prefs.set("general", { confirmLibraryDelete: false }),
          },
        });
        if (!ok) return;
      }

      // The dialog did not stop the document: plan again from what is there now.
      const now = deletePlan(this.store.project, items, folders, countUsages(this.store));
      if (now.inUse.length || (!now.items.length && !now.folders.length)) return;
      const at = this.rows.findIndex((r) => rowKey(r) === this.currentKey());
      this.store.transaction(folders.length ? "Delete Folder" : "Delete Library Items", () => {
        for (const id of now.items) this.store.apply(new RemoveLibraryItem(id));
        for (const id of now.folders) this.store.apply(new RemoveFolder(id));
      });
      this.selectedFolder = null;
      this.store.selectItems([]);
      this.renderList();
      // The row that took the deleted one's place, so Delete can run down a list.
      if (at >= 0) this.selectRow(this.rows[Math.min(at, this.rows.length - 1)]);
    } finally {
      this.list.focus({ preventScroll: true });
    }
  }

  /** Called by the stage when a library row is dropped onto it. */
  place(itemId: ItemId, x: number, y: number): void { this.onPlace(itemId, x, y); }
}

/** Library rows and folders dragged within the list, as "item:id" / "folder:id". */
const LIB_DRAG = "application/x-animo-lib";

function wrapIcon(name: "imageItem" | "symbolItem" | "folderItem"): HTMLElement {
  const span = h("span", { class: "ico" });
  span.appendChild(icon(name, 13));
  return span;
}

/** How many nodes across every symbol reference each library item. */
export function countUsages(store: Store): Map<ItemId, number> {
  const counts = new Map<ItemId, number>();
  for (const item of Object.values(store.project.items)) {
    if (!isSymbol(item)) continue;
    for (const node of Object.values(item.nodes)) {
      for (const id of new Set(itemsOf(node))) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/** Photoshop files arrive with an empty MIME type as often as not. */
function isPsd(file: File): boolean {
  return /\.psd$/i.test(file.name) || file.type === "image/vnd.adobe.photoshop";
}

function uniqueName(store: Store, base: string): string {
  const taken = new Set(Object.values(store.project.items).map((i) => i.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
