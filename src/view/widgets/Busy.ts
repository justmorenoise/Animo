import { type BusyTask, busyView, type RunBusy } from "@/app/busy";
import { clear, h } from "./dom";

/**
 * The small "working…" card, bottom right: one row per task that has run for
 * more than half a second, with its name and a progress bar (a sweeping one
 * while the task cannot say how far it is). `busyView` decides what shows;
 * this renders it.
 *
 * It does not block the editor: the heavy work runs on workers, so the page
 * keeps answering, and a modal would turn a two-second import into two
 * seconds of nothing to do.
 */
class BusyIndicator {
  private readonly el = h("div", { class: "busy", role: "status", "aria-live": "polite", hidden: true });
  private tasks: BusyTask[] = [];
  private nextId = 1;
  private shownSince: number | null = null;
  private timer = 0;
  private rendered = new Map<number, { row: HTMLElement; bar: HTMLElement }>();

  run: RunBusy = async (label, task) => {
    const t: BusyTask = { id: this.nextId++, label, startedAt: performance.now(), progress: null };
    this.tasks.push(t);
    this.update();
    try {
      return await task((f) => {
        t.progress = Math.max(0, Math.min(1, f));
        const bar = this.rendered.get(t.id)?.bar;
        if (bar) paint(bar, t.progress);
      });
    } finally {
      this.tasks = this.tasks.filter((x) => x !== t);
      // A finished row fills its bar for the moment the card lingers.
      const bar = this.rendered.get(t.id)?.bar;
      if (bar) paint(bar, 1);
      this.update();
    }
  };

  private update(): void {
    clearTimeout(this.timer);
    const now = performance.now();
    const view = busyView(this.tasks, now, this.shownSince);

    if (!view.show) {
      this.shownSince = null;
      this.el.hidden = true;
      clear(this.el);
      this.rendered.clear();
    } else {
      if (this.shownSince === null) this.shownSince = now;
      if (!this.el.isConnected) document.body.appendChild(this.el);
      this.el.hidden = false;
      // While it lingers with nothing running, the last rows stay as they are.
      if (view.rows.length > 0) this.renderRows(view.rows);
    }
    if (view.wakeAt !== null) this.timer = window.setTimeout(() => this.update(), view.wakeAt - now + 1);
  }

  private renderRows(rows: BusyTask[]): void {
    const keep = new Set(rows.map((r) => r.id));
    for (const [id, r] of this.rendered) {
      if (!keep.has(id)) { r.row.remove(); this.rendered.delete(id); }
    }
    for (const task of rows) {
      if (this.rendered.has(task.id)) continue;
      const bar = h("div", { class: "busy-bar" });
      const row = h("div", { class: "busy-row" },
        h("div", { class: "busy-label" }, `${task.label}…`),
        h("div", { class: "busy-track" }, bar));
      paint(bar, task.progress);
      this.el.appendChild(row);
      this.rendered.set(task.id, { row, bar });
    }
  }
}

function paint(bar: HTMLElement, progress: number | null): void {
  bar.classList.toggle("indeterminate", progress === null);
  bar.style.width = progress === null ? "" : `${Math.round(progress * 100)}%`;
}

let indicator: BusyIndicator | null = null;

/** Run `task` under the indicator, labelled `label` ("Importing frog.psd"). */
export const busy: RunBusy = (label, task) => (indicator ??= new BusyIndicator()).run(label, task);
