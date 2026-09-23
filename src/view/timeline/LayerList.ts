import { clear, cls, h, on } from "@/view/widgets/dom";
import { mayReparent } from "@/view/widgets/ikReparentGuard";
import { icon } from "@/view/icons";
import type { Store } from "@/app/Store";
import type { Layer, NodeKind } from "@/core/doc/types";
import { isSymbol } from "@/core/doc/types";
import { RenameLayer, ReorderLayer, SetLayerFlag, SetParent } from "@/core/history/commands";
import { indexAbove, type LayerRow, layerRows } from "@/core/doc/layerTree";
import { ikRoles, ikSummary } from "@/core/doc/ikGraph";
import type { NodeId } from "@/core/doc/ids";
import { attachOptionsMenu } from "./onionButton";

export interface LayerListCallbacks {
  onScrollY(y: number): void;
  onContextMenu(nodeId: string, x: number, y: number): void;
  /** Open the onion skin options below `anchor`. */
  onOnionOptions(anchor: HTMLElement): void;
  rowHeight: number;
}

/**
 * The layer column. DOM rather than canvas: there are few rows and they need
 * real text inputs, drag targets and hit areas for the visibility and lock
 * toggles. It scrolls in lockstep with the frame grid beside it.
 */
export class LayerList {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private dragIndex = -1;
  private onionHint: HTMLElement | null = null;
  /** What was selected at the last render, so a reveal only follows a change. */
  private selectionKey = "";

  constructor(
    private readonly store: Store,
    private readonly cb: LayerListCallbacks,
  ) {
    this.list = h("div", { class: "tl-llist" });
    this.el = h("div", { class: "tl-layers" }, this.buildHead(), this.list);

    on(this.list, "scroll", () => this.cb.onScrollY(this.list.scrollTop));
    // The blank space under the rows, as below the frame grid.
    on(this.list, "pointerdown", (e) => {
      if (e.target === this.list) this.store.clearFrameSelection();
    });
    this.render();
  }

  /**
   * The panel's only vertical scroll, driven from the frame grid as well as
   * from this column: the wheel has to work wherever the pointer is, and the
   * grid is a canvas with no scroll of its own.
   */
  scrollByY(delta: number): void {
    this.list.scrollTop += delta;              // clamped by the element itself
  }

  setScrollTop(y: number): void {
    if (this.list.scrollTop !== y) this.list.scrollTop = y;
  }

  private buildHead(): HTMLElement {
    const onion = h("button", { class: "iconbtn", title: "Onion skin (hold or right-click for options)" });
    onion.appendChild(icon("onion", 12));
    on(onion, "click", () => {
      this.store.setUi({ onionSkin: !this.store.ui.onionSkin }, "stage");
    });
    attachOptionsMenu(onion, () => this.cb.onOnionOptions(onion));
    // The footer has a second onion button, so this one follows the STATE
    // rather than its own clicks — pressing one and watching the other keep
    // saying "Off" reads as one of them being broken.
    const syncOnion = () => {
      cls(onion, "on", this.store.ui.onionSkin);
      if (this.onionHint) this.onionHint.textContent = this.store.ui.onionSkin ? "On" : "Off";
    };
    this.store.subscribe((t) => { if (t === "stage" || t === "ui") syncOnion(); });

    // These two head the state columns below them, and they act on every
    // layer at once — which is also the only way back when a layer has been
    // hidden and its row now shows nothing to click but a blank slot.
    const flag = (name: "eyeOff" | "lock", flag_: "visible" | "locked", title: string) => {
      const b = h("button", { class: "iconbtn", title });
      b.appendChild(icon(name, 11));
      on(b, "click", () => this.setAllFlags(flag_));
      return b;
    };

    this.onionHint = h("span", { class: "hint" }, this.store.ui.onionSkin ? "On" : "Off");
    syncOnion();

    return h("div", { class: "tl-lhead" },
      h("div", { class: "onion" }, onion, this.onionHint),
      h("div", { class: "flags" },
        flag("eyeOff", "visible", "Show / hide all layers"),
        flag("lock", "locked", "Lock / unlock all layers")),
    );
  }

  render(): void {
    const previous = this.selectionKey;
    this.selectionKey = this.store.selection.nodes.join(",");
    clear(this.list);
    const sym = this.store.currentSymbol;
    if (sym.layers.length === 0) {
      this.list.appendChild(h("div", { class: "empty", style: "min-height:52px" },
        "No layers yet"));
      return;
    }
    // One pass over the constraints for the whole list: which rows are IK
    // targets and which bones a solver drives is the one relationship the
    // indentation cannot show, since a target hangs outside the chain.
    const roles = ikRoles(sym);
    const rows = layerRows(sym);
    rows.forEach((row, i) => this.list.appendChild(this.row(row, i, roles)));

    // Selecting from somewhere else — the stage, or a name in the Properties
    // panel's IK section — has to be visible. Only on an actual CHANGE, and
    // only "nearest", or every re-render would yank a list the user is
    // scrolling through by hand.
    if (this.selectionKey !== previous && this.store.selection.nodes.length > 0) {
      this.list.querySelector(".tl-layer.selected")?.scrollIntoView({ block: "nearest" });
    }
  }

  private row(
    row: LayerRow, index: number,
    roles: { targets: Set<NodeId>; driven: Set<NodeId> },
  ): HTMLElement {
    const sym = this.store.currentSymbol;
    const { layer, node, depth, hasChildren } = row;
    const selected = this.store.selection.nodes.includes(layer.nodeId);
    const item = node.itemId ? this.store.project.items[node.itemId] : undefined;
    const isGroup = node.kind === "group";
    const ikRole = roles.targets.has(layer.nodeId) ? "target" as const
      : roles.driven.has(layer.nodeId) ? "driven" as const
      : null;

    // Disclosure triangle, only where there is something to disclose.
    const tri = h("span", { class: `ltri${hasChildren ? "" : " leaf"}${layer.collapsed ? "" : " open"}` });
    if (hasChildren) {
      on(tri, "pointerdown", (e) => {
        e.stopPropagation();
        this.toggleCollapsed(layer);
      });
    }

    const kind = h("span", { class: "kind" });
    kind.appendChild(icon(
      // A mask layer reads as its ROLE, not as its artwork: which layer does
      // the clipping is the thing you need to see at a glance.
      layer.isMask ? "mask"
        : layer.maskedBy ? "masked"
        : isGroup ? "folderItem"
        : node.kind === "empty" ? "emptyItem"
        // A target is not a limb: it is the handle that pulls one, keyed
        // while the bones it moves never are.
        : ikRole === "target" ? "ikTarget"
        : node.kind === "bone" ? "bone"
        : isSymbol(item) ? "symbolItem"
        : "imageItem",
      12,
    ));
    if (layer.isMask) kind.title = "Mask layer: the layers linked below it show only inside its artwork";
    else if (layer.maskedBy) kind.title = "Masked by the layer above";
    else if (node.kind === "empty") kind.title = "Empty layer: drag an item from the Library onto the stage to fill it";
    else if (ikRole) kind.title = ikSummary(sym, layer.nodeId) ?? "";

    const name = h("div", { class: "name" }, layer.name);

    // An excluded layer still draws on the stage, so the badge is the only
    // warning that it will be missing from the file — and from the preview.
    const badge = layer.excludeFromExport ? h("span", { class: "noexport",
      title: "Excluded from export: visible here, but not in the exported files or the Preview" }) : null;
    if (badge) badge.appendChild(icon("noExport", 11));
    const eye = this.flagCell(layer, "visible");
    const lock = this.flagCell(layer, "locked");

    // Masked rows sit one step in from their mask, the way Flash draws the
    // linkage. It is an EXTRA step on top of the group indent, not a
    // replacement: a masked layer can also be inside a group.
    const indent = 4 + depth * 12 + (layer.maskedBy ? 12 : 0);
    const el = h("div", {
      class: rowClasses(layer, node.kind, selected, ikRole),
      style: { height: `${this.cb.rowHeight}px`, paddingLeft: `${indent}px` },
      draggable: true,
    }, tri, kind, name, ...(badge ? [badge] : []), eye, lock);

    on(el, "pointerdown", (ev) => {
      const e = ev as unknown as PointerEvent;
      if ((e.target as HTMLElement).closest(".dot, .ltri")) return;
      // Left button only. `contextmenu` fires AFTER the right button's
      // pointerdown, so selecting here would collapse a shift-built
      // multi-selection to the row under the cursor before the menu ever saw
      // it — and every "Copy 3 Layers" would silently copy one.
      if (e.button !== 0) return;
      this.store.clearFrameSelection();
      if (e.shiftKey) this.store.toggleNode(layer.nodeId);
      else this.store.selectNodes([layer.nodeId]);
    });

    on(name, "dblclick", () => this.beginRename(name, layer));

    on(el, "contextmenu", (ev) => {
      const e = ev as unknown as MouseEvent;
      e.preventDefault();
      // Right-clicking outside the selection acts on the row under the
      // cursor; inside it, the whole selection stands.
      this.store.clearFrameSelection();
      if (!this.store.selection.nodes.includes(layer.nodeId)) {
        this.store.selectNodes([layer.nodeId]);
      }
      this.cb.onContextMenu(layer.nodeId, e.clientX, e.clientY);
    });

    on(el, "dragstart", (ev) => {
      this.dragIndex = index;
      (ev as unknown as DragEvent).dataTransfer?.setData("text/plain", layer.id);
    });
    on(el, "dragover", (ev) => {
      const e = ev as unknown as DragEvent;
      e.preventDefault();
      // Dropping on the middle of a group re-parents INTO it; the top and
      // bottom thirds reorder around it, so a layer can still be moved past a
      // group without being swallowed by it.
      const r = el.getBoundingClientRect();
      const into = isGroup && e.clientY > r.top + r.height * 0.3 && e.clientY < r.bottom - r.height * 0.3;
      el.style.outline = into ? "1px solid var(--accent)" : "";
      el.style.borderTop = into ? "" : "1px solid var(--accent)";
    });
    on(el, "dragleave", () => { el.style.borderTop = ""; el.style.outline = ""; });
    on(el, "drop", (ev) => {
      const e = ev as unknown as DragEvent;
      e.preventDefault();
      el.style.borderTop = "";
      el.style.outline = "";
      const rows = layerRows(sym);
      const dragged = rows[this.dragIndex]?.layer;
      this.dragIndex = -1;
      if (!dragged || dragged.id === layer.id) return;

      const r = el.getBoundingClientRect();
      const into = isGroup && e.clientY > r.top + r.height * 0.3 && e.clientY < r.bottom - r.height * 0.3;
      const draggedNode = sym.nodes[dragged.nodeId];
      const target = sym.nodes[layer.nodeId];
      const reparents = into || (!!draggedNode && !!target && draggedNode.parentId !== target.parentId);
      if (reparents && !mayReparent(this.store, [dragged.nodeId])) return;

      if (into) {
        this.store.apply(new SetParent(this.store.currentSymbolId, [dragged.nodeId], layer.nodeId));
      } else {
        this.store.transaction("Move Layer", () => {
          // Reordering next to a row also adopts that row's parent, so a
          // layer dropped between two children of a group joins the group.
          if (target && draggedNode && draggedNode.parentId !== target.parentId) {
            this.store.apply(new SetParent(
              this.store.currentSymbolId, [dragged.nodeId], target.parentId,
            ));
          }
          const to = indexAbove(sym, dragged.id, layer.id);
          this.store.apply(new ReorderLayer(this.store.currentSymbolId, dragged.id, to));
        });
      }
      this.store.emit("timeline");
      this.store.emit("stage");
    });

    return el;
  }

  /**
   * Collapse is view state, not an edit: it lives in the document so it
   * persists with the file, but putting it on the undo stack would fill the
   * history with entries nobody wants to step back through.
   */
  private toggleCollapsed(layer: Layer): void {
    layer.collapsed = !layer.collapsed;
    this.render();
    this.store.emit("timeline");
  }

  /**
   * One state cell: hidden shows a struck-through eye, locked shows a
   * padlock, and the ordinary case — visible and unlocked — shows NOTHING.
   *
   * The dots this replaces marked every layer whether or not anything was
   * true of it, so a column of forty rows carried eighty marks that all meant
   * "normal" and the two that meant something disappeared into them. The cell
   * keeps its width and its click target either way, so a layer can still be
   * hidden or locked from the blank slot.
   */
  private flagCell(layer: Layer, flag: "visible" | "locked"): HTMLElement {
    const set = flag === "visible" ? !layer.visible : layer.locked;
    const el = h("div", {
      class: `dot${set ? " on" : ""}`,
      title: flag === "visible"
        ? (layer.visible ? "Hide layer" : "Hidden. Click to show.")
        : (layer.locked ? "Locked. Click to unlock." : "Lock layer"),
    });
    if (set) el.appendChild(icon(flag === "visible" ? "eyeOff" : "lock", 11));
    on(el, "pointerdown", (e) => {
      e.stopPropagation();
      const next = flag === "visible" ? !layer.visible : !layer.locked;
      this.store.apply(new SetLayerFlag(this.store.currentSymbolId, layer.id, flag, next));
      this.store.emit("timeline");
      this.store.emit("stage");
    });
    return el;
  }

  /**
   * The column heads: if ANY layer is in the exceptional state, restore them
   * all; otherwise put them all into it. One transaction, one undo step.
   */
  private setAllFlags(flag: "visible" | "locked"): void {
    const sym = this.store.currentSymbol;
    if (sym.layers.length === 0) return;
    const exceptional = flag === "visible"
      ? sym.layers.some((l) => !l.visible)
      : sym.layers.some((l) => l.locked);
    const next = flag === "visible" ? exceptional : !exceptional;
    this.store.transaction(flag === "visible" ? "Show / Hide Layers" : "Lock / Unlock Layers", () => {
      for (const l of sym.layers) {
        const now = flag === "visible" ? l.visible : l.locked;
        if (now === next) continue;
        this.store.apply(new SetLayerFlag(this.store.currentSymbolId, l.id, flag, next));
      }
    });
    this.store.emit("timeline");
    this.store.emit("stage");
  }

  private beginRename(nameEl: HTMLElement, layer: Layer): void {
    const input = h("input", { type: "text", value: layer.name });
    clear(nameEl);
    nameEl.appendChild(input);
    input.focus();
    input.select();

    // Once: re-rendering removes the focused input, its `blur` fires, and a
    // second commit(true) saved the very text Escape was throwing away.
    let done = false;
    const commit = (save: boolean) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (save && next && next !== layer.name) {
        this.store.apply(new RenameLayer(this.store.currentSymbolId, layer.id, next));
        this.store.emit("doc");
      }
      this.render();
    };
    on(input, "blur", () => commit(true));
    on(input, "keydown", (ev) => {
      const e = ev as unknown as KeyboardEvent;
      e.stopPropagation();
      if (e.key === "Enter") commit(true);
      if (e.key === "Escape") commit(false);
    });
  }
}

/**
 * The class list of one timeline row.
 *
 * Exported and pure so `tests/layerRowClasses.test.ts` can check the one rule
 * that is invisible from inside this file: every modifier here must be styled
 * UNDER `.tl-layer`, and must not be a class the rest of the app styles
 * globally. An empty layer once carried a bare "empty", which collided with
 * the panels' empty-state rule (`min-height: 60px`) and stretched the row to
 * three times its height — the frame grid draws fixed-height rows, so the two
 * columns stopped lining up and the layers below LOOKED nested inside it.
 */
export function rowClasses(
  layer: Layer, kind: NodeKind, selected: boolean,
  ikRole: "target" | "driven" | null = null,
): string {
  return "tl-layer"
    + (selected ? " selected" : "")
    + (kind === "group" ? " group" : "")
    + (layer.isMask ? " mask" : "")
    + (layer.maskedBy ? " masked" : "")
    + (kind === "empty" ? " emptylayer" : "")
    + (layer.excludeFromExport ? " noexport" : "")
    // The stage's own two IK colours, on the row: green handle, blue chain.
    + (ikRole === "target" ? " iktarget" : ikRole === "driven" ? " ikdriven" : "");
}
