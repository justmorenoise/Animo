import { clear, h, on } from "@/view/widgets/dom";
import { icon } from "@/view/icons";
import type { Panel } from "@/view/widgets/Dock";
import type { Store } from "@/app/Store";
import type { NodeId } from "@/core/doc/ids";
import { SetParent } from "@/core/history/commands";
import { mayReparent } from "@/view/widgets/ikReparentGuard";
import { isSymbol } from "@/core/doc/types";

/** The node hierarchy, with drag-to-reparent. */
export class OutlinePanel implements Panel {
  readonly id = "outline";
  readonly title = "Outline";
  readonly icon = "outlinePanel" as const;
  readonly el: HTMLElement;

  private dragId: NodeId | null = null;

  constructor(private readonly store: Store) {
    this.el = h("div", { class: "outline" });
    store.subscribe((t) => {
      if (t === "doc" || t === "selection" || t === "timeline") this.render();
    });
    this.render();
  }

  private render(): void {
    clear(this.el);
    const sym = this.store.currentSymbol;
    if (sym.layers.length === 0) {
      this.el.appendChild(h("div", { class: "empty" }, "No objects on stage"));
      return;
    }

    // Roots in layer order (top first), children nested beneath.
    const childrenOf = new Map<NodeId | null, NodeId[]>();
    for (const layer of sym.layers) {
      const node = sym.nodes[layer.nodeId];
      if (!node) continue;
      const key = node.parentId ?? null;
      (childrenOf.get(key) ?? childrenOf.set(key, []).get(key)!).push(node.id);
    }

    const seen = new Set<NodeId>();
    const emit = (id: NodeId, depth: number): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const node = sym.nodes[id];
      if (!node) return;
      this.el.appendChild(this.rowFor(id, depth));
      for (const child of childrenOf.get(id) ?? []) emit(child, depth + 1);
    };
    for (const id of childrenOf.get(null) ?? []) emit(id, 0);
    // Anything orphaned by a broken parent link still needs a row.
    for (const layer of sym.layers) if (!seen.has(layer.nodeId)) emit(layer.nodeId, 0);
  }

  private rowFor(id: NodeId, depth: number): HTMLElement {
    const sym = this.store.currentSymbol;
    const node = sym.nodes[id]!;
    const item = node.itemId ? this.store.project.items[node.itemId] : undefined;
    const selected = this.store.selection.nodes.includes(id);

    const row = h("div", {
      class: `tree-row${selected ? " selected" : ""}`,
      draggable: true,
      style: { paddingLeft: `${6 + depth * 13}px` },
    },
      h("span", { class: "ico" },
        icon(node.kind === "bone" ? "bone" : isSymbol(item) ? "symbolItem" : "imageItem", 12)),
      h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, node.name),
    );

    on(row, "click", (ev) => {
      const e = ev as unknown as MouseEvent;
      if (e.shiftKey) this.store.toggleNode(id);
      else this.store.selectNodes([id]);
    });

    on(row, "dragstart", () => { this.dragId = id; });
    on(row, "dragover", (e) => { e.preventDefault(); row.style.outline = "1px solid var(--accent)"; });
    on(row, "dragleave", () => { row.style.outline = ""; });
    on(row, "drop", (e) => {
      e.preventDefault();
      row.style.outline = "";
      if (this.dragId && this.dragId !== id && mayReparent(this.store, [this.dragId])) {
        this.store.apply(new SetParent(this.store.currentSymbolId, [this.dragId], id));
        this.store.emit("doc");
      }
      this.dragId = null;
    });

    return row;
  }
}
