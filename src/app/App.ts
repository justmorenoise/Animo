import { h, on } from "@/view/widgets/dom";
import { SNAP_TARGETS, Store, type ToolId } from "./Store";
import { type MenuDef, type MenuItemDef, Shell } from "./Shell";
import { Keymap } from "./Keymap";
import { COMMANDS_BY_ID, PANEL_COMMANDS } from "@/core/keys/commands";
import { openKeymapDialog } from "@/view/prefs/KeymapDialog";
import { openSettings } from "@/view/prefs/SettingsDialog";
import { openExportSettings } from "@/view/export/ExportSettingsDialog";
import type { PrefsCategory } from "@/core/prefs/prefs";
import { applyTheme } from "@/view/prefs/theme";
import { AssetStore } from "./AssetStore";
import { createLayer, createNode, createProject } from "@/core/doc/defaults";
import { Viewport } from "@/view/viewport/Viewport";
import { contentMatrixOf } from "@/view/viewport/SceneRenderer";
import { countUsages, LibraryPanel } from "@/view/panels/LibraryPanel";
import { PropertiesPanel } from "@/view/panels/PropertiesPanel";
import { OutlinePanel } from "@/view/panels/OutlinePanel";
import { HistoryPanel } from "@/view/panels/HistoryPanel";
import { PreviewPanel } from "@/view/panels/PreviewPanel";
import { PreviewSession } from "@/preview/PreviewSession";
import { extensionHelpEntries } from "@/view/help/ExtensionHelp";
import { openAbout } from "@/view/help/AboutDialog";
import { APP_NAME } from "@/core/about";
import { StagePlay } from "@/view/viewport/StagePlay";
import { TimelinePanel } from "@/view/timeline/TimelinePanel";
import { buildExport, bundleZip, exportFiles, exportSettingsOf, safeFileName } from "@/io/export/ExportBundle";
import {
    type FileRef,
    hasDirectoryPicker,
    hasNativeFiles,
    pickDirectory,
    pickSaveLocation,
    PNG_TYPE,
    writeFile,
    writeIntoDirectory,
    ZIP_TYPE,
} from "@/io/project/FileSystem";
import { ProjectService } from "./ProjectService";
import { Toast } from "@/view/widgets/Toast";
import { Clipboard } from "./Clipboard";
import {
    AddNode,
    type MaskState,
    RemoveNodes,
    RenameLibraryItem,
    ReplaceImageAsset,
    SetLayerMasks,
    SetNodeItem,
    SetParent,
} from "@/core/history/commands";
import { maskCandidate, nearestMaskAbove } from "@/core/doc/layerTree";
import { AddSymbol, ConvertToSymbol, DuplicateLibraryItem, wouldCreateCycle, } from "@/core/history/symbolCommands";
import { evaluateSymbol, pointInParent } from "@/core/doc/pose";
import { mayReparent } from "@/view/widgets/ikReparentGuard";
import { menuAnchor, type MenuEntry, showMenu } from "@/view/widgets/Dock";
import type { Layer, Node } from "@/core/doc/types";
import { isImage, isSymbol } from "@/core/doc/types";
import { itemsOf } from "@/core/doc/displays";
import {
    applyEdit,
    displayAtFrame,
    doClearKeyframe,
    doInsertBlankKeyframe,
    doInsertFrame,
    doInsertKeyframe,
    doRemoveFrame,
    fillEmptyNode,
    transformAtFrame,
} from "./TimelineOps";
import type { AssetId, ItemId, LayerId, NodeId } from "@/core/doc/ids";
import { cloneTf, type Transform } from "@/core/math/Transform";
import { applyVec, mat } from "@/core/math/Matrix2D";
import { moveBy, snapshotOf, topmostSelected } from "@/view/tools/transformOps";
import { alertDialog, confirmDialog, promptText } from "@/view/widgets/dialogs";
import { AtlasTooSmall, oversizeAdvice } from "@/core/atlas/oversize";
import { busy } from "@/view/widgets/Busy";
import { phase } from "./busy";

export class App {
  readonly store: Store;
  readonly shell: Shell;
  readonly assets = new AssetStore();
  readonly viewport: Viewport;
  private library: LibraryPanel;
  private previewSession: PreviewSession;
  private play: StagePlay;
  private preview: PreviewPanel;
  readonly timeline: TimelinePanel;
  readonly project: ProjectService;
  private toast = new Toast();
  /** The "unsaved work was found" bar, while it is on screen. */
  private recoveryBar: HTMLElement | null = null;
  readonly clipboard = new Clipboard();
  readonly keymap: Keymap;

  constructor(root: HTMLElement) {
    this.store = new Store(createProject("Untitled"));
    applyTheme(this.store.prefs.value);
    // Before the shell and the panels, which read accelerators as they build.
    this.keymap = new Keymap(this.store);
    this.shell = new Shell(this.store);
    this.shell.onBrand = () => openAbout();
    root.appendChild(this.shell.el);

    this.viewport = new Viewport(this.shell.stageHost, this.store, this.assets);
    this.viewport.onContextMenu = (x, y) => this.stageMenu(x, y);
    this.viewport.assetsRef = this.assets;


    this.library = new LibraryPanel(
      this.store, this.assets,
      (itemId, x, y) => this.placeItem(itemId, x, y),
      (itemId) => { this.store.openSymbol(itemId); this.viewport.fitToStage(); },
      () => this.newSymbol(),
      (itemId, x, y) => this.libraryMenu(itemId, x, y),
      (message, isError) => this.toast.show(message, isError),
    );
    this.previewSession = new PreviewSession(this.store, this.assets, (err) => this.previewBuilt(err));
    this.preview = new PreviewPanel(
      this.previewSession,
      () => this.shell.floatPanel("preview"),
    );
    this.timeline = new TimelinePanel(this.store, this.clipboard, () => this.onionPopup());
    this.play = new StagePlay(
      this.store, this.previewSession, this.shell.stageHost,
      () => this.timeline.playback.pause(),
    );
    this.shell.playSlot.appendChild(this.play.controls);

    this.registerPanels();
    this.shell.layoutDocks(
      [["properties"], ["library", "outline"], ["preview"]],
      [["timeline"]],
    );

    document.body.appendChild(this.toast.el);
    this.project = new ProjectService(
      this.store,
      this.assets,
      {
        onStatus: (msg, isError) => this.toast.show(msg, isError),
        confirmDiscard: () => confirmDialog({
          title: "Unsaved changes",
          message: `${this.project.fileName} has changes that are not saved. Discard them?`,
          ok: "Discard", cancel: "Keep Editing", danger: true,
        }),
        busy,
        onLoaded: (diagnostics) => {
          for (const d of diagnostics) {
            (d.severity === "error" ? console.error : console.warn)(`[Project] ${d.path}: ${d.message}`);
          }
        },
      },
      () => this.afterProjectReplaced(),
    );

    this.shell.docTitle = () => this.project.fileName;
    this.shell.syncDocName();

    this.suppressBrowserMenu();
    // Preferences are live: a change repaints the chrome, re-syncs the six
    // switches the View menu shares with them, and redraws both canvases.
    this.store.prefs.subscribe((p) => {
      applyTheme(p);
      this.store.setUi({
        showGrid: p.stage.showGrid,
        showRulers: p.stage.showRulers,
        showGuides: p.stage.showGuides,
        snap: p.snap.enabled,
        showBones: p.gizmos.showBones,
        showGizmos: p.gizmos.showGizmos,
      }, "stage");
      this.store.emit("timeline");
    });

    this.registerCommands();
    // After the commands: the parts of `buildMenus` that are genuinely eager —
    // the Onion Skin Options submenu, the Snap To labels — read the registry
    // as they are built.
    this.shell.setMenus(this.buildMenus());
    this.keymap.install();
    this.wireStageDrops();
    this.viewport.fitToStage();
    void this.offerRecovery();
  }

  /**
   * No browser menu anywhere in the editor.
   *
   * The panels that have their own context menu already call
   * `preventDefault`, but everything between them — panel chrome, tab strips,
   * toolbars, the library's empty space, the timeline's ruler — fell through
   * to Chrome's Back / Reload / Save as…, which in an app whose ⌘S is a
   * project save is worse than useless.
   *
   * Text fields keep theirs: Cut / Copy / Paste / Undo on a name being typed
   * is a real menu the app does not replace, and the browser's spell-check
   * entries only exist there.
   */
  private suppressBrowserMenu(): void {
    // On the DOCUMENT, not on the app root: floating panels, the toast and
    // the context menus themselves are appended to `document.body`, outside
    // the root, and a right-click on an open menu was one of the places the
    // browser's own menu still appeared.
    on(document, "contextmenu", (ev) => {
      const e = ev as unknown as MouseEvent;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable=\"true\"]")) return;
      e.preventDefault();
    });
  }

  private registerPanels(): void {
    this.shell.addRightPanel(new PropertiesPanel(this.store, () => this.viewport.pose, () => this.viewport.editPoses(true)));
    this.shell.addRightPanel(this.library);
    this.shell.addRightPanel(new OutlinePanel(this.store));
    this.shell.addRightPanel(new HistoryPanel(this.store));
    this.shell.addRightPanel(this.preview);

    this.shell.addBottomPanel(this.timeline);
  }

  /**
   * Copy, cut and paste follow the focus: a run of frames selected in the
   * timeline takes precedence, otherwise it is the stage objects. One
   * shortcut, two meanings, decided by what the user last touched.
   */
  copy(): void {
    if (this.timeline.hasFrameSelection) {
      const n = this.timeline.copyFrames();
      if (n) this.toast.show(`Copied ${n} frame${n > 1 ? "s" : ""}`);
      return;
    }
    const n = this.clipboard.copy(this.store);
    if (n) this.toast.show(`Copied ${n} object${n > 1 ? "s" : ""}`);
  }

  cut(): void {
    if (this.timeline.hasFrameSelection) { this.timeline.cutFrames(); return; }
    this.clipboard.cut(this.store);
  }

  paste(): void {
    if (this.timeline.frames.hasContent && this.timeline.hasFrameSelection) {
      this.timeline.pasteFrames();
      return;
    }
    if (this.clipboard.hasContent) { this.clipboard.paste(this.store); return; }
    this.timeline.pasteFrames();
  }

  /* ── Context menus ─────────────────────────────────────────────────────*/

  /** An anchor for showMenu at an arbitrary screen point. */
  private stageMenu(x: number, y: number): void {
    const s = this.store;
    const hasSelection = s.selection.nodes.length > 0;
    const symbolId = this.selectedSymbolItem();
    // The library item the selection was made from — an image as much as a
    // symbol, so this works for any instance.
    const sourceItem = s.selectedNodes
      .map((n) => displayAtFrame(s, n).display?.itemId)
      .find((id) => id !== undefined) ?? null;
    const convertProblem = hasSelection
      ? ConvertToSymbol.validate(s.project, s.currentSymbolId, s.selection.nodes)
      : "nothing selected";

    showMenu(menuAnchor(x, y), [
      {
        label: "Convert to Symbol…", command: "modify.convertToSymbol",
        enabled: convertProblem === null,
        run: () => this.convertToSymbol(),
      },
      {
        label: "Edit Symbol", command: "modify.editSymbol",
        enabled: symbolId !== null,
        run: () => this.enterSelectedSymbol(),
      },
      {
        // Which library item is this instance? There is otherwise no way back
        // from an object on the stage to the thing it was made from.
        label: "Show in Library",
        enabled: sourceItem !== null,
        run: () => {
          if (!sourceItem) return;
          this.shell.showPanel("library");
          this.library.revealItem(sourceItem);
        },
      },
      {
        label: "Swap Instance",
        enabled: this.canSwapInstance(),
        run: () => this.swapInstance(),
      },
      { label: "Group", command: "modify.group", enabled: hasSelection, run: () => this.timeline.addGroup() },
      "-",
      { label: "Cut", command: "edit.cut", enabled: hasSelection, run: () => this.cut() },
      { label: "Copy", command: "edit.copy", enabled: hasSelection, run: () => this.copy() },
      { label: "Paste", command: "edit.paste", enabled: this.clipboard.hasContent, run: () => this.paste() },
      {
        label: "Duplicate", command: "edit.duplicate",
        enabled: hasSelection, run: () => this.clipboard.duplicate(s),
      },
      "-",
      {
        label: "Copy Properties", command: "edit.copyProperties",
        enabled: hasSelection, run: () => { this.clipboard.copyProperties(s); },
      },
      {
        label: "Paste Properties", command: "edit.pasteProperties",
        enabled: this.clipboard.hasProperties && hasSelection,
        run: () => { this.clipboard.pasteProperties(s, true); },
      },
      "-",
      {
        label: "Delete", command: "edit.delete",
        enabled: hasSelection,
        run: () => {
          s.apply(new RemoveNodes(s.currentSymbolId, [...s.selection.nodes]));
          s.clearSelection();
          s.emit("doc");
        },
      },
    ]);
  }

  /** Right-click menu for a library row. */
  libraryMenu(itemId: ItemId, x: number, y: number): void {
    const s = this.store;
    const item = s.project.items[itemId];
    if (!item) return;
    const usage = countUsages(s).get(itemId) ?? 0;

    showMenu(menuAnchor(x, y), [
      {
        label: "Edit", enabled: isSymbol(item),
        run: () => { s.openSymbol(itemId); this.viewport.fitToStage(); },
      },
      {
        label: "Place on Stage",
        // A symbol cannot contain itself; `placeItem` refuses with a toast,
        // which is the right answer for a drop but not for a menu row.
        enabled: !isSymbol(item)
          || !wouldCreateCycle(s.project, s.currentSymbolId, itemId),
        run: () => {
          const c = this.viewport.camera;
          const w = c.toWorld(c.width / 2, c.height / 2);
          this.placeItem(itemId, Math.round(w.x), Math.round(w.y));
        },
      },
      "-",
      { label: "Rename…", run: () => this.renameLibraryItem(itemId) },
      { label: "Duplicate", run: () => this.duplicateLibraryItem(itemId) },
      { label: "Export as .png…", run: () => void this.exportItemPng(itemId) },
      {
        label: "Replace Image…", enabled: isImage(item),
        run: () => void this.replaceImage(itemId),
      },
      { label: "New Folder", run: () => this.library.newFolder() },
      "-",
      {
        // Enabled even when used: the panel says where it is used.
        label: usage > 0 ? `Delete (used ${usage}×)` : "Delete",
        enabled: itemId !== s.project.rootSymbolId,
        run: () => void this.library.deleteItem(itemId),
      },
    ]);
  }

  private async renameLibraryItem(itemId: ItemId): Promise<void> {
    const item = this.store.project.items[itemId];
    if (!item) return;
    const name = await promptText({
      title: "Rename", label: "Name", value: item.name, ok: "Rename",
      validate: (text) => text !== item.name && RenameLibraryItem.clashes(this.store.project, itemId, text)
        ? `Another library item is already called "${text}".` : null,
    });
    if (!name || name === item.name || this.store.project.items[itemId] !== item) return;
    this.store.apply(new RenameLibraryItem(itemId, name));
    this.store.emit("library");
    this.store.emit("doc");
  }

  private duplicateLibraryItem(itemId: ItemId): void {
    const item = this.store.project.items[itemId];
    if (!item) return;
    const cmd = new DuplicateLibraryItem(itemId, uniqueSymbolName(this.store, item.name));
    this.store.apply(cmd);
    this.store.emit("library");
    if (cmd.newItemId) this.store.selectItems([cmd.newItemId]);
  }

  /* ── Symbols ───────────────────────────────────────────────────────────*/

  /** Wrap the selection into a reusable Symbol, leaving one instance behind. */
  async convertToSymbol(): Promise<void> {
    const ids = [...this.store.selection.nodes];
    const problem = ConvertToSymbol.validate(this.store.project, this.store.currentSymbolId, ids);
    if (problem) { this.toast.show(problem, true); return; }

    const suggested = uniqueSymbolName(this.store, ids.length === 1
      ? this.store.node(ids[0]!)?.name ?? "Symbol"
      : "Symbol");
    const name = await promptText({ title: "Convert to Symbol", label: "Name", value: suggested, ok: "Convert" });
    if (!name) return;
    // The dialog is not modal to the document's timers: check again.
    const late = ConvertToSymbol.validate(this.store.project, this.store.currentSymbolId, ids);
    if (late) { this.toast.show(late, true); return; }

    const cmd = new ConvertToSymbol(this.store.currentSymbolId, ids, name);
    this.store.apply(cmd);
    if (cmd.instance) this.store.selectNodes([cmd.instance.id]);
    this.store.emit("doc");
    this.store.emit("library");
    this.toast.show(`Created symbol "${name}"`);
  }

  async newSymbol(): Promise<void> {
    const name = await promptText({
      title: "New Symbol", label: "Name", value: uniqueSymbolName(this.store, "Symbol"), ok: "Create",
    });
    if (!name) return;
    const cmd = new AddSymbol(name);
    this.store.apply(cmd);
    this.store.emit("library");
    this.store.selectItems([cmd.symbol.id]);
    this.store.openSymbol(cmd.symbol.id);
  }

  /** The library item behind the current selection, when it is a symbol. */
  private selectedSymbolItem(): ItemId | null {
    const fromStage = this.store.selectedNodes[0];
    const shown = fromStage ? displayAtFrame(this.store, fromStage).display : null;
    if (shown && isSymbol(this.store.project.items[shown.itemId])) return shown.itemId;
    const fromLibrary = this.store.selection.items[0];
    const item = fromLibrary ? this.store.project.items[fromLibrary] : undefined;
    return item?.kind === "symbol" ? item.id : null;
  }

  /** Edit in place, the way double-clicking a symbol works in Flash. */
  enterSelectedSymbol(): boolean {
    const id = this.selectedSymbolItem();
    if (!id) return false;
    // From a stage instance, align with where it sits; from the library there
    // is no instance to align with, so fit the view instead.
    const node = this.store.selectedNodes[0];
    const world = node ? this.viewport.pose?.byNode.get(node.id)?.world : undefined;
    const shown = node ? displayAtFrame(this.store, node).display : null;
    if (world && node && shown?.itemId === id) {
      this.store.enterSymbol(id, contentMatrixOf(world, shown.pivot), node.id);
    } else {
      this.store.openSymbol(id);
      this.viewport.fitToStage();
    }
    return true;
  }

  /** Reset everything derived from the old document. */
  private afterProjectReplaced(): void {
    // `loadFrom` swaps the document before it stores the new file handle, so
    // the tab has to be re-read here rather than on the "doc" it emits.
    this.shell.syncDocName();
    this.play.setMode(false);
    this.viewport.clearCaches();
    this.viewport.clearGuides();
    this.viewport.fitToStage();
    this.timeline.playback.pause();
    this.clipboard.reset();
    this.timeline.frames.reset();
    this.recoveryBar?.remove();
    this.recoveryBar = null;
    // `replaceProject` emits "doc", which the session listens to; this says
    // out loud that the preview must not survive the document it was built
    // from.
    this.previewSession.invalidate();
  }

  /**
   * Offer to restore an autosave. Only surfaced when there is actually
   * something to restore — an empty new project is not worth a prompt.
   */
  private async offerRecovery(): Promise<void> {
    const record = await this.project.findRecovery();
    if (!record) return;

    const when = new Date(record.savedAt).toLocaleString();
    const bar = h("div", { class: "recovery" },
      h("span", null, `Unsaved work from ${when} was found.`),
      h("div", { class: "spacer" }),
    );
    const restore = h("button", { class: "btn" }, "Restore");
    const discard = h("button", { class: "btn" }, "Discard");
    bar.append(restore, discard);

    const close = () => { bar.remove(); this.recoveryBar = null; };
    restore.addEventListener("click", () => {
      // Asks first, as Open does: by now there may be work of its own here.
      void this.project.recover(record).then((ok) => { if (ok) close(); });
    });
    discard.addEventListener("click", () => {
      close();
      void this.project.discardRecovery(record);
    });

    this.recoveryBar = bar;
    this.shell.el.parentElement?.insertBefore(bar, this.shell.el);
  }

  // ── Placing library items on the stage ─────────────────────────────────

  /** Creates a node + layer for a library item, centred on (x, y) in world space. */
  placeItem(itemId: ItemId, x: number, y: number): void {
    const item = this.store.project.items[itemId];
    if (!item) return;

    // A symbol cannot contain itself, directly or through any chain.
    if (item.kind === "symbol" &&
        wouldCreateCycle(this.store.project, this.store.currentSymbolId, itemId)) {
      this.toast.show(`"${item.name}" cannot be placed inside itself`, true);
      return;
    }

    // Default the transform point to the image's centre, as Flash does.
    const pivotX = isImage(item) ? item.width / 2 : 0;
    const pivotY = isImage(item) ? item.height / 2 : 0;

    // An empty layer is a destination, not a neighbour: fill it in place so
    // the row keeps its id, its name and its place in the stack instead of a
    // new layer appearing on top of it.
    const empty = this.selectedEmptyNode();
    if (empty) {
      // The pose on screen: the pointer is where the user saw the group.
      const pose = this.viewport.pose ?? evaluateSymbol(
        this.store.currentSymbol, this.store.currentAnimation, this.store.ui.frame, this.store.ui.mode);
      const local = pointInParent(pose, empty, x, y);
      const at = { ...cloneTf(empty.bind), x: Math.round(local.x), y: Math.round(local.y) };
      this.store.transaction(`Add ${item.name}`, () => {
        fillEmptyNode(this.store, empty.id, {
          itemId, kind: isImage(item) ? "image" : "symbol", pivot: { x: pivotX, y: pivotY }, transform: at,
        });
      });
      this.store.emit("doc");
      return;
    }

    const node = createNode(isImage(item) ? "image" : "symbol", uniqueNodeName(this.store, item.name), {
      itemId, x: Math.round(x), y: Math.round(y), pivotX, pivotY,
    });
    const layer = createLayer(node.id, node.name, this.store.currentSymbol.layers.length);

    this.store.apply(new AddNode(`Add ${item.name}`, this.store.currentSymbolId, node, layer, 0));
    this.store.selectNodes([node.id]);
    this.store.emit("doc");
  }

  /** The one selected empty layer, when that is what the selection is. */
  private selectedEmptyNode(): Node | null {
    const sym = this.store.currentSymbol;
    const ids = this.store.selection.nodes.filter((id) => sym.nodes[id]);
    if (ids.length !== 1) return null;
    const node = sym.nodes[ids[0]!]!;
    return node.kind === "empty" ? node : null;
  }

  /**
   * Swap the selected instances onto the library item that is selected —
   * Flash's Swap Symbol.
   *
   * The pose is not touched: the display is the only stored thing that
   * distinguishes one instance from another, so keyframes, IK, children
   * and the transform point all survive by staying where they are. With a
   * differently sized image the artwork therefore shifts relative to its
   * anchor, which is exactly what Flash does. On a layer that switches
   * artwork it is the display showing at the playhead that is swapped, on
   * every key that shows it.
   */
  swapInstance(): void {
    const s = this.store;
    const itemId = s.selection.items[0];
    const item = itemId ? s.project.items[itemId] : undefined;
    if (!item || !itemId) return;

    if (item.kind === "symbol" && wouldCreateCycle(s.project, s.currentSymbolId, itemId)) {
      this.toast.show(`"${item.name}" cannot be placed inside itself`, true);
      return;
    }

    const sym = s.currentSymbol;
    const kind = isImage(item) ? "image" as const : "symbol" as const;
    const next = new Map<NodeId, { itemId: ItemId; kind: "image" | "symbol"; display: number }>();
    for (const id of s.selection.nodes) {
      const n = sym.nodes[id];
      // Bones and groups are not instances; an empty layer is a legitimate
      // target, and swapping it is how it stops being empty.
      if (!n || n.kind === "bone" || n.kind === "group") continue;
      next.set(id, { itemId, kind, display: displayAtFrame(s, n).index });
    }
    if (!next.size) return;

    s.apply(new SetNodeItem(s.currentSymbolId, next));
    s.emit("doc");
    this.toast.show(`Swapped ${next.size === 1 ? "1 instance" : `${next.size} instances`} to "${item.name}"`);
  }

  /** Whether Swap Instance has both halves of what it needs. */
  private canSwapInstance(): boolean {
    const s = this.store;
    if (s.selection.items.length !== 1) return false;
    const sym = s.currentSymbol;
    return s.selection.nodes.some((id) => {
      const k = sym.nodes[id]?.kind;
      return k === "image" || k === "symbol" || k === "empty";
    });
  }

  private wireStageDrops(): void {
    const host = this.shell.stageHost;
    const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };

    on(host, "dragover", (e) => {
      stop(e);
      (e as unknown as DragEvent).dataTransfer!.dropEffect = "copy";
    });

    on(host, "drop", async (ev) => {
      stop(ev);
      const e = ev as unknown as DragEvent;
      const w = this.viewport.toWorld(e as unknown as MouseEvent);

      const itemId = e.dataTransfer?.getData("application/x-animo-item");
      if (itemId) { this.placeItem(itemId as ItemId, w.x, w.y); return; }

      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) {
        // Only the items the import wants placed: a PSD brings a whole tree
        // into the library but puts exactly one thing on the stage itself.
        const added = await this.library.importFiles(files, w);
        added.forEach((id, i) => this.placeItem(id, w.x + i * 12, w.y + i * 12));
      }
    });
  }

  /**
   * Arrow-key nudge: one scene pixel in the arrow's direction ON SCREEN, the
   * way a drag moves things. Adding to the local x/y moved a node along its
   * parent's axes — diagonally under a rotated bone — and moved a selected
   * child a second time on top of its selected parent's move.
   */
  private nudge(dx: number, dy: number): void {
    const s = this.store;
    const sym = s.currentSymbol;
    const pose = this.viewport.pose;
    const locked = new Set(sym.layers.filter((l) => l.locked).map((l) => l.nodeId));
    const ids = topmostSelected(
      s.selection.nodes.filter((id) => sym.nodes[id] && !locked.has(id)),
      (id) => sym.nodes[id]?.parentId,
    );
    // The edited symbol may sit rotated or scaled inside the scene.
    const d = applyVec({ x: 0, y: 0 }, s.sceneMatrix, dx, dy);
    const next = new Map<NodeId, Transform>();
    for (const id of ids) {
      const n = sym.nodes[id]!;
      const parent = n.parentId ? pose?.byNode.get(n.parentId)?.world : undefined;
      // What is on screen at the playhead, not the bind pose: otherwise
      // nudging an animated object silently edits its bone origin.
      next.set(id, moveBy(snapshotOf(id, transformAtFrame(s, n), mat(), parent), d.x, d.y));
    }
    if (next.size) applyEdit(s, next);
  }

  /**
   * Build the DragonBones bundle and write it where the user says.
   *
   * The location is asked for BEFORE the build, not after. `showSaveFilePicker`
   * needs transient user activation, and packing an atlas can easily outlive
   * the few seconds that lasts — ask late and the export dies on a gesture
   * error instead of saving. It also puts the question where the user expects
   * it, right after choosing the command.
   *
   * The name defaults to the project's, which is also what the skeleton and
   * the atlas pages are named after — one name for the whole export, so the
   * pieces stay recognisably a set.
   */
  /**
   * One library item as a PNG.
   *
   * The location is asked for BEFORE the raster, because `showSaveFilePicker`
   * needs transient user activation and an `await` in front of it throws that
   * away — the same rule the project export follows.
   */
  private async exportItemPng(itemId: ItemId): Promise<void> {
    const item = this.store.project.items[itemId];
    if (!item) return;

    const suggested = `${safeFileName(item.name)}.png`;
    let target: FileRef | null;
    if (hasNativeFiles()) {
      target = await pickSaveLocation(suggested, PNG_TYPE, "animo-png");
    } else {
      const name = await promptText({ title: "Export PNG", label: "File name", value: suggested, ok: "Export" });
      target = name ? { name: name.endsWith(".png") ? name : `${name}.png` } : null;
    }
    if (!target) return;

    try {
      const blob = await busy(`Exporting ${target.name}`, () => this.library.renderItemPng(itemId));
      if (!blob) {
        this.toast.show(`"${item.name}" has nothing to draw`, true);
        return;
      }
      await writeFile(target, blob);
      this.toast.show(`Exported ${target.name}`);
    } catch (err) {
      this.toast.show(`Could not export the PNG: ${(err as Error).message}`, true);
    }
  }

  /**
   * Swap the pixels behind an image, keeping the library item — every
   * instance, keyframe and IK constraint that references it keeps working.
   *
   * Transform points are deliberately left where they are, so an image of a
   * different size re-anchors: the exporter normalises pivots against the
   * untrimmed size, which makes that visible in the runtime, so it is said
   * out loud rather than discovered later.
   */
  private async replaceImage(itemId: ItemId): Promise<void> {
    const s = this.store;
    const item = s.project.items[itemId];
    if (!isImage(item)) return;

    const file = await this.library.pickImage();
    if (!file) return;

    let next: { assetId: AssetId; width: number; height: number };
    try {
      // Registered BEFORE the command: `apply` has to stay pure, so the I/O
      // cannot live inside it.
      next = await this.library.addAsset(file);
    } catch (err) {
      this.toast.show(`Could not read ${file.name}: ${(err as Error).message}`, true);
      return;
    }
    if (next.assetId === item.assetId) {
      this.toast.show(`"${item.name}" already uses those exact pixels`);
      return;
    }

    const was = { width: item.width, height: item.height };
    const usage = countUsages(s).get(itemId) ?? 0;
    s.apply(new ReplaceImageAsset(itemId, next, this.symbolsUsing(itemId)));
    this.viewport.clearCaches();
    s.emit("library");
    s.emit("doc");

    if (was.width !== next.width || was.height !== next.height) {
      this.toast.show(
        `"${item.name}" is now ${next.width}×${next.height} (was ${was.width}×${was.height}). ` +
        `The transform point${usage === 1 ? " of its 1 instance has" : `s of its ${usage} instances have`} not moved.`,
      );
    } else {
      this.toast.show(`Replaced "${item.name}"`);
    }
  }

  /** Symbols holding an instance of an item, so their bounds are refreshed. */
  private symbolsUsing(itemId: ItemId): ItemId[] {
    const out: ItemId[] = [];
    for (const candidate of Object.values(this.store.project.items)) {
      if (!isSymbol(candidate)) continue;
      if (Object.values(candidate.nodes).some((n) => itemsOf(n).includes(itemId))) out.push(candidate.id);
    }
    return out;
  }

  async exportProject(): Promise<void> {
    const suggested = `${safeFileName(this.store.project.name)}_dragonbones.zip`;
    let target: FileRef | null;
    if (hasNativeFiles()) {
      target = await pickSaveLocation(suggested, ZIP_TYPE, "animo-export");
    } else {
      const name = await promptText({ title: "Export DragonBones", label: "File name", value: suggested, ok: "Export" });
      target = name ? { name: name.endsWith(".zip") ? name : `${name}.zip` } : null;
    }
    if (!target) return;                        // cancelled
    const file = target;

    await busy(`Exporting ${file.name}`, async (report) => {
      const result = await this.buildForExport(phase(report, 0, 0.8));
      if (!result) return;
      try {
        await writeFile(file, await bundleZip(result));
        report(1);
        this.toast.show(
          `Exported ${file.name} (${result.pages.length} atlas page(s))` +
          (result.extensions ? ` with extensions ${result.extensions.extensionsUsed.join(", ")}` : ""),
        );
      } catch (err) {
        this.reportExportFailure(err);
      }
    });
  }

  /**
   * Write the same files loose into a folder instead of zipped.
   *
   * A runtime wants `_ske.json` next to its atlas pages; when the target is
   * an assets folder in a game project, unzipping first is a step that exists
   * only because the exporter insisted on a zip.
   */
  async exportToFolder(): Promise<void> {
    if (!hasDirectoryPicker()) {
      this.toast.show("This browser cannot choose a folder. Use Export DragonBones to get a zip instead.", true);
      return;
    }
    const dir = await pickDirectory("animo-export");
    if (!dir) return;                           // cancelled

    await busy(`Exporting to ${dir.name}`, async (report) => {
      const result = await this.buildForExport(phase(report, 0, 0.8));
      if (!result) return;
      try {
        const files = await exportFiles(result);
        const names = Object.keys(files);
        for (const [n, name] of names.entries()) {
          await writeIntoDirectory(dir, name, new Blob([files[name] as unknown as BlobPart]));
          report(0.8 + 0.2 * (n + 1) / names.length);
        }
        this.toast.show(
          `Exported ${names.length} file(s) to ${dir.name}` +
          (result.extensions ? ". README.md explains the extensions" : ""),
        );
      } catch (err) {
        this.reportExportFailure(err);
      }
    });
  }

  /** Shared front half: build, report diagnostics, refuse on errors. */
  private async buildForExport(
    report: (fraction: number) => void,
  ): Promise<Awaited<ReturnType<typeof buildExport>> | null> {
    try {
      const result = await buildExport(this.store.project, this.assets, undefined, report);
      for (const d of result.diagnostics) {
        (d.severity === "error" ? console.error : console.warn)(`[Export] ${d.message}`);
      }
      const errors = result.diagnostics.filter((d) => d.severity === "error");
      if (errors.length) {
        this.toast.show(`Export aborted: ${errors[0]!.message}`, true);
        return null;
      }
      return result;
    } catch (err) {
      this.reportExportFailure(err);
      return null;
    }
  }

  private reportExportFailure(err: unknown): void {
    if (err instanceof AtlasTooSmall) { void this.explainAtlasTooSmall(err); return; }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Export] Failed:", err);
    this.toast.show(`Export failed: ${msg}`, true);
  }

  /** The problem the last explanation was about, so the preview, which
   *  rebuilds after every edit, explains each problem once. */
  private explainedAtlas: string | null = null;

  private previewBuilt(err: unknown): void {
    if (!(err instanceof AtlasTooSmall)) {
      if (err === null) this.explainedAtlas = null;
      return;
    }
    const key = JSON.stringify([err.offenders, err.page]);
    if (key === this.explainedAtlas) return;
    this.explainedAtlas = key;
    void this.explainAtlasTooSmall(err);
  }

  private explainAtlasTooSmall(err: AtlasTooSmall): Promise<void> {
    const advice = oversizeAdvice(err.offenders, exportSettingsOf(this.store.project));
    return alertDialog({
      title: advice.title, message: advice.message, width: 460,
      extra: { label: "Export Settings…", run: () => openExportSettings(this.store) },
    });
  }

  /**
   * The recent-files section of the File menu.
   *
   * Reopening goes through the stored handle, so it is one click rather than
   * a picker — with the picker as the fallback when the handle no longer
   * resolves, which is the normal state of affairs after a browser restart.
   */
  private recentItems(): Array<MenuItemDef | "-"> {
    const recents = this.project.recents;
    if (recents.length === 0) return [];
    return [
      "-",
      ...recents.map((entry) => ({
        label: entry.name,
        run: () => void this.project.openRecent(entry),
      })),
      "-",
      { label: "Clear Recent Files", run: () => void this.project.clearRecentList() },
    ];
  }

  /** File ▸ Import PSD… — the same path as dropping one on the Library. */
  private pickPsd(): void {
    const input = h("input", { type: "file", accept: ".psd,image/vnd.adobe.photoshop" });
    input.style.display = "none";
    document.body.appendChild(input);
    on(input, "change", () => {
      const file = input.files?.[0];
      input.remove();
      if (file) void this.library.importFiles([file]);
    });
    input.click();
  }

  /**
   * Binding artwork to a bone is just reparenting it — parenting IS the
   * skeleton here — so this is `SetParent` with the world preserved, and the
   * artwork does not move when it becomes a child.
   */
  /* ── Mask layers ───────────────────────────────────────────────────────
     DragonBones has no mask concept, so this is an editor + Pixi-host
     feature: the stage clips, the export writes a sidecar, and
     the `ANIMO_masks` extension assigns `display.mask` in the game. A stock
     DragonBones player ignores it, which the export diagnostics say out
     loud.                                                                */

  /** The layer of the single selected node, or null. */
  private selectedLayer(): Layer | null {
    const s = this.store;
    if (s.selection.nodes.length !== 1) return null;
    return s.currentSymbol.layers.find((l) => l.nodeId === s.selection.nodes[0]) ?? null;
  }

  private canToggleMask(): boolean {
    const l = this.selectedLayer();
    if (!l) return false;
    // Turning it ON needs something below to clip; turning it OFF always works.
    return l.isMask === true || maskCandidate(this.store.currentSymbol, l.id) !== null;
  }

  private toggleMask(): void {
    const sym = this.store.currentSymbol;
    const layer = this.selectedLayer();
    if (!layer) return;
    const next = new Map<LayerId, MaskState>();

    if (layer.isMask) {
      next.set(layer.id, {});
      // Every link pointing at it has to go too, or normalizeMasks would drop
      // them anyway and the undo would only restore half the relationship.
      for (const l of sym.layers) {
        if (l.maskedBy === layer.id) next.set(l.id, { isMask: l.isMask });
      }
    } else {
      const below = maskCandidate(sym, layer.id);
      if (!below) return;
      next.set(layer.id, { isMask: true });
      next.set(below.id, { maskedBy: layer.id });
    }

    this.store.apply(new SetLayerMasks(this.store.currentSymbolId, next));
    this.store.emit("stage");
    this.store.emit("timeline");
  }

  private canToggleMasked(): boolean {
    const l = this.selectedLayer();
    if (!l || l.isMask) return false;
    return !!l.maskedBy || nearestMaskAbove(this.store.currentSymbol, l.id) !== null;
  }

  private toggleMasked(): void {
    const layer = this.selectedLayer();
    if (!layer || layer.isMask) return;
    const mask = layer.maskedBy ? null : nearestMaskAbove(this.store.currentSymbol, layer.id);
    if (!layer.maskedBy && !mask) return;

    this.store.apply(new SetLayerMasks(
      this.store.currentSymbolId,
      new Map([[layer.id, mask ? { maskedBy: mask.id } : {}]]),
    ));
    this.store.emit("stage");
    this.store.emit("timeline");
  }

  private bindableToBone(): { boneId: NodeId; ids: NodeId[]; name: string } | null {
    const nodes = this.store.selectedNodes;
    const bones = nodes.filter((n) => n.kind === "bone");
    const rest = nodes.filter((n) => n.kind !== "bone");
    if (bones.length !== 1 || rest.length === 0) return null;
    return { boneId: bones[0]!.id, ids: rest.map((n) => n.id), name: bones[0]!.name };
  }

  private bindToBone(): void {
    const bind = this.bindableToBone();
    if (!bind) return;
    if (!mayReparent(this.store, bind.ids)) return;
    this.store.apply(new SetParent(this.store.currentSymbolId, bind.ids, bind.boneId, true));
    this.store.emit("doc");
    this.toast.show(
      `Bound ${bind.ids.length} object${bind.ids.length > 1 ? "s" : ""} to ${bind.name}`,
    );
  }

  // ── Menus ──────────────────────────────────────────────────────────────

  /** The Preferences dialog. One place for the parameters that used to be
   *  literals spread across the viewport, the timeline and the autosaver. */
  openPreferences(category?: PrefsCategory): void {
    openSettings(this.store, {
      resetLayout: () => this.shell.resetLayout(),
      keymap: this.keymap,
      toast: (msg, isError) => this.toast.show(msg, isError),
      // Customize… from there just returns to the Preferences already open.
      showShortcuts: () => openKeymapDialog(this.keymap, () => {}),
    }, category);
  }

  private buildMenus(): MenuDef[] {
    const it = (id: string, extra: Partial<MenuItemDef> = {}) => this.menuItem(id, extra);
    return [
      {
        label: "File",
        // Built when the menu opens: the recent list changes as you work.
        items: () => [
          it("file.new"),
          it("file.open"),
          ...this.recentItems(),
          "-",
          it("file.save"),
          it("file.saveAs"),
          "-",
          it("file.importImages"),
          it("file.importPsd"),
          it("file.export"),
          it("file.exportFolder"),
          it("file.exportSettings"),
        ],
      },
      {
        label: "Edit",
        items: [
          it("edit.undo"),
          it("edit.redo"),
          "-",
          it("edit.cut"),
          it("edit.copy"),
          it("edit.paste"),
          it("edit.pasteOverwriteFrames"),
          it("edit.duplicate"),
          "-",
          it("edit.copyProperties"),
          it("edit.pasteProperties"),
          it("edit.pastePropertiesNoPosition"),
          "-",
          it("edit.selectAll"),
          it("edit.deselectAll"),
          it("edit.selectAllFrames"),
          "-",
          it("edit.newLayer"),
          it("edit.copyLayers"),
          it("edit.pasteLayers"),
          it("edit.duplicateLayers"),
          "-",
          it("edit.preferences"),
          "-",
          it("edit.delete"),
        ],
      },
      {
        label: "View",
        items: [
          it("view.zoomIn"),
          it("view.zoomOut"),
          it("view.zoom100"),
          it("view.fitStage"),
          "-",
          it("view.rulers"),
          it("view.grid"),
          it("view.guides"),
          it("view.lockGuides"),
          it("view.clearGuides"),
          it("view.snapping"),
          {
            label: "Snap To",
            // The switch above turns the feature off wholesale; this is what
            // it turns back ON, so the two are deliberately separate settings.
            items: SNAP_TARGETS.map((t) => it(`view.snapTo.${t.key}`, { label: t.label })),
          },
          "-",
          it("view.showBones"),
          it("view.showGizmos"),
          it("view.onionSkin"),
          it("view.editMultipleFrames"),
          { label: "Onion Skin Options", items: this.onionMenuDefs() },
        ],
      },
      {
        label: "Modify",
        items: [
          it("modify.convertToSymbol"),
          it("modify.editSymbol"),
          it("modify.group"),
          it("modify.swapInstance"),
          it("modify.bindToBone"),
          "-",
          it("modify.mask"),
          it("modify.masked"),
          "-",
          it("modify.documentSettings"),
          "-",
          it("modify.playMode"),
          it("modify.setupMode"),
          it("modify.autoKey"),
        ],
      },
      {
        label: "Window",
        // Checkmarks mean "on screen". Ticking one off closes the panel,
        // ticking it back on reopens it where it was — a menu whose entries
        // do nothing visible for an already-visible panel is a menu that
        // looks broken.
        items: () => [
          ...PANEL_COMMANDS.map(({ id }) => it(`window.${id}`)),
          "-",
          ...PANEL_COMMANDS.filter((p) => p.id !== "timeline").map(({ id, label }) => it(`window.float.${id}`, {
            label: this.shell.isPanelFloating(id) ? `Dock ${label}` : `Float ${label}`,
          })),
          "-",
          it("window.resetLayout"),
        ],
      },
      {
        label: "Help",
        items: [
          it("help.shortcuts"),
          "-",
          // Plain menu rows: these open a dialog and carry no chord, so they
          // need no entry in the command registry.
          { label: "Runtime Extensions", items: extensionHelpEntries() },
          "-",
          { label: `About ${APP_NAME}\u2026`, run: () => openAbout() },
        ],
      },
    ];
  }

  /** A menu row for a registered command: label, key, state and action all
   *  come from the registry, so the menu cannot drift from the keyboard. */
  /** The onion skin's options, for the View menu. */
  private onionMenuDefs(): MenuItemDef[] {
    const it = (id: string) => this.menuItem(id);
    return [
      it("view.onionAnchor"), it("view.onionAll"),
      it("view.onionKeyframesOnly"), it("view.onionOutline"), it("view.onionTint"),
      it("view.onionSettings"),
    ];
  }

  /**
   * The same options as a popup, for the onion buttons in the timeline:
   * press and hold, or right-click, as in Animate. Built from the same
   * handlers, so it cannot disagree with the View menu.
   */
  onionPopup(): Array<MenuEntry | "-"> {
    const k = this.keymap;
    const s = this.store;
    const e = (id: string): MenuEntry => ({
      label: COMMANDS_BY_ID.get(id)!.label,
      command: id,
      run: () => { k.run(id); },
      enabled: k.enabled(id),
      checked: k.handler(id)?.checked?.(),
    });
    const range = (n: number): MenuEntry => ({
      label: `Onion ${n}`,
      checked: !s.ui.onionAnchor
        && s.prefs.value.timeline.onionBefore === n && s.prefs.value.timeline.onionAfter === n,
      run: () => {
        s.setUi({ onionAnchor: null }, "stage");
        s.prefs.set("timeline", { onionBefore: n, onionAfter: n });
      },
    });
    return [
      e("view.onionSkin"), e("view.editMultipleFrames"),
      "-",
      e("view.onionAnchor"),
      { label: "Range", items: [range(1), range(2), range(5), e("view.onionAll")] },
      "-",
      e("view.onionKeyframesOnly"), e("view.onionOutline"), e("view.onionTint"),
      "-",
      e("view.onionSettings"),
    ];
  }

  private menuItem(id: string, extra: Partial<MenuItemDef> = {}): MenuItemDef {
    const k = this.keymap;
    // The handler is looked up when the menu OPENS, not when the row is built.
    // The static menus are built before `registerCommands`, so a handler
    // captured here is undefined — which is how every checkmark in View and
    // Modify went missing while `enabled`, already lazy, kept working.
    return {
      label: COMMANDS_BY_ID.get(id)!.label,
      command: id,
      run: () => { k.run(id); },
      enabled: () => k.enabled(id),
      checked: () => k.handler(id)?.checked?.() ?? false,
      ...extra,
    };
  }

  /**
   * Every command the keymap can reach. Menus build their rows from the same
   * handlers (`menuItem`), so a key and the menu entry beside it always do
   * the same thing.
   */
  private registerCommands(): void {
    const s = this.store;
    const k = this.keymap;
    const tl = this.timeline;
    const hasNodes = () => s.selection.nodes.length > 0;
    const reg = (id: string, run: () => unknown, enabled?: () => boolean, checked?: () => boolean) =>
      k.register(id, { run, enabled, checked });
    const flag = (id: string, f: "showRulers" | "showGrid" | "showGuides" | "showBones" | "showGizmos") =>
      reg(id, () => s.setViewFlag(f, !s.ui[f]), undefined, () => s.ui[f]);

    reg("file.new", () => void this.project.newProject());
    reg("file.open", () => void this.project.open());
    reg("file.save", () => void this.project.save(), () => s.history.isDirty);
    reg("file.saveAs", () => void this.project.saveAs());
    reg("file.importImages", () => this.shell.showPanel("library"));
    reg("file.importPsd", () => this.pickPsd());
    reg("file.export", () => void this.exportProject());
    reg("file.exportFolder", () => void this.exportToFolder());
    reg("file.exportSettings", () => openExportSettings(this.store));

    reg("edit.undo", () => s.undo(), () => s.history.canUndo);
    reg("edit.redo", () => s.redo(), () => s.history.canRedo);
    reg("edit.cut", () => this.cut(), () => hasNodes() || tl.hasFrameSelection);
    reg("edit.copy", () => this.copy(), () => hasNodes() || tl.hasFrameSelection);
    reg("edit.paste", () => this.paste(), () => this.clipboard.hasContent || tl.frames.hasContent);
    reg("edit.pasteOverwriteFrames", () => { tl.pasteFrames("overwrite"); }, () => tl.frames.hasContent);
    reg("edit.duplicate", () => this.clipboard.duplicate(s), hasNodes);
    reg("edit.copyProperties", () => {
      if (this.clipboard.copyProperties(s)) {
        this.toast.show("Copied position, size, rotation, skew and transform point");
      }
    }, hasNodes);
    const pasteProps = (withPosition: boolean) => () => {
      const n = this.clipboard.pasteProperties(s, withPosition);
      if (n) this.toast.show(`Applied to ${n} instance${n > 1 ? "s" : ""}`);
    };
    const canPasteProps = () => this.clipboard.hasProperties && hasNodes();
    reg("edit.pasteProperties", pasteProps(true), canPasteProps);
    reg("edit.pastePropertiesNoPosition", pasteProps(false), canPasteProps);
    reg("edit.selectAll", () => s.selectNodes(s.currentSymbol.layers.map((l) => l.nodeId)),
      () => s.currentSymbol.layers.length > 0);
    reg("edit.deselectAll", () => s.clearSelection(), hasNodes);
    reg("edit.deselect", () => s.clearSelection());
    reg("edit.selectAllFrames", () => tl.selectAllFrames(), hasNodes);
    reg("edit.newLayer", () => tl.addEmptyLayer());
    reg("edit.copyLayers", () => {
      const n = tl.copyLayers();
      if (n) this.toast.show(`Copied ${n} layer${n > 1 ? "s" : ""}`);
    }, hasNodes);
    reg("edit.pasteLayers", () => { tl.pasteLayers(); }, () => this.clipboard.hasLayers);
    reg("edit.duplicateLayers", () => { tl.duplicateLayers(); }, hasNodes);
    reg("edit.preferences", () => this.openPreferences());
    reg("edit.delete", () => {
      s.apply(new RemoveNodes(s.currentSymbolId, [...s.selection.nodes]));
      s.clearSelection();
      s.emit("doc");
    }, hasNodes);

    reg("view.zoomIn", () => s.setUi({ zoom: s.ui.zoom * 1.25 }, "stage"));
    reg("view.zoomOut", () => s.setUi({ zoom: s.ui.zoom / 1.25 }, "stage"));
    reg("view.zoom100", () => s.setUi({ zoom: 1 }, "stage"));
    reg("view.fitStage", () => this.viewport.fitToStage());
    flag("view.rulers", "showRulers");
    flag("view.grid", "showGrid");
    flag("view.guides", "showGuides");
    reg("view.lockGuides", () => {
      s.prefs.set("stage", { lockGuides: !s.prefs.value.stage.lockGuides });
      s.emit("stage");
    }, undefined, () => s.prefs.value.stage.lockGuides);
    reg("view.clearGuides", () => this.viewport.clearGuides(),
      () => this.viewport.guides.length > 0 && !s.prefs.value.stage.lockGuides);
    reg("view.snapping", () => s.toggleSnapping(), undefined, () => s.snappingOn);
    for (const t of SNAP_TARGETS) {
      reg(`view.snapTo.${t.key}`, () => s.setSnapTarget(t.key, !s.prefs.value.snap[t.key]),
        undefined, () => s.prefs.value.snap[t.key]);
    }
    flag("view.showBones", "showBones");
    flag("view.showGizmos", "showGizmos");
    reg("view.onionSkin", () => s.setUi({ onionSkin: !s.ui.onionSkin }, "stage"), undefined, () => s.ui.onionSkin);
    reg("view.editMultipleFrames",
      () => s.setUi({ editMultipleFrames: !s.ui.editMultipleFrames }, "stage"),
      undefined, () => s.ui.editMultipleFrames);
    reg("view.onionAnchor", () => s.setOnionAnchored(!s.ui.onionAnchor), undefined, () => !!s.ui.onionAnchor);
    reg("view.onionAll", () => {
      s.setUi({ onionAnchor: { start: 0, end: s.maxFrame } }, "stage");
    }, () => !!s.currentAnimation, () => {
      const a = s.ui.onionAnchor;
      return !!a && a.start === 0 && a.end === s.maxFrame;
    });
    const onionFlag = (id: string, key: "onionKeyframesOnly" | "onionOutline" | "onionTint") =>
      reg(id, () => { s.prefs.set("timeline", { [key]: !s.prefs.value.timeline[key] }); s.emit("stage"); },
        undefined, () => s.prefs.value.timeline[key]);
    onionFlag("view.onionKeyframesOnly", "onionKeyframesOnly");
    onionFlag("view.onionOutline", "onionOutline");
    onionFlag("view.onionTint", "onionTint");
    reg("view.onionSettings", () => this.openPreferences("timeline"));

    reg("modify.convertToSymbol", () => this.convertToSymbol(), hasNodes);
    // Enter falls through to the browser when there is no symbol to open.
    reg("modify.editSymbol", () => this.enterSelectedSymbol(), () => this.selectedSymbolItem() !== null);
    reg("modify.group", () => tl.addGroup(), hasNodes);
    reg("modify.swapInstance", () => this.swapInstance(), () => this.canSwapInstance());
    reg("modify.bindToBone", () => this.bindToBone(), () => this.bindableToBone() !== null);
    reg("modify.mask", () => this.toggleMask(), () => this.canToggleMask(),
      () => this.selectedLayer()?.isMask === true);
    reg("modify.masked", () => this.toggleMasked(), () => this.canToggleMasked(),
      () => !!this.selectedLayer()?.maskedBy);
    reg("modify.documentSettings", () => { s.clearSelection(); this.shell.rightDock.focus("properties"); });
    reg("modify.playMode", () => this.play.toggle(), undefined, () => s.ui.playMode);
    // Editing the bind pose while the runtime is on screen would change a
    // stage nobody can see.
    reg("modify.setupMode", () => s.setMode(s.ui.mode === "setup" ? "animate" : "setup"),
      () => !s.ui.playMode, () => s.ui.mode === "setup");
    reg("modify.autoKey", () => s.setUi({ autoKey: !s.ui.autoKey }), undefined, () => s.ui.autoKey);

    // A frame selection, when there is one, is what the F-keys act on.
    reg("timeline.insertFrame", () => {
      if (!tl.applyRangeOp("insert")) doInsertFrame(s, s.ui.frame, tl.insertTargets());
    });
    reg("timeline.removeFrame", () => {
      if (!tl.applyRangeOp("remove")) doRemoveFrame(s, s.ui.frame);
    });
    reg("timeline.insertFrameAll", () => tl.allLayersFrameOp("insert"));
    reg("timeline.removeFrameAll", () => tl.allLayersFrameOp("remove"));
    reg("timeline.insertKeyframe", () => {
      if (!tl.applyRangeOp("keyframes")) doInsertKeyframe(s, s.ui.frame, tl.insertTargets());
    });
    reg("timeline.clearKeyframe", () => {
      if (!tl.applyRangeOp("clear")) doClearKeyframe(s, s.ui.frame);
    });
    reg("timeline.insertBlankKeyframe", () => doInsertBlankKeyframe(s, s.ui.frame, tl.insertTargets()));
    reg("timeline.goToFrame", () => tl.goToFrame());

    // Space rather than ⌘P for the timeline: the two clocks are deliberately
    // not the same thing.
    reg("playback.toggle", () => tl.playback.toggle());
    reg("playback.prev", () => tl.playback.stepBy(-1));
    reg("playback.next", () => tl.playback.stepBy(1));
    reg("playback.start", () => tl.playback.toStart());
    reg("playback.end", () => tl.playback.toEnd());

    const nudges: Array<[string, number, number]> = [
      ["Left", -1, 0], ["Right", 1, 0], ["Up", 0, -1], ["Down", 0, 1],
    ];
    for (const [dir, dx, dy] of nudges) {
      reg(`stage.nudge${dir}`, () => this.nudge(dx, dy), hasNodes);
      reg(`stage.nudge${dir}10`, () => this.nudge(dx * 10, dy * 10), hasNodes);
    }

    for (const tool of TOOL_IDS) reg(`tool.${tool}`, () => s.setTool(tool));

    for (const { id } of PANEL_COMMANDS) {
      reg(`window.${id}`, () => this.shell.togglePanel(id), undefined, () => this.shell.isPanelOpen(id));
      if (id !== "timeline") reg(`window.float.${id}`, () => this.shell.floatPanel(id));
    }
    reg("window.resetLayout", () => this.shell.resetLayout());

    reg("help.shortcuts", () => this.openShortcuts());
  }

  openShortcuts(): void {
    openKeymapDialog(this.keymap, () => this.openPreferences("keys"));
  }
}

const TOOL_IDS: ToolId[] = ["select", "freeTransform", "pivot", "bone", "ik", "hand", "zoom"];

function uniqueSymbolName(store: Store, base: string): string {
  const taken = new Set(Object.values(store.project.items).map((i) => i.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function uniqueNodeName(store: Store, base: string): string {
  const taken = new Set(Object.values(store.currentSymbol.nodes).map((n) => n.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
