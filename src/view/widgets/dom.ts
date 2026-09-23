/**
 * The entire "framework". Sixty lines of DOM helpers, deliberately not a
 * component library: this UI is dense, imperative and canvas-heavy, and a
 * reactive layer would sit between us and the pixels for no gain.
 */

type Child = globalThis.Node | string | number | false | null | undefined;

export interface Attrs {
  class?: string;
  id?: string;
  title?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  data?: Record<string, string>;
  [key: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs?: Attrs | null, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) applyAttrs(el, attrs);
  append(el, children);
  return el;
}

function applyAttrs(el: HTMLElement, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "data") for (const [dk, dv] of Object.entries(v as object)) el.dataset[dk] = String(dv);
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k in el && typeof v !== "object") {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

export function append(parent: globalThis.Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: globalThis.Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/** Parse an inline SVG string into an element. */
export function svg(markup: string): SVGElement {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${markup}</svg>`,
    "image/svg+xml",
  );
  return doc.documentElement as unknown as SVGElement;
}

export function on<K extends keyof HTMLElementEventMap>(
  el: EventTarget, type: K | string,
  fn: (ev: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): () => void {
  el.addEventListener(type, fn as EventListener, opts);
  return () => el.removeEventListener(type, fn as EventListener, opts);
}

export function cls(el: HTMLElement, name: string, present: boolean): void {
  el.classList.toggle(name, present);
}

/**
 * Pointer drag with implicit capture. `onMove` receives deltas from the
 * press point, which is what every gizmo and splitter actually wants.
 */
export function drag(
  el: HTMLElement,
  handlers: {
    onStart?: (ev: PointerEvent) => boolean | void;
    onMove?: (dx: number, dy: number, ev: PointerEvent) => void;
    onEnd?: (ev: PointerEvent, cancelled: boolean) => void;
    cursor?: string;
  },
): () => void {
  return on(el, "pointerdown", (e) => {
    const ev = e as PointerEvent;
    if (ev.button !== 0) return;
    if (handlers.onStart?.(ev) === false) return;
    ev.preventDefault();
    const startX = ev.clientX, startY = ev.clientY;
    const target = ev.currentTarget as HTMLElement;
    target.setPointerCapture(ev.pointerId);

    const prevCursor = document.body.style.cursor;
    if (handlers.cursor) document.body.style.cursor = handlers.cursor;

    let cancelled = false;
    const move = (m: PointerEvent) => handlers.onMove?.(m.clientX - startX, m.clientY - startY, m);
    const finish = (m: PointerEvent) => {
      target.releasePointerCapture?.(ev.pointerId);
      document.body.style.cursor = prevCursor;
      offMove(); offUp(); offCancel(); offKey();
      handlers.onEnd?.(m, cancelled);
    };
    const offMove = on(target, "pointermove", move as (e: Event) => void);
    const offUp = on(target, "pointerup", finish as (e: Event) => void);
    const offCancel = on(target, "pointercancel", finish as (e: Event) => void);
    const offKey = on(window, "keydown", (k) => {
      if ((k as unknown as KeyboardEvent).key === "Escape") {
        cancelled = true;
        finish(ev);
      }
    });
  });
}

/** Coalesce repeated work into one animation frame. */
export function raf(fn: () => void): () => void {
  let pending = 0;
  return () => {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; fn(); });
  };
}
