import type { Store } from "@/app/Store";
import {
  DEFAULT_EXPORT_SETTINGS,
  EXPORT_LIMITS,
  type ExportSettings,
  exportNotes,
  sanitizeExportSettings,
} from "@/core/export/settings";
import { SetExportSettings } from "@/core/history/commands";
import { exportSettingsOf } from "@/io/export/ExportBundle";
import { Modal } from "@/view/widgets/Modal";
import { NumberField } from "@/view/widgets/NumberField";
import { clear, h, on } from "@/view/widgets/dom";

/**
 * File ▸ Export Settings…: what the export writes, for THIS document.
 *
 * Unlike Preferences nothing applies live — the settings are part of the
 * document, so OK writes them as one undoable step and Cancel writes nothing.
 * The rows are data, as in the Preferences dialog.
 */

type Key = keyof ExportSettings;
type Row =
  | { kind: "number"; key: Key; label: string; unit?: string; percent?: boolean; enabled?(s: ExportSettings): boolean }
  | { kind: "check"; key: Key; label: string }
  | { kind: "select"; key: Key; label: string; options: Array<{ value: string; text: string }>;
      enabled?(s: ExportSettings): boolean };

const SECTIONS: Array<{ title: string; rows: Row[] }> = [
  {
    title: "Format", rows: [
      { kind: "select", key: "format", label: "Runtime", options: [
        { value: "dragonbones-pixi", text: "DragonBones 5.5 (Pixi 8)" },
      ] },
    ],
  },
  {
    title: "Atlas pages", rows: [
      { kind: "select", key: "layout", label: "Pages", options: [
        { value: "packed", text: "Packed" },
        { value: "perImage", text: "One per image" },
      ] },
      { kind: "number", key: "maxWidth", label: "Maximum width", unit: "px" },
      { kind: "number", key: "maxHeight", label: "Maximum height", unit: "px" },
      { kind: "check", key: "powerOfTwo", label: "Power of two" },
      { kind: "check", key: "square", label: "Square" },
      { kind: "number", key: "padding", label: "Padding", unit: "px" },
      { kind: "number", key: "extrude", label: "Edge extrusion", unit: "px" },
    ],
  },
  {
    title: "Trim", rows: [
      { kind: "check", key: "trim", label: "Trim transparent edges" },
      { kind: "number", key: "alphaThreshold", label: "Alpha counted as empty", enabled: (s) => s.trim },
    ],
  },
  {
    title: "Resolution", rows: [
      { kind: "number", key: "scale", label: "Texture scale", unit: "%", percent: true },
      { kind: "select", key: "resample", label: "Resampling", enabled: (s) => s.scale < 1, options: [
        { value: "lanczos", text: "Lanczos (sharp)" },
        { value: "bilinear", text: "Bilinear (smooth)" },
        { value: "nearest", text: "Nearest (pixel art)" },
      ] },
    ],
  },
  {
    title: "Files", rows: [
      { kind: "select", key: "image", label: "Image format", options: [
        { value: "png", text: "PNG" },
        { value: "webp", text: "WebP" },
      ] },
      { kind: "number", key: "imageQuality", label: "WebP quality", unit: "%", percent: true,
        enabled: (s) => s.image === "webp" },
      { kind: "check", key: "minifyJson", label: "Minify JSON" },
    ],
  },
];

export function openExportSettings(store: Store): void {
  const original = exportSettingsOf(store.project);
  let draft: ExportSettings = { ...original };

  const modal = new Modal({ title: "Export Settings", width: 560, height: 620 });
  const pane = h("div", { class: "set-pane" });
  modal.body.classList.add("settings");
  modal.body.appendChild(pane);

  // Built once and synced in place: rebuilding on every change removed the
  // field being left, whose blur commits and rebuilds again under the click
  // that caused it (the DOM trap in ARCHITECTURE.md).
  const rows: Array<{ el: HTMLElement; sync(s: ExportSettings): void }> = [];
  const notesBox = h("div", { class: "set-section" });
  const sync = () => {
    for (const r of rows) r.sync(draft);
    clear(notesBox);
    for (const n of exportNotes(draft)) notesBox.appendChild(h("div", { class: "pnote" }, n));
    notesBox.style.display = notesBox.childElementCount ? "" : "none";
  };
  const set = (key: Key, value: unknown) => {
    draft = sanitizeExportSettings({ ...draft, [key]: value });
    sync();
  };
  for (const section of SECTIONS) {
    const built = section.rows.map((r) => buildRow(r, set));
    rows.push(...built);
    pane.appendChild(h("div", { class: "set-section" },
      h("div", { class: "set-legend" }, section.title), ...built.map((b) => b.el)));
  }
  pane.appendChild(notesBox);

  const reset = h("button", { class: "btn" }, "Restore Defaults");
  on(reset, "pointerup", () => { draft = { ...DEFAULT_EXPORT_SETTINGS }; sync(); });
  const cancel = h("button", { class: "btn" }, "Cancel");
  on(cancel, "pointerup", () => modal.close());
  const ok = h("button", { class: "btn primary" }, "OK");
  on(ok, "pointerup", () => {
    modal.close();
    if (sameSettings(draft, original)) return;
    store.apply(new SetExportSettings(draft));
    store.emit("doc");
  });
  modal.footer.append(reset, h("div", { class: "spacer" }), cancel, ok);

  sync();
}

function sameSettings(a: ExportSettings, b: ExportSettings): boolean {
  return (Object.keys(a) as Key[]).every((k) => a[k] === b[k]);
}

function buildRow(
  row: Row, set: (key: Key, value: unknown) => void,
): { el: HTMLElement; sync(s: ExportSettings): void } {
  const enabledIn = (s: ExportSettings) => ("enabled" in row && row.enabled ? row.enabled(s) : true);
  let control: HTMLElement;
  let sync: (s: ExportSettings) => void;

  if (row.kind === "check") {
    const box = h("input", { type: "checkbox" }) as HTMLInputElement;
    on(box, "change", () => set(row.key, box.checked));
    control = box;
    sync = (s) => { box.checked = s[row.key] === true; };
  } else if (row.kind === "select") {
    const sel = h("select", { class: "preview-anim" },
      ...row.options.map((o) => h("option", { value: o.value }, o.text))) as HTMLSelectElement;
    on(sel, "change", () => set(row.key, sel.value));
    control = sel;
    sync = (s) => { sel.value = String(s[row.key]); sel.disabled = !enabledIn(s); };
  } else {
    const lim = (EXPORT_LIMITS as Record<string, { min: number; max: number }>)[row.key];
    const k = row.percent ? 100 : 1;
    const field = new NumberField({
      min: lim ? lim.min * k : undefined, max: lim ? lim.max * k : undefined,
      step: 1, decimals: 0, unit: row.unit,
      onInput: (v, committing) => { if (committing) set(row.key, v / k); },
    });
    control = field.el;
    sync = (s) => { field.show((s[row.key] as number) * k); field.setDisabled(!enabledIn(s)); };
  }
  return {
    el: h("div", { class: "prow" }, h("label", null, row.label), h("div", { class: "fields" }, control)),
    sync,
  };
}
