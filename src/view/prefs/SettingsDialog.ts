import type { Store, ViewFlag } from "@/app/Store";
import { PREF_LIMITS, type PrefsCategory } from "@/core/prefs/prefs";
import { shade } from "@/core/prefs/color";
import { Modal } from "@/view/widgets/Modal";
import { NumberField } from "@/view/widgets/NumberField";
import { clear, h, on } from "@/view/widgets/dom";
import { ColorField } from "./colorField";
import { renderShortcutsPane } from "./ShortcutsPane";
import type { Keymap } from "@/app/Keymap";

/**
 * Preferences: the editor's own parameters, in one place.
 *
 * The layout is Photoshop's — categories down the left, the fields for one of
 * them on the right — because the alternative for forty-odd settings is a
 * scroll the user has to search. The content is DATA (`CATEGORIES` below) and
 * one small renderer, so adding a setting is a row in a list rather than a new
 * layout.
 *
 * Changes apply LIVE: colours and tolerances are judged against the stage, not
 * against their own swatch, and the stage is right there behind the dialog.
 * Cancel puts back the snapshot taken when it opened.
 */

type Row =
  | { kind: "check"; cat: PrefsCategory; key: string; label: string; view?: ViewFlag }
  | { kind: "number"; cat: PrefsCategory; key: string; label: string; unit?: string }
  | { kind: "color"; cat: PrefsCategory; key: string; label: string }
  | { kind: "select"; cat: PrefsCategory; key: string; label: string;
      options: Array<{ value: string; text: string }> }
  | { kind: "note"; text: string }
  | { kind: "button"; label: string; text: string;
      /** `again` redraws the pane: a button that writes other rows' values
       *  leaves their fields showing what they were built with otherwise. */
      run(store: Store, hooks: Hooks, again: () => void): void };

interface Section { title: string; rows: Row[] }
interface Category {
  id: PrefsCategory;
  label: string;
  sections: Section[];
  /** A pane that is not a list of rows. */
  render?(pane: HTMLElement, store: Store, hooks: Hooks): void;
}

export interface Hooks {
  /** Put every panel back where it started — the dock's own reset. */
  resetLayout(): void;
  keymap: Keymap;
  toast(message: string, isError?: boolean): void;
  /** Open the Keyboard Shortcuts window. */
  showShortcuts(): void;
}

const CATEGORIES: Category[] = [
  {
    id: "general", label: "General",
    sections: [
      {
        title: "Files", rows: [
          { kind: "check", cat: "general", key: "autosave", label: "Autosave" },
          { kind: "number", cat: "general", key: "autosaveSeconds", label: "Interval", unit: "s" },
          { kind: "check", cat: "general", key: "confirmDiscard", label: "Confirm before discarding changes" },
          { kind: "note", text: "Autosave keeps a single recovery copy inside this browser. It does not save your file: use File ▸ Save for that." },
        ],
      },
      {
        title: "New documents", rows: [
          { kind: "number", cat: "general", key: "newDocWidth", label: "Width", unit: "px" },
          { kind: "number", cat: "general", key: "newDocHeight", label: "Height", unit: "px" },
          { kind: "number", cat: "general", key: "newDocFps", label: "Frame rate", unit: "fps" },
          { kind: "color", cat: "general", key: "newDocBackground", label: "Background" },
          { kind: "note", text: "Used by File ▸ New. To change the open document, click an empty spot on the stage and edit it in the Properties panel." },
        ],
      },
      {
        title: "Bones and IK", rows: [
          { kind: "check", cat: "general", key: "guardIkReparent", label: "Refuse to re-parent bones the IK solves" },
          { kind: "note", text: "Re-parenting keeps a bone where it looks, and a solved bone looks the way the IK bends it: that bend would be written into its rest pose, and the exported IK would bend it again on top." },
        ],
      },
      {
        title: "Library", rows: [
          { kind: "check", cat: "general", key: "confirmLibraryDelete", label: "Ask before deleting library items" },
        ],
      },
    ],
  },
  {
    id: "interface", label: "Interface",
    sections: [
      {
        title: "Appearance", rows: [
          { kind: "color", cat: "interface", key: "accent", label: "Accent" },
          { kind: "color", cat: "interface", key: "accentRow", label: "Selected rows" },
          { kind: "color", cat: "interface", key: "accentHot", label: "Editable values" },
          {
            kind: "button", label: "", text: "Derive from accent",
            run: (store, _hooks, again) => {
              const accent = store.prefs.value.interface.accent;
              store.prefs.set("interface", {
                accentRow: shade(accent, -0.38),
                accentHot: shade(accent, 0.18),
              });
              again();
            },
          },
          { kind: "note", text: "Selected rows colours the selected row in the Library, Outline, History and timeline. Editable values colours the numbers you can drag to change. Derive from accent sets both from the accent colour." },
          { kind: "color", cat: "interface", key: "accentBlue", label: "Focus / links" },
          { kind: "color", cat: "interface", key: "setup", label: "Setup pose" },
          { kind: "color", cat: "interface", key: "warn", label: "Warning" },
        ],
      },
      {
        title: "Text", rows: [
          {
            kind: "select", cat: "interface", key: "fontSize", label: "Font size",
            options: [
              { value: "tiny", text: "Tiny" },
              { value: "small", text: "Small" },
              { value: "medium", text: "Medium" },
              { value: "large", text: "Large" },
            ],
          },
          { kind: "note", text: "Applies immediately. Text and the rows that hold it change size; icons and the tool bar do not." },
        ],
      },
      {
        title: "Panels", rows: [
          {
            kind: "button", label: "Layout", text: "Reset panel layout",
            run: (_s, hooks) => hooks.resetLayout(),
          },
          { kind: "note", text: "Puts every panel, floating ones included, back where it was at first launch." },
        ],
      },
    ],
  },
  {
    id: "stage", label: "Stage, Grid & Rulers",
    sections: [
      {
        title: "Grid", rows: [
          { kind: "check", cat: "stage", key: "showGrid", label: "Show grid", view: "showGrid" },
          { kind: "number", cat: "stage", key: "gridSize", label: "Spacing", unit: "px" },
          { kind: "number", cat: "stage", key: "gridSubdivisions", label: "Major line every", unit: "cells" },
          { kind: "color", cat: "stage", key: "gridColor", label: "Line" },
          { kind: "color", cat: "stage", key: "gridMajorColor", label: "Major line" },
        ],
      },
      {
        title: "Rulers and guides", rows: [
          { kind: "check", cat: "stage", key: "showRulers", label: "Show rulers", view: "showRulers" },
          { kind: "color", cat: "stage", key: "rulerBg", label: "Ruler" },
          { kind: "color", cat: "stage", key: "rulerTick", label: "Ticks" },
          { kind: "color", cat: "stage", key: "rulerText", label: "Numbers" },
          { kind: "check", cat: "stage", key: "showGuides", label: "Show guides", view: "showGuides" },
          { kind: "color", cat: "stage", key: "guideColor", label: "Guide" },
          { kind: "check", cat: "stage", key: "lockGuides", label: "Lock guides" },
          { kind: "note", text: "Drag from a ruler to create a guide. Drag it back onto the ruler to remove it, or double-click it to type its position. Guides are not saved with the document." },
        ],
      },
      {
        title: "Stage", rows: [
          { kind: "color", cat: "stage", key: "stageEdgeColor", label: "Stage edge" },
          { kind: "color", cat: "stage", key: "pasteboard", label: "Pasteboard" },
        ],
      },
    ],
  },
  {
    id: "snap", label: "Snapping",
    sections: [
      {
        title: "Snapping", rows: [
          { kind: "check", cat: "snap", key: "enabled", label: "Snap while dragging", view: "snap" },
          { kind: "number", cat: "snap", key: "tolerancePx", label: "Tolerance", unit: "px" },
          { kind: "note", text: "Tolerance is in screen pixels, so snapping feels the same at every zoom. Hold ⌘ (Ctrl) while dragging to turn snapping off for that drag." },
        ],
      },
      {
        title: "Snap to", rows: [
          { kind: "check", cat: "snap", key: "toGrid", label: "Grid" },
          { kind: "check", cat: "snap", key: "toGuides", label: "Guides" },
          { kind: "check", cat: "snap", key: "toObjects", label: "Object edges and centres" },
          { kind: "check", cat: "snap", key: "toStage", label: "Stage edges and centre" },
          { kind: "check", cat: "snap", key: "toPixel", label: "Whole pixels" },
        ],
      },
      {
        title: "Feedback", rows: [
          { kind: "check", cat: "snap", key: "showLines", label: "Show smart guides" },
          { kind: "color", cat: "snap", key: "lineColor", label: "Smart guide" },
        ],
      },
    ],
  },
  {
    id: "gizmos", label: "Selection & Gizmos",
    sections: [
      {
        title: "What is drawn", rows: [
          { kind: "check", cat: "gizmos", key: "showBones", label: "Show bones", view: "showBones" },
          { kind: "check", cat: "gizmos", key: "showGizmos", label: "Show gizmos", view: "showGizmos" },
          { kind: "number", cat: "gizmos", key: "handleSize", label: "Handle size", unit: "px" },
        ],
      },
      {
        title: "Selection", rows: [
          { kind: "color", cat: "gizmos", key: "select", label: "Selection" },
          { kind: "color", cat: "gizmos", key: "marquee", label: "Marquee fill" },
          { kind: "color", cat: "gizmos", key: "marqueeEdge", label: "Marquee edge" },
          { kind: "color", cat: "gizmos", key: "pivot", label: "Transform point" },
          { kind: "color", cat: "gizmos", key: "axisX", label: "Axis X" },
          { kind: "color", cat: "gizmos", key: "axisY", label: "Axis Y" },
        ],
      },
      {
        title: "Bones and IK", rows: [
          { kind: "color", cat: "gizmos", key: "bone", label: "Bone" },
          { kind: "color", cat: "gizmos", key: "boneIk", label: "Bone driven by IK" },
          { kind: "color", cat: "gizmos", key: "ikTarget", label: "IK target" },
          { kind: "color", cat: "gizmos", key: "ikLink", label: "IK link" },
        ],
      },
    ],
  },
  {
    id: "timeline", label: "Timeline & Onion",
    sections: [
      {
        title: "Frame grid", rows: [
          { kind: "number", cat: "timeline", key: "frameWidth", label: "Frame width", unit: "px" },
          { kind: "color", cat: "timeline", key: "playhead", label: "Playhead" },
          { kind: "color", cat: "timeline", key: "keyframe", label: "Keyframe" },
          { kind: "color", cat: "timeline", key: "tween", label: "Tween" },
          { kind: "color", cat: "timeline", key: "selected", label: "Selected frames" },
        ],
      },
      {
        title: "Onion skin", rows: [
          { kind: "number", cat: "timeline", key: "onionBefore", label: "Frames before" },
          { kind: "number", cat: "timeline", key: "onionAfter", label: "Frames after" },
          { kind: "number", cat: "timeline", key: "onionOpacity", label: "Starting opacity" },
          { kind: "number", cat: "timeline", key: "onionFalloff", label: "Decrease by" },
          { kind: "check", cat: "timeline", key: "onionTint", label: "Colour-code past and future" },
          { kind: "color", cat: "timeline", key: "onionPastColor", label: "Past" },
          { kind: "color", cat: "timeline", key: "onionFutureColor", label: "Future" },
          { kind: "check", cat: "timeline", key: "onionKeyframesOnly", label: "Keyframes only" },
          { kind: "check", cat: "timeline", key: "onionOutline", label: "Outline" },
          { kind: "note", text: "You can also drag the onion markers above the frames: ⌘-drag widens both sides at once, ⇧-drag moves the whole range. Locked layers never show onion skin." },
        ],
      },
    ],
  },
  {
    id: "keys", label: "Shortcuts", sections: [],
    render: (pane, store, hooks) => renderShortcutsPane(pane, store, hooks),
  },
];

export function openSettings(store: Store, hooks: Hooks, initial?: PrefsCategory): void {
  const prefs = store.prefs;
  const before = prefs.snapshot();
  let current = CATEGORIES.find((c) => c.id === initial) ?? CATEGORIES[0]!;
  let committed = false;

  const modal = new Modal({
    title: "Preferences", width: 840, height: 600,
    onClose: () => { if (!committed) prefs.restore(before); },
  });

  const list = h("div", { class: "set-cats" });
  const pane = h("div", { class: "set-pane" });
  modal.body.classList.add("settings");
  modal.body.appendChild(h("div", { class: "set-split" }, list, pane));

  const renderCats = () => {
    clear(list);
    for (const cat of CATEGORIES) {
      const btn = h("div", {
        class: `set-cat${cat.id === current.id ? " on" : ""}`, tabindex: "0",
      }, cat.label);
      // pointerup, not click: the pane under the pointer is rebuilt, and a
      // click retargeted to a common ancestor never fires. See CLAUDE.md.
      on(btn, "pointerup", () => { current = cat; renderCats(); renderPane(); });
      list.appendChild(btn);
    }
  };

  const renderPane = () => {
    clear(pane);
    if (current.render) { current.render(pane, store, hooks); return; }
    for (const section of current.sections) {
      const rows = section.rows.map((r) => renderRow(store, hooks, r, () => renderPane()));
      pane.appendChild(h("div", { class: "set-section" },
        h("div", { class: "set-legend" }, section.title),
        ...rows));
    }
  };

  const reset = h("button", { class: "btn" }, "Restore Defaults");
  on(reset, "pointerup", () => { prefs.resetCategory(current.id); renderPane(); });

  const cancel = h("button", { class: "btn" }, "Cancel");
  on(cancel, "pointerup", () => modal.close());

  const ok = h("button", { class: "btn primary" }, "OK");
  on(ok, "pointerup", () => { committed = true; modal.close(); });

  modal.footer.appendChild(reset);
  modal.footer.appendChild(h("div", { class: "spacer" }));
  modal.footer.appendChild(cancel);
  modal.footer.appendChild(ok);

  renderCats();
  renderPane();
}

function renderRow(store: Store, hooks: Hooks, row: Row, again: () => void): HTMLElement {
  if (row.kind === "note") return h("div", { class: "pnote" }, row.text);

  if (row.kind === "button") {
    const b = h("button", { class: "btn" }, row.text);
    // pointerup, and the handler may rebuild the pane under it — the button
    // removing itself mid-gesture is fine, a `click` would be the one lost.
    on(b, "pointerup", () => row.run(store, hooks, again));
    return h("div", { class: "prow" }, h("label", null, row.label), h("div", { class: "fields" }, b));
  }

  const prefs = store.prefs;
  const read = () => (prefs.value[row.cat] as unknown as Record<string, unknown>)[row.key];

  if (row.kind === "check") {
    const box = h("input", { type: "checkbox", checked: read() === true });
    on(box, "change", () => {
      // The six switches the View menu also owns go through the Store, so the
      // menu, the stage bar and this dialog can never disagree.
      if (row.view) store.setViewFlag(row.view, box.checked);
      else prefs.set(row.cat, { [row.key]: box.checked } as never);
    });
    return h("div", { class: "prow" },
      h("label", null, row.label),
      h("div", { class: "fields" }, box));
  }

  if (row.kind === "select") {
    const sel = h("select", { class: "preview-anim" },
      ...row.options.map((o) => h("option", { value: o.value }, o.text))) as HTMLSelectElement;
    sel.value = String(read());
    on(sel, "change", () => prefs.set(row.cat, { [row.key]: sel.value } as never));
    return h("div", { class: "prow" },
      h("label", null, row.label),
      h("div", { class: "fields" }, sel));
  }

  if (row.kind === "color") {
    const field = new ColorField(String(read()), (css) => {
      prefs.set(row.cat, { [row.key]: css } as never);
    });
    return h("div", { class: "prow" },
      h("label", null, row.label),
      h("div", { class: "fields" }, field.el));
  }

  const lim = PREF_LIMITS[`${row.cat}.${row.key}`];
  const nf = new NumberField({
    unit: row.unit,
    min: lim?.min, max: lim?.max,
    step: lim?.step ?? 1,
    decimals: lim?.decimals ?? 0,
    onInput: (v) => prefs.set(row.cat, { [row.key]: v } as never),
  });
  nf.set(Number(read()));
  return h("div", { class: "prow" },
    h("label", null, row.label),
    h("div", { class: "fields" }, nf.el));
}
