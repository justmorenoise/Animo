import { clear, cls, drag, h, on } from "@/view/widgets/dom";
import { icon } from "@/view/icons";
import type { Panel } from "@/view/widgets/Dock";
import type { Store } from "@/app/Store";
import type { AssetStore } from "@/app/AssetStore";
import { isImage, isSymbol, type LibraryItem } from "@/core/doc/types";
import type { AssetId, ItemId } from "@/core/doc/ids";
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
    this.list = h("div", { class: "lib-list" });

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

    const del = h("button", { class: "iconbtn", title: "Delete" });
    del.appendChild(icon("trash", 13));
    on(del, "click", () => this.deleteSelected());

    return h("div", { class: "pfooter" },
      importBtn, newSymbol, h("div", { class: "spacer" }), del);
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
    for (const file of images) {
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
    if (added.length) this.store.selectItems(added);
    this.store.emit("library");
    return added;
  }

  private async importPsdFile(file: File, at?: { x: number; y: number }): Promise<void> {
    this.onStatus(`Reading ${file.name}…`);
    try {
      const result = await importPsd(this.store, this.assets, file, at);
      for (const w of result.warnings) console.warn(`[PSD] ${w}`);
      const parts = [
        `Imported ${result.symbolName}:`,
        `${result.images} image${result.images === 1 ? "" : "s"}`,
        `in ${result.symbols} symbol${result.symbols === 1 ? "" : "s"}`,
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
    on(this.el, "dragover", (e) => { stop(e); cls(this.el, "dropping", true); });
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
    const items = project.itemOrder
      .map((id) => project.items[id])
      .filter((i): i is LibraryItem => !!i)
      .filter((i) => i.id !== project.rootSymbolId)
      .filter((i) => !this.filter || i.name.toLowerCase().includes(this.filter))
      // `numeric` so leg_2 sorts before leg_10, which is how rigs are named.
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) * this.sortDir);

    if (items.length === 0) {
      this.list.appendChild(h("div", { class: "empty" },
        this.filter ? "No matching items" : "Import images with the button below, or drop them here"));
      this.renderPreview(null);
      return;
    }

    const usage = countUsages(this.store);
    for (const item of items) {
      const selected = this.store.selection.items.includes(item.id);
      const row = h("div", { class: `lib-row${selected ? " selected" : ""}`, draggable: true },
        h("div", { class: "nm" },
          wrapIcon(isSymbol(item) ? "symbolItem" : "imageItem"),
          h("span", null, item.name)),
        h("div", { class: "use" }, String(usage.get(item.id) ?? 0)),
      );

      on(row, "click", () => { this.store.selectItems([item.id]); this.renderPreview(item); });
      on(row, "dblclick", (ev) => {
        // Double-clicking the NAME renames; anywhere else on a symbol row
        // opens it for editing, as it does in Flash.
        const onName = !!(ev.target as HTMLElement).closest(".nm span");
        if (isSymbol(item) && !onName) this.onEditSymbol(item.id);
        else this.beginRename(row, item);
      });
      on(row, "dragstart", (ev) => {
        const e = ev as unknown as DragEvent;
        e.dataTransfer?.setData("application/x-animo-item", item.id);
        e.dataTransfer!.effectAllowed = "copy";
      });
      on(row, "contextmenu", (ev) => {
        const e = ev as unknown as MouseEvent;
        e.preventDefault();
        this.store.selectItems([item.id]);
        this.renderPreview(item);
        this.onContextMenu(item.id, e.clientX, e.clientY);
      });
      this.list.appendChild(row);
    }

    const sel = this.store.selection.items[0];
    this.renderPreview(sel ? project.items[sel] ?? null : null);
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
    this.store.selectItems([itemId]);
    this.renderList();
    const row = this.list.querySelector(".lib-row.selected");
    row?.scrollIntoView({ block: "nearest" });
  }

  private beginRename(row: HTMLElement, item: LibraryItem): void {
    const span = row.querySelector(".nm span");
    if (!span) return;
    const input = h("input", { type: "text", value: item.name });
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
      if (keep && name && name !== item.name) {
        if (RenameLibraryItem.clashes(this.store.project, item.id, name)) {
          this.onStatus(`Another library item is already called "${name}"`, true);
        } else {
          this.store.apply(new RenameLibraryItem(item.id, name));
        }
      }
      this.renderList();
    };
    on(input, "blur", () => finish(true));
    on(input, "keydown", (ev) => {
      const e = ev as unknown as KeyboardEvent;
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

  private deleteSelected(): void {
    const ids = this.store.selection.items;
    if (!ids.length) return;
    const usage = countUsages(this.store);
    const blocked = ids.filter((id) => (usage.get(id) ?? 0) > 0);
    if (blocked.length) {
      const names = blocked.map((id) => this.store.project.items[id]?.name ?? id).join(", ");
      console.warn(`[Animo] Still in use, not deleted: ${names}`);
      return;
    }
    this.store.transaction("Delete Library Items", () => {
      for (const id of ids) this.store.apply(new RemoveLibraryItem(id));
    });
    this.store.selectItems([]);
    this.store.emit("library");
  }

  /** Called by the stage when a library row is dropped onto it. */
  place(itemId: ItemId, x: number, y: number): void { this.onPlace(itemId, x, y); }
}

function wrapIcon(name: "imageItem" | "symbolItem"): HTMLElement {
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
