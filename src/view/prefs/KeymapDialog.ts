import type { Keymap } from "@/app/Keymap";
import { Modal } from "@/view/widgets/Modal";
import { clear, cls, h, on } from "@/view/widgets/dom";
import { chordCandidates, formatModifier } from "@/core/keys/chord";
import { CATEGORY_ORDER, COMMANDS, COMMANDS_BY_ID, GESTURES } from "@/core/keys/commands";
import { browserConflict } from "@/core/keys/browserKeys";

/**
 * Help ▸ Keyboard Shortcuts: what every key does, read-only.
 *
 * Two ways in: type to search by command or by key, or switch on Find by Key
 * and press the combination itself — the question is usually "what did that
 * key just do", and the answer should not require knowing how to spell ⌥.
 */
export function openKeymapDialog(km: Keymap, customize: () => void): void {
  const modal = new Modal({ title: "Keyboard Shortcuts", width: 640, height: 580 });
  const fmt = (chord: string) => km.format(chord);

  let query = "";
  let showUnassigned = false;
  let finding = false;
  let found: string[] | null = null;

  const search = h("input", { class: "field sc-search", type: "search", placeholder: "Search" });
  on(search, "input", () => { query = search.value.trim().toLowerCase(); render(); });

  const findBtn = h("button", { class: "btn km-find" }, "Find by Key");
  const setFinding = (onOff: boolean) => {
    finding = onOff;
    found = null;
    cls(findBtn, "on", onOff);
    findBtn.textContent = onOff ? "Press a key… (Esc to stop)" : "Find by Key";
    if (onOff) { findBtn.setAttribute("data-key-capture", ""); findBtn.focus(); }
    else findBtn.removeAttribute("data-key-capture");
    render();
  };
  on(findBtn, "pointerup", () => setFinding(!finding));
  on(findBtn, "keydown", (ev) => {
    if (!finding) return;
    const e = ev as unknown as KeyboardEvent;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      setFinding(false);
      return;
    }
    const c = chordCandidates(e, km.platform);
    if (!c.length) return;
    found = c;
    render();
  });

  const unassigned = h("input", { type: "checkbox" });
  on(unassigned, "change", () => { showUnassigned = unassigned.checked; render(); });

  const status = h("div", { class: "km-status" });
  // The columns sit inside the scroller: a height-bound multi-column box
  // overflows sideways instead of down.
  const list = h("div", { class: "km-cols" });

  modal.body.appendChild(h("div", { class: "km" },
    h("div", { class: "sc-bar" },
      search, findBtn,
      h("div", { class: "spacer" }),
      h("label", { class: "km-check" }, unassigned, "Show unassigned")),
    status,
    h("div", { class: "km-list" }, list)));

  const keysCell = (chords: string[]) => h("div", { class: "km-keys" },
    ...chords.map((k) => {
      const conflict = browserConflict(k, km.platform);
      return h("kbd", {
        class: conflict ? "warn" : "",
        title: conflict ? `In the browser: ${conflict.what}. In the editor it runs the editor's command.` : "",
      }, fmt(k));
    }));

  const render = () => {
    clear(list);
    clear(status);
    const resolved = km.resolved;

    let ids: Set<string> | null = null;
    if (finding && found) {
      const hit = found.map((c) => resolved.byChord.get(c)).find(Boolean);
      const shown = fmt(found[0]!);
      const conflict = browserConflict(found[0]!, km.platform);
      status.appendChild(h("kbd", null, shown));
      status.appendChild(document.createTextNode(hit
        ? ` runs ${COMMANDS_BY_ID.get(hit)!.label}`
        : " is not assigned"));
      if (conflict) {
        status.appendChild(h("span", { class: `km-note ${conflict.level}` }, conflict.level === "reserved"
          ? ` · reserved by the browser or the system (${conflict.what})`
          : ` · in the browser: ${conflict.what}${hit ? " (the editor uses it here)" : ""}`));
      }
      ids = new Set(hit ? [hit] : []);
    } else if (finding) {
      status.textContent = "Press any combination to see what it does.";
    }

    for (const cat of CATEGORY_ORDER) {
      const rows = COMMANDS.filter((d) => {
        if (d.category !== cat) return false;
        const keys = resolved.byCommand.get(d.id) ?? [];
        if (ids) return ids.has(d.id);
        if (!keys.length && !showUnassigned && !query) return false;
        if (!query) return true;
        return d.label.toLowerCase().includes(query)
          || cat.toLowerCase().includes(query)
          || keys.some((k) => fmt(k).toLowerCase().includes(query) || k.toLowerCase().includes(query));
      });
      if (!rows.length) continue;
      list.appendChild(h("div", { class: "km-group" },
        h("div", { class: "km-cat" }, cat),
        ...rows.map((d) => h("div", { class: "km-row" },
          keysCell(resolved.byCommand.get(d.id) ?? []),
          h("span", { class: "km-label" }, d.label)))));
    }

    if (!ids) {
      const gestures = GESTURES.filter((g) => !query || g.label.toLowerCase().includes(query));
      if (gestures.length) {
        list.appendChild(h("div", { class: "km-group" },
          h("div", { class: "km-cat" }, "Mouse & modifiers"),
          ...gestures.map((g) => h("div", { class: "km-row" },
            h("div", { class: "km-keys" },
              g.chord ? h("kbd", null, formatModifier(g.chord, km.platform)) : null,
              g.suffix ? h("span", { class: "km-suffix" }, g.suffix) : null),
            h("span", { class: "km-label" }, g.label)))));
      }
    }
    if (!list.firstChild) list.appendChild(h("div", { class: "sc-empty" }, "Nothing matches."));
  };

  const edit = h("button", { class: "btn" }, "Customize…");
  on(edit, "pointerup", () => { modal.close(); customize(); });
  const close = h("button", { class: "btn primary" }, "Close");
  on(close, "pointerup", () => modal.close());
  modal.footer.appendChild(edit);
  modal.footer.appendChild(h("div", { class: "spacer" }));
  modal.footer.appendChild(close);

  render();
  search.focus();
}
