import { Modal } from "./Modal";
import { NumberField } from "./NumberField";
import { h, on } from "./dom";

export interface PromptNumberOptions {
  title: string;
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  decimals?: number;
  /** A third button on the left of the footer — Delete, for a guide. */
  extra?: { label: string; run(): void };
  onOk(value: number): void;
}

/**
 * A one-field dialog, for the places that used to call `prompt()`.
 *
 * Deliberately tiny: it exists because a double-clicked guide has to be
 * editable numerically — dragging a guide to an exact coordinate is the one
 * thing dragging cannot do — and `prompt()` cannot offer the Delete button
 * that belongs next to it.
 */
export function promptNumber(opts: PromptNumberOptions): void {
  const modal = new Modal({ title: opts.title, width: 320, height: 150 });

  const field = new NumberField({
    min: opts.min, max: opts.max, step: 1, decimals: opts.decimals ?? 0,
    unit: opts.unit,
  });
  field.set(opts.value);

  modal.body.appendChild(h("div", { class: "modal-form" },
    h("div", { class: "prow" },
      h("label", null, opts.label),
      h("div", { class: "fields" }, field.el))));

  const commit = () => {
    const v = field.get();
    modal.close();
    opts.onOk(v);
  };

  if (opts.extra) {
    const btn = h("button", { class: "btn" }, opts.extra.label);
    on(btn, "pointerup", () => { modal.close(); opts.extra!.run(); });
    modal.footer.appendChild(btn);
  }
  modal.footer.appendChild(h("div", { class: "spacer" }));

  const cancel = h("button", { class: "btn" }, "Cancel");
  on(cancel, "pointerup", () => modal.close());
  const ok = h("button", { class: "btn primary" }, "OK");
  on(ok, "pointerup", commit);
  modal.footer.appendChild(cancel);
  modal.footer.appendChild(ok);

  const input = field.el.querySelector("input");
  if (input) {
    input.focus();
    input.select();
    // Enter commits the dialog, not just the field: the field's own Enter
    // handler already parsed the text by the time this runs.
    on(input, "keydown", (ev) => {
      const e = ev as unknown as KeyboardEvent;
      if (e.key === "Enter") { e.stopPropagation(); commit(); }
    });
  }
}
