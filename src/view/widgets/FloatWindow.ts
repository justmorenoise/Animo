import { drag, h, on } from "./dom";
import { icon } from "@/view/icons";

export interface FloatRect { x: number; y: number; w: number; h: number }

export interface FloatOptions {
  title: string;
  rect: FloatRect;
  /** Called at the end of a move or resize, with the settled rectangle. */
  onChange(rect: FloatRect): void;
  /** Put the panel back in the dock it came from. */
  onDock(): void;
  onClose(): void;
}

const MIN_W = 220;
const MIN_H = 140;
let topZ = 400;

/**
 * A panel torn out of its dock: a small window inside the page.
 *
 * Inside the page rather than a real popup on purpose. `window.open` is
 * unreliable in embedded browser panes — a same-origin URL can navigate the
 * host tab and take the editor with it — and a second document would mean a
 * second copy of every panel's wiring. A fixed-position element costs neither.
 */
export class FloatWindow {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  private titleEl: HTMLElement;
  /** Current position and size, read by the dock when persisting layout. */
  rect: FloatRect;

  constructor(private readonly opts: FloatOptions) {
    this.rect = clampRect(opts.rect);
    this.titleEl = h("span", { class: "ftitle" }, opts.title);
    this.body = h("div", { class: "fbody" });

    const dockBtn = h("button", { class: "iconbtn", title: "Put back in the dock" });
    dockBtn.appendChild(icon("chevRight", 12));
    on(dockBtn, "click", () => opts.onDock());

    const closeBtn = h("button", { class: "iconbtn", title: "Close" }, "×");
    on(closeBtn, "click", () => opts.onClose());

    const bar = h("div", { class: "fbar" }, this.titleEl, h("div", { class: "spacer" }), dockBtn, closeBtn);
    this.el = h("div", { class: "floatwin" }, bar, this.body, this.grip());

    this.wireMove(bar);
    this.applyRect();
    on(this.el, "pointerdown", () => this.raise(), { capture: true });
    this.raise();
    document.body.appendChild(this.el);
  }

  setTitle(title: string): void { this.titleEl.textContent = title; }

  /** Pull the window back on screen after the browser window changed size. */
  reclamp(): void {
    this.rect = clampRect(this.rect);
    this.applyRect();
  }

  raise(): void { this.el.style.zIndex = String(++topZ); }

  dispose(): void { this.el.remove(); }

  private applyRect(): void {
    this.el.style.left = `${this.rect.x}px`;
    this.el.style.top = `${this.rect.y}px`;
    this.el.style.width = `${this.rect.w}px`;
    this.el.style.height = `${this.rect.h}px`;
  }

  private wireMove(bar: HTMLElement): void {
    let start = this.rect;
    drag(bar, {
      cursor: "grabbing",
      onStart: (ev) => {
        // Let the buttons in the bar do their own job.
        if ((ev.target as HTMLElement).closest("button")) return false;
        start = { ...this.rect };
        return true;
      },
      onMove: (dx, dy) => {
        this.rect = clampRect({ ...start, x: start.x + dx, y: start.y + dy });
        this.applyRect();
      },
      onEnd: () => this.opts.onChange(this.rect),
    });
  }

  private grip(): HTMLElement {
    const g = h("div", { class: "fgrip", title: "Resize" });
    let start = this.rect;
    drag(g, {
      cursor: "nwse-resize",
      onStart: () => { start = { ...this.rect }; },
      onMove: (dx, dy) => {
        this.rect = clampRect({
          ...start,
          w: Math.max(MIN_W, start.w + dx),
          h: Math.max(MIN_H, start.h + dy),
        });
        this.applyRect();
      },
      onEnd: () => this.opts.onChange(this.rect),
    });
    return g;
  }
}

/** Keep the window on screen — including after the browser window shrinks. */
export function clampRect(r: FloatRect): FloatRect {
  const w = Math.max(MIN_W, Math.min(r.w, innerWidth - 8));
  const h = Math.max(MIN_H, Math.min(r.h, innerHeight - 8));
  return {
    w, h,
    x: Math.max(0, Math.min(r.x, innerWidth - w - 4)),
    // Never above the menu bar, and never fully below the fold.
    y: Math.max(24, Math.min(r.y, innerHeight - 32)),
  };
}
