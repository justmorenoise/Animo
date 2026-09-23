import { clear, h, on } from "@/view/widgets/dom";
import type { Panel } from "@/view/widgets/Dock";
import type { Store } from "@/app/Store";
import { confirmDialog } from "@/view/widgets/dialogs";

/**
 * The list of edits, oldest at the top, and a way back to any of them.
 *
 * Every step is a command with an exact inverse, so travelling is just undo
 * and redo run the whole way — there are no snapshots to keep in sync. The
 * first row is the document as it was OPENED: reachable as long as nothing
 * has been trimmed off the bottom, and otherwise restored from the copy the
 * history keeps for exactly that purpose.
 */
export class HistoryPanel implements Panel {
  readonly id = "history";
  readonly title = "History";
  readonly icon = "loop" as const;
  readonly el: HTMLElement;
  readonly footer: HTMLElement;

  private list: HTMLElement;
  private countLabel: HTMLElement;

  constructor(private readonly store: Store) {
    this.list = h("div", { class: "hist-list" });
    this.el = h("div", { class: "hist" }, this.list);

    this.countLabel = h("span", { class: "hist-count" });
    const revert = h("button", { class: "textbtn", title: "Undo everything since the document was opened" }, "Revert");
    on(revert, "click", () => void this.revert());
    this.footer = h("div", { class: "pfooter" }, this.countLabel, h("div", { class: "spacer" }), revert);

    // Any document change reorders the list, and so does travelling in it.
    store.subscribe((t) => {
      if (t === "doc" || t === "timeline" || t === "library" || t === "stage") this.render();
    });
    this.render();
  }

  onShow(): void { this.render(); }

  private render(): void {
    clear(this.list);
    const history = this.store.history;
    const entries = history.entries;
    const position = history.position;

    const rows: HTMLElement[] = [];
    rows.push(this.row(
      history.reachesStart ? "Opened" : "Earlier steps (trimmed)",
      0, position, "hist-open",
    ));
    entries.forEach((e, i) => rows.push(this.row(e.label, i + 1, position)));

    for (const row of rows) this.list.appendChild(row);

    this.countLabel.textContent = entries.length
      ? `${position} of ${entries.length}`
      : "No edits yet";

    // Keep the current step in sight while the list grows past the panel.
    this.list.querySelector(".hist-row.current")?.scrollIntoView({ block: "nearest" });
  }

  /**
   * While every step is still listed, revert is a walk back and redo undoes
   * it. Once steps have been trimmed it swaps the opened copy in and history
   * restarts: that cannot be taken back, so it asks.
   */
  private async revert(): Promise<void> {
    if (!this.store.history.reachesStart) {
      const ok = await confirmDialog({
        title: "Revert",
        message: "The oldest steps are no longer in the history, so this cannot be undone. " +
          "Go back to the document as it was opened?",
        ok: "Revert", danger: true,
      });
      if (!ok) return;
    }
    this.store.revertToOpened();
  }

  /** One step. Rows past the current position are the redoable future. */
  private row(label: string, at: number, position: number, extra = ""): HTMLElement {
    const state = at === position ? " current" : at > position ? " future" : "";
    const row = h("div", { class: `hist-row${state}${extra ? ` ${extra}` : ""}` },
      h("span", { class: "lbl" }, label),
    );
    on(row, "click", () => {
      if (at === 0 && !this.store.history.reachesStart) void this.revert();
      else this.store.goToHistory(at);
    });
    return row;
  }
}
