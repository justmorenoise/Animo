import type { Store } from "@/app/Store";
import { clear, h, on } from "@/view/widgets/dom";
import { chordFromEvent } from "@/core/keys/chord";
import { CATEGORY_ORDER, type CommandDef, COMMANDS, COMMANDS_BY_ID } from "@/core/keys/commands";
import { browserConflict } from "@/core/keys/browserKeys";
import {
    assignChord,
    type Overrides,
    parseKeymapFile,
    removeChord,
    resetCommand,
    serializeKeymap,
} from "@/core/keys/keymap";
import { KEYMAP_TYPE, pickOpenFile, pickSaveLocation, writeFile, } from "@/io/project/FileSystem";
import type { Hooks } from "./SettingsDialog";

/**
 * Preferences ▸ Shortcuts: every command, its chords, and a recorder.
 *
 * Writes go straight to `Prefs.keys` like every other preference, so they
 * are live and Cancel puts them back. The three outcomes of recording a chord
 * are the point of the pane: a chord the browser keeps is refused, a chord
 * the browser merely uses is accepted with a warning, and a chord another
 * command holds asks before it moves.
 */
export function renderShortcutsPane(pane: HTMLElement, store: Store, hooks: Hooks): void {
  const km = hooks.keymap;
  const platform = km.platform;
  const prefs = store.prefs;

  let query = "";
  let recording: { id: string; replacing?: string } | null = null;
  let pending: { id: string; chord: string; owner: string; replacing?: string } | null = null;
  let notice: { id: string; text: string; error: boolean } | null = null;

  const overrides = (): Overrides => prefs.value.keys;
  const write = (o: Overrides) => prefs.replace("keys", o);
  const fmt = (chord: string) => km.format(chord);

  const search = h("input", {
    class: "field sc-search", type: "search", placeholder: "Search commands or keys",
  });
  on(search, "input", () => { query = search.value.trim().toLowerCase(); renderList(); });

  const button = (text: string, run: () => void) => {
    const b = h("button", { class: "btn" }, text);
    on(b, "pointerup", run);
    return b;
  };

  const save = async () => {
    try {
      const ref = await pickSaveLocation("animo-shortcuts.json", KEYMAP_TYPE, "animo-keymap");
      if (!ref) return;
      const json = JSON.stringify(serializeKeymap(overrides(), platform), null, 2);
      await writeFile(ref, new Blob([json], { type: "application/json" }));
      hooks.toast(`Saved shortcuts to ${ref.name}`);
    } catch (err) {
      hooks.toast(`Could not save shortcuts: ${(err as Error).message}`, true);
    }
  };

  const load = async () => {
    try {
      const picked = await pickOpenFile(KEYMAP_TYPE, "animo-keymap");
      if (!picked) return;
      const report = parseKeymapFile(new TextDecoder().decode(picked.data), platform);
      if ("error" in report) { hooks.toast(report.error, true); return; }
      write(report.overrides);
      recording = pending = notice = null;
      renderList();
      const parts = [`Loaded ${report.loaded} shortcuts from ${picked.ref.name}`];
      if (report.unknown.length) parts.push(`${report.unknown.length} unknown commands skipped`);
      if (report.invalid.length) parts.push(`${report.invalid.length} invalid keys skipped`);
      if (report.reserved.length) parts.push(`${report.reserved.length} browser-reserved keys dropped`);
      for (const line of [...report.unknown, ...report.invalid, ...report.reserved]) {
        console.warn(`[Shortcuts] skipped ${line}`);
      }
      hooks.toast(parts.join(" · "), parts.length > 1);
    } catch (err) {
      hooks.toast(`Could not load shortcuts: ${(err as Error).message}`, true);
    }
  };

  const viewAll = h("button", { class: "btn" }, "View All…");
  on(viewAll, "pointerup", () => hooks.showShortcuts());

  pane.appendChild(h("div", { class: "sc-bar" },
    search,
    h("div", { class: "spacer" }),
    button("Load…", () => void load()),
    button("Save…", () => void save()),
    button("Reset All", () => { write({}); recording = pending = notice = null; renderList(); }),
    viewAll));
  pane.appendChild(h("div", { class: "pnote" },
    "Click a key to change it, + to add another. Keys the browser or the system keeps for "
    + "itself (⌘W, ⌘T, ⌘N, ⌘Q, Ctrl+Tab…) cannot be used, because they act before the editor "
    + "receives them. ⚠ marks a key that normally does something in the browser: in the editor "
    + "it runs the editor's command instead."));
  const list = h("div", { class: "sc-list" });
  pane.appendChild(list);

  const commit = (id: string, chord: string, replacing?: string) => {
    recording = null;
    pending = null;
    const conflict = browserConflict(chord, platform);
    if (conflict?.level === "reserved") {
      notice = { id, text: `${fmt(chord)} is reserved by the browser or the system (${conflict.what}). Pick another key.`, error: true };
      renderList();
      return;
    }
    const owner = km.resolved.byChord.get(chord);
    if (owner && owner !== id) {
      pending = { id, chord, owner, replacing };
      notice = null;
      renderList();
      return;
    }
    apply(id, chord, replacing);
  };

  const apply = (id: string, chord: string, replacing?: string) => {
    write(assignChord(overrides(), id, chord, platform, replacing));
    const conflict = browserConflict(chord, platform);
    notice = conflict
      ? { id, text: `${fmt(chord)} is “${conflict.what}” in the browser. While the editor has focus it runs this command instead.`, error: false }
      : null;
    pending = null;
    renderList();
  };

  const matches = (d: CommandDef): boolean => {
    if (!query) return true;
    const keys = km.resolved.byCommand.get(d.id) ?? [];
    return d.label.toLowerCase().includes(query)
      || d.category.toLowerCase().includes(query)
      || d.id.toLowerCase().includes(query)
      || keys.some((k) => fmt(k).toLowerCase().includes(query) || k.toLowerCase().includes(query));
  };

  const pill = (id: string, chord: string): HTMLElement => {
    const conflict = browserConflict(chord, platform);
    const text = h("span", { class: "key-text" }, fmt(chord));
    const del = h("span", { class: "key-del", title: "Remove" }, "×");
    const el = h("span", {
      class: `key-pill${conflict ? " warn" : ""}`,
      title: conflict ? `In the browser: ${conflict.what}. In the editor it runs the editor's command.` : "Click to change",
    }, conflict ? h("span", { class: "key-warn" }, "⚠") : null, text, del);
    on(text, "pointerup", () => { recording = { id, replacing: chord }; pending = notice = null; renderList(); });
    on(del, "pointerup", (e) => {
      e.stopPropagation();
      write(removeChord(overrides(), id, chord, platform));
      pending = notice = null;
      renderList();
    });
    return el;
  };

  const recorder = (id: string, replacing?: string): HTMLElement => {
    const el = h("span", {
      class: "key-pill recording", tabindex: "0", "data-key-capture": "",
    }, "Press keys…");
    on(el, "pointerup", () => el.focus());
    on(el, "keydown", (ev) => {
      const e = ev as unknown as KeyboardEvent;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        recording = null;
        renderList();
        return;
      }
      const chord = chordFromEvent(e, platform);
      if (chord) commit(id, chord, replacing);
    });
    return el;
  };

  const row = (d: CommandDef): HTMLElement[] => {
    const keys = km.resolved.byCommand.get(d.id) ?? [];
    const cell = h("div", { class: "sc-keys" });
    for (const k of keys) {
      cell.appendChild(recording?.id === d.id && recording.replacing === k ? recorder(d.id, k) : pill(d.id, k));
    }
    if (recording?.id === d.id && !recording.replacing) {
      cell.appendChild(recorder(d.id));
    } else {
      const add = h("span", { class: "key-add", title: "Add a key" }, "+");
      on(add, "pointerup", () => { recording = { id: d.id }; pending = notice = null; renderList(); });
      cell.appendChild(add);
    }

    const changed = d.id in overrides();
    const reset = h("span", {
      class: `sc-reset${changed ? "" : " hidden"}`, title: "Back to the default",
    }, "↺");
    if (changed) {
      on(reset, "pointerup", () => {
        write(resetCommand(overrides(), d.id));
        pending = notice = null;
        renderList();
      });
    }

    const out = [h("div", { class: `sc-row${changed ? " changed" : ""}` },
      h("span", { class: "sc-label" }, d.label), cell, reset)];

    if (pending?.id === d.id) {
      const p = pending;
      const yes = h("button", { class: "btn primary" }, "Reassign");
      on(yes, "pointerup", () => apply(p.id, p.chord, p.replacing));
      const no = h("button", { class: "btn" }, "Cancel");
      on(no, "pointerup", () => { pending = null; renderList(); });
      out.push(h("div", { class: "sc-msg" },
        h("span", null, `${fmt(p.chord)} is already used by `,
          h("b", null, COMMANDS_BY_ID.get(p.owner)?.label ?? p.owner), ". Reassign it?"),
        yes, no));
    } else if (notice?.id === d.id) {
      out.push(h("div", { class: `sc-msg${notice.error ? " error" : " warn"}` }, notice.text));
    }
    return out;
  };

  const renderList = () => {
    clear(list);
    for (const cat of CATEGORY_ORDER) {
      const defs = COMMANDS.filter((d) => d.category === cat && matches(d));
      if (!defs.length) continue;
      list.appendChild(h("div", { class: "set-section" },
        h("div", { class: "set-legend" }, cat),
        ...defs.flatMap(row)));
    }
    if (!list.firstChild) list.appendChild(h("div", { class: "sc-empty" }, "No command matches."));
    list.querySelector<HTMLElement>("[data-key-capture]")?.focus();
  };

  renderList();
}
