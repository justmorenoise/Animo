import { cls, h } from "./dom";

/**
 * Transient status messages: saved, opened, export finished, and the errors
 * from those. Deliberately not a dialog — none of these need acknowledging,
 * and a modal for "Saved" would be worse than saying nothing.
 */
export class Toast {
  readonly el: HTMLElement;
  private timer = 0;

  constructor() {
    this.el = h("div", { class: "toast", hidden: true });
  }

  show(message: string, isError = false, ms = isError ? 8000 : 2600): void {
    clearTimeout(this.timer);
    this.el.textContent = message;
    cls(this.el, "error", isError);
    this.el.hidden = false;
    this.timer = window.setTimeout(() => { this.el.hidden = true; }, ms);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.el.hidden = true;
  }
}
