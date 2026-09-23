import { h, on } from "./dom";

export interface ModalOptions {
  title: string;
  width: number;
  /** Omitted: as tall as the content (the message dialogs). */
  height?: number;
  onClose?(): void;
}

/** Open modals, topmost last: Escape belongs to the top one only. */
const stack: Modal[] = [];

/**
 * A modal window: a backdrop plus a centred box.
 *
 * The editor had no dialog at all before this — everything was `prompt()` —
 * so this is deliberately the smallest thing that behaves: Escape and a click
 * on the backdrop close it, the global keymap stands down while one is open
 * (`Modal.isOpen`), and rows act on `pointerup` rather than `click`, for the
 * retargeting trap documented in CLAUDE.md.
 *
 * Not a `FloatWindow`: a float is a panel you keep working around, and this
 * is a question the editor is waiting on the answer to.
 */
export class Modal {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  readonly footer: HTMLElement;
  private offKey: () => void;
  private closed = false;

  /** True while any modal is up, so the global shortcuts can stand down. */
  static isOpen(): boolean { return stack.length > 0; }

  constructor(private readonly opts: ModalOptions) {
    this.body = h("div", { class: "modal-body" });
    this.footer = h("div", { class: "modal-foot" });

    const closeBtn = h("button", { class: "iconbtn", title: "Close" }, "×");
    on(closeBtn, "pointerup", () => this.close());

    const box = h("div", {
      class: "modal-box",
      style: { width: `${opts.width}px`, ...(opts.height ? { height: `${opts.height}px` } : {}) },
    },
      h("div", { class: "modal-bar" },
        h("span", { class: "modal-title" }, opts.title),
        h("div", { class: "spacer" }),
        closeBtn),
      this.body,
      this.footer);

    this.el = h("div", { class: "modal-backdrop" }, box);
    on(this.el, "pointerdown", (ev) => {
      if (ev.target === this.el) this.close();
    });

    this.offKey = on(window, "keydown", (ev) => {
      const e = ev as unknown as KeyboardEvent;
      // A field recording a shortcut owns Escape: it cancels the recording.
      if (stack[stack.length - 1] !== this) return;
      if ((document.activeElement as HTMLElement | null)?.closest("[data-key-capture]")) return;
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); this.close(); }
    }, { capture: true });

    stack.push(this);
    document.body.appendChild(this.el);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    stack.splice(stack.indexOf(this), 1);
    this.offKey();
    this.el.remove();
    this.opts.onClose?.();
  }
}
