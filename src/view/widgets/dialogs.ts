import { Modal } from "./Modal";
import { h, on } from "./dom";

/**
 * The editor's own confirm, alert and text prompt, replacing the browser's.
 * Each returns a promise; Escape, the close box and a click on the backdrop
 * answer as Cancel. Enter answers as the primary button.
 *
 * Buttons act on `pointerup` like every other control here (the retargeting
 * trap in ARCHITECTURE.md), so the keyboard is wired explicitly: Enter for the
 * primary button, Escape through `Modal`.
 */

export interface ConfirmOptions {
  title: string;
  message: string;
  /** The primary button. */
  ok?: string;
  cancel?: string;
  /** The primary button destroys something (Discard, Delete): drawn in the
   *  warning colour, and Enter does not press it. */
  danger?: boolean;
  dontAskAgain?: DontAskAgain;
}

/** A "don't show this again" box. `remember` runs when the dialog is answered
 *  with the primary button and the box ticked; the label should say where the
 *  choice can be undone. */
export interface DontAskAgain {
  label: string;
  remember(): void;
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const modal = new Modal({ title: opts.title, width: 400, onClose: () => resolve(answer) });
    const box = checkBox(opts.dontAskAgain);
    modal.body.appendChild(h("div", { class: "modal-form" },
      h("p", { class: "modal-msg" }, opts.message), box?.el));
    const finish = (yes: boolean) => {
      answer = yes;
      if (yes && box?.input.checked) opts.dontAskAgain!.remember();
      modal.close();
    };
    const cancel = button(opts.cancel ?? "Cancel", false, () => finish(false));
    const ok = button(opts.ok ?? "OK", true, () => finish(true), opts.danger);
    modal.footer.append(h("div", { class: "spacer" }), cancel, ok);
    onEnter(modal, () => { if (!opts.danger) finish(true); });
    (opts.danger ? cancel : ok).focus();
  });
}

export interface AlertOptions {
  title: string;
  message: string;
  ok?: string;
  width?: number;
  /** A second button on the left, for the place that fixes the problem. */
  extra?: { label: string; run(): void };
  dontAskAgain?: DontAskAgain;
}

export function alertDialog(opts: AlertOptions): Promise<void> {
  return new Promise((resolve) => {
    const modal = new Modal({ title: opts.title, width: opts.width ?? 400, onClose: () => resolve() });
    const box = checkBox(opts.dontAskAgain);
    modal.body.appendChild(h("div", { class: "modal-form" },
      h("p", { class: "modal-msg" }, opts.message), box?.el));
    const ok = button(opts.ok ?? "OK", true, () => {
      if (box?.input.checked) opts.dontAskAgain!.remember();
      modal.close();
    });
    if (opts.extra) {
      const { run } = opts.extra;
      modal.footer.append(button(opts.extra.label, false, () => { modal.close(); run(); }));
    }
    modal.footer.append(h("div", { class: "spacer" }), ok);
    onEnter(modal, () => modal.close());
    ok.focus();
  });
}

export interface PromptTextOptions {
  title: string;
  label: string;
  value: string;
  ok?: string;
  /** A reason the text cannot be accepted, shown under the field; null: fine. */
  validate?(text: string): string | null;
}

/** The trimmed text, or null when cancelled. An empty field cannot be accepted. */
export function promptText(opts: PromptTextOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let answer: string | null = null;
    const modal = new Modal({ title: opts.title, width: 380, onClose: () => resolve(answer) });
    const input = h("input", { type: "text", class: "modal-text", value: opts.value, spellcheck: false }) as HTMLInputElement;
    const error = h("div", { class: "modal-error" });
    modal.body.appendChild(h("div", { class: "modal-form" },
      h("div", { class: "prow" }, h("label", null, opts.label), h("div", { class: "fields" }, input)),
      error));

    const problem = (): string | null => {
      const text = input.value.trim();
      if (!text) return "Enter a name.";
      return opts.validate?.(text) ?? null;
    };
    const refresh = () => {
      const p = problem();
      error.textContent = p && input.value.trim() ? p : "";
      ok.disabled = p !== null;
    };
    const commit = () => {
      if (problem()) return;
      answer = input.value.trim();
      modal.close();
    };
    const cancel = button("Cancel", false, () => modal.close());
    const ok = button(opts.ok ?? "OK", true, commit);
    modal.footer.append(h("div", { class: "spacer" }), cancel, ok);
    on(input, "input", refresh);
    onEnter(modal, commit);
    refresh();
    input.focus();
    input.select();
  });
}

function checkBox(opt: DontAskAgain | undefined): { el: HTMLElement; input: HTMLInputElement } | null {
  if (!opt) return null;
  const input = h("input", { type: "checkbox" }) as HTMLInputElement;
  return { el: h("label", { class: "modal-check" }, input, opt.label), input };
}

function button(label: string, primary: boolean, run: () => void, danger = false): HTMLButtonElement {
  const b = h("button", { class: `btn${primary ? " primary" : ""}${danger ? " danger" : ""}` }, label);
  on(b, "pointerup", () => { if (!b.disabled) run(); });
  // Space on a focused button, which arrives as a click and not a pointerup.
  on(b, "keydown", (ev) => {
    const e = ev as unknown as KeyboardEvent;
    if (e.key === " ") { e.preventDefault(); e.stopPropagation(); if (!b.disabled) run(); }
  });
  return b;
}

function onEnter(modal: Modal, run: () => void): void {
  on(modal.el, "keydown", (ev) => {
    const e = ev as unknown as KeyboardEvent;
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    // Enter on a focused button presses that button, as it would anywhere.
    const focused = document.activeElement;
    if (focused instanceof HTMLButtonElement && modal.el.contains(focused)) {
      if (!focused.disabled) focused.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      return;
    }
    run();
  });
}
