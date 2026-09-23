import { h, on } from "./dom";

export interface NumberFieldOpts {
  glyph?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Pixels of drag per `step`. */
  sensitivity?: number;
  decimals?: number;
  onInput?(value: number, committing: boolean): void;
}

/**
 * Animate's scrubbable numeric field: drag the glyph to change the value,
 * click to type. Emits `committing: false` continuously while scrubbing so
 * the caller can preview, then `true` once on release — which is exactly the
 * shape History.beginInteraction/endInteraction wants.
 */
export class NumberField {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private value = 0;
  private opts: NumberFieldOpts;
  /** The text `set` last wrote, so an untouched field commits nothing. */
  private shown = "";
  /** Showing "—" for a multi-selection that disagrees: `value` is stale then,
   *  so a typed number must commit even when it happens to equal it. */
  private mixed = false;

  constructor(opts: NumberFieldOpts = {}) {
    this.opts = opts;
    this.input = h("input", { type: "text", spellcheck: false });

    const glyph = opts.glyph
      ? h("span", { class: "glyph" }, opts.glyph)
      : null;
    const unit = opts.unit ? h("span", { class: "glyph" }, opts.unit) : null;

    this.el = h("div", { class: `field${glyph ? " scrub" : ""}` }, glyph, this.input, unit);

    on(this.input, "change", () => this.commitText());
    on(this.input, "blur", () => this.commitText());
    on(this.input, "keydown", (ev) => {
      const e = ev as unknown as KeyboardEvent;
      if (e.key === "Enter") { this.commitText(); this.input.blur(); }
      else if (e.key === "Escape") {
        if (this.mixed) this.setMixed(); else this.set(this.value);
        this.input.blur();
      }
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const mult = e.shiftKey ? 10 : 1;
        this.bump((e.key === "ArrowUp" ? 1 : -1) * (opts.step ?? 1) * mult);
      }
    });

    if (glyph) this.wireScrub(glyph);
  }

  private wireScrub(handle: HTMLElement): void {
    on(handle, "pointerdown", (ev) => {
      const e = ev as unknown as PointerEvent;
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startVal = this.value;
      const sens = this.opts.sensitivity ?? 2;
      const step = this.opts.step ?? 1;
      document.body.style.cursor = "ew-resize";
      let moved = false;

      const move = (m: PointerEvent) => {
        const mult = m.shiftKey ? 10 : m.altKey ? 0.1 : 1;
        const next = startVal + ((m.clientX - startX) / sens) * step * mult;
        this.set(next);
        moved = true;
        this.opts.onInput?.(this.value, false);
      };
      // A click on the glyph is not an edit, as with `commitText`; once the
      // scrub has emitted anything, the final call must come to close the
      // interaction it opened — a cancelled pointer included.
      const up = () => {
        offMove(); offUp(); offCancel();
        handle.releasePointerCapture?.(e.pointerId);
        document.body.style.cursor = "";
        if (moved) this.opts.onInput?.(this.value, true);
      };
      const offMove = on(handle, "pointermove", move as (x: Event) => void);
      const offUp = on(handle, "pointerup", up);
      const offCancel = on(handle, "pointercancel", up);
    });
  }

  private bump(by: number): void {
    this.set(this.value + by);
    this.opts.onInput?.(this.value, true);
  }

  private commitText(): void {
    // Compared as TEXT: the field shows a rounded value, and a bounding box
    // at x = 420.3333 displays 420.33 — parsing that back and committing it
    // moved the selection by a fraction of a pixel on every blur.
    if (this.input.value === this.shown) return;
    const parsed = parseExpression(this.input.value);
    if (parsed === null) { this.set(this.value); return; }
    const before = this.value;
    const wasMixed = this.mixed;
    this.set(parsed);
    // Leaving a field untouched is not an edit. Committing anyway emitted a
    // document change on every blur, which rebuilt the export and reloaded
    // the preview just for clicking from one field to the next.
    if (this.value === before && !wasMixed) return;
    this.opts.onInput?.(this.value, true);
  }

  set(v: number): void {
    let next = Number.isFinite(v) ? v : 0;
    if (this.opts.min !== undefined) next = Math.max(this.opts.min, next);
    if (this.opts.max !== undefined) next = Math.min(this.opts.max, next);
    this.value = next;
    this.mixed = false;
    const d = this.opts.decimals ?? 2;
    this.input.value = this.shown = trimZeros(next.toFixed(d));
  }

  get(): number { return this.value; }

  /** Whether the user is typing into this field right now. */
  get focused(): boolean { return document.activeElement === this.input; }

  /**
   * Show a value pushed from outside — the playhead moved, the document
   * changed. Skipped while the field has focus: overwriting it there
   * replaced what was being typed on every frame of playback.
   */
  show(v: number): void {
    if (!this.focused) this.set(v);
  }

  setDisabled(disabled: boolean): void {
    this.input.disabled = disabled;
    this.el.style.opacity = disabled ? "0.45" : "";
    this.el.style.pointerEvents = disabled ? "none" : "";
  }

  /** Show a blank field for a mixed multi-selection. */
  setMixed(): void {
    this.input.value = this.shown = "—";
    this.mixed = true;
  }
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Accepts plain numbers and simple arithmetic, e.g. "120/2" or "40+8". */
function parseExpression(raw: string): number | null {
  const s = raw.trim().replace(/,/g, ".");
  if (!s) return null;
  if (/^-?\d*\.?\d+$/.test(s)) return Number(s);
  if (!/^[-+*/().\d\s]+$/.test(s)) return null;
  try {
    const v = Function(`"use strict";return (${s})`)() as unknown;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch { return null; }
}
