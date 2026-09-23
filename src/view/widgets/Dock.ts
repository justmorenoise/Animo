import { clear, cls, drag, h, on } from "./dom";
import { icon, type IconName } from "@/view/icons";
import { clampRect, type FloatRect, FloatWindow } from "./FloatWindow";
import { accelOf } from "./accel";

/**
 * A dock column of tabbed panel groups.
 *
 * Animate lets you tear panels anywhere; that is more modularity than this
 * tool needs and a lot of surface to get wrong. What we take from it is the
 * part that actually earns its keep day to day: panels live in tabbed
 * groups, you can drag a tab into another group or between groups to make a
 * new one, you can collapse a group to its tab strip, and you can drag the
 * boundary between groups to reweight them. Layout persists.
 */

export interface Panel {
  readonly id: string;
  readonly title: string;
  readonly icon: IconName;
  /** The panel body. Built once, kept alive across re-layouts. */
  readonly el: HTMLElement;
  /** Optional footer strip pinned below the body. */
  readonly footer?: HTMLElement;
  /** Called when the panel becomes the visible tab of its group. */
  onShow?(): void;
  /** Extra entries for the panel's hamburger menu. */
  menu?(): Array<{ label: string; run: () => void } | "-">;
}

interface GroupState {
  panelIds: string[];
  activeId: string;
  collapsed: boolean;
  /** Flex weight when expanded. */
  weight: number;
}

interface DockLayout {
  groups: GroupState[];
  /** Panels torn out of the column, by id. */
  floats: Record<string, FloatRect>;
  /** Panels the user closed. Kept so they are not silently re-added. */
  closed: string[];
  /**
   * For each closed panel, a panel it was grouped with. Reopening puts it
   * back beside that one instead of stranding it in a group of its own.
   */
  closedNear?: Record<string, string>;
}

export class Dock {
  readonly el: HTMLElement;
  private panels = new Map<string, Panel>();
  private layout: DockLayout = { groups: [], floats: {}, closed: [] };
  private groupEls: HTMLElement[] = [];
  private floatWins = new Map<string, FloatWindow>();
  /** Notified whenever a panel opens, closes, floats or docks. */
  onLayoutChange: (() => void) | null = null;

  constructor(
    private readonly storageKey: string,
    private readonly orientation: "vertical" | "horizontal" = "vertical",
  ) {
    this.el = h("div", { class: "dock-col" });
    this.el.style.display = "flex";
    this.el.style.flexDirection = orientation === "vertical" ? "column" : "row";
    this.el.style.flex = "1 1 auto";
    this.el.style.minHeight = "0";

    window.addEventListener("resize", () => {
      for (const [id, win] of this.floatWins) {
        win.reclamp();
        const r = win.rect;
        if (r) this.layout.floats[id] = r;
      }
    });
  }

  register(panel: Panel): void {
    this.panels.set(panel.id, panel);
  }

  /** Default arrangement, used when nothing is stored. */
  setDefault(groups: string[][]): void {
    const stored = this.load();
    this.layout = stored ?? {
      groups: groups
        .map((ids) => ids.filter((id) => this.panels.has(id)))
        .filter((ids) => ids.length > 0)
        .map((ids) => ({ panelIds: ids, activeId: ids[0]!, collapsed: false, weight: 1 })),
      floats: {},
      closed: [],
      closedNear: {},
    };
    this.layout.floats ??= {};
    this.layout.closed ??= [];
    this.layout.closedNear ??= {};
    this.prune();
    this.render();
  }

  /** Drop panels that no longer exist and re-add ones never placed. */
  private prune(): void {
    const seen = new Set<string>();
    for (const id of Object.keys(this.layout.floats)) {
      if (this.panels.has(id)) seen.add(id);
      else delete this.layout.floats[id];
    }
    this.layout.closed = this.layout.closed.filter((id) => this.panels.has(id) && !seen.has(id));
    for (const id of this.layout.closed) seen.add(id);

    for (const g of this.layout.groups) {
      g.panelIds = g.panelIds.filter((id) => this.panels.has(id) && !seen.has(id));
      for (const id of g.panelIds) seen.add(id);
      if (!g.panelIds.includes(g.activeId)) g.activeId = g.panelIds[0] ?? "";
    }
    this.layout.groups = this.layout.groups.filter((g) => g.panelIds.length > 0);
    for (const id of this.panels.keys()) {
      if (!seen.has(id)) {
        this.layout.groups.push({ panelIds: [id], activeId: id, collapsed: false, weight: 1 });
      }
    }
  }

  /** Does this dock know about the panel at all? */
  has(panelId: string): boolean { return this.panels.has(panelId); }

  focus(panelId: string): void {
    if (this.layout.closed.includes(panelId)) { this.open(panelId); return; }
    const win = this.floatWins.get(panelId);
    if (win) { win.raise(); return; }
    const g = this.layout.groups.find((x) => x.panelIds.includes(panelId));
    if (!g) return;
    g.activeId = panelId;
    g.collapsed = false;
    this.save();
    this.render();
  }

  isVisible(panelId: string): boolean {
    if (this.floatWins.has(panelId)) return true;
    const g = this.layout.groups.find((x) => x.panelIds.includes(panelId));
    return !!g && !g.collapsed && g.activeId === panelId;
  }

  /** Open means "somewhere on screen": docked or floating, not closed. */
  isOpen(panelId: string): boolean {
    return this.panels.has(panelId) && !this.layout.closed.includes(panelId);
  }

  isFloating(panelId: string): boolean { return panelId in this.layout.floats; }

  open(panelId: string): void {
    if (!this.panels.has(panelId) || this.isOpen(panelId)) return;
    this.layout.closed = this.layout.closed.filter((id) => id !== panelId);
    const near = this.layout.closedNear?.[panelId];
    const home = near ? this.layout.groups.find((g) => g.panelIds.includes(near)) : undefined;
    if (home) {
      home.panelIds.push(panelId);
      home.activeId = panelId;
      home.collapsed = false;
    } else {
      this.layout.groups.push({ panelIds: [panelId], activeId: panelId, collapsed: false, weight: 1 });
    }
    delete this.layout.closedNear?.[panelId];
    this.save();
    this.render();
  }

  close(panelId: string): void {
    if (!this.isOpen(panelId)) return;
    const group = this.layout.groups.find((g) => g.panelIds.includes(panelId));
    const sibling = group?.panelIds.find((id) => id !== panelId);
    this.layout.closedNear ??= {};
    if (sibling) this.layout.closedNear[panelId] = sibling;
    else delete this.layout.closedNear[panelId];
    this.detachFromGroups(panelId);
    delete this.layout.floats[panelId];
    this.layout.closed.push(panelId);
    this.save();
    this.render();
  }

  /** Tear a panel out of the column into a window of its own. */
  float(panelId: string, rect?: FloatRect): void {
    if (!this.panels.has(panelId) || this.isFloating(panelId)) { this.focus(panelId); return; }
    this.detachFromGroups(panelId);
    this.layout.closed = this.layout.closed.filter((id) => id !== panelId);
    this.layout.floats[panelId] = clampRect(rect ?? defaultFloatRect(this.floatWins.size));
    this.save();
    this.render();
  }

  /** Put a floating panel back in the column. */
  dockPanel(panelId: string): void {
    if (!this.isFloating(panelId)) return;
    delete this.layout.floats[panelId];
    this.layout.groups.push({ panelIds: [panelId], activeId: panelId, collapsed: false, weight: 1 });
    this.save();
    this.render();
  }

  private detachFromGroups(panelId: string): void {
    for (const g of this.layout.groups) {
      g.panelIds = g.panelIds.filter((id) => id !== panelId);
      if (g.activeId === panelId) g.activeId = g.panelIds[0] ?? "";
    }
    this.layout.groups = this.layout.groups.filter((g) => g.panelIds.length > 0);
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  render(): void {
    clear(this.el);
    this.groupEls = [];

    this.layout.groups.forEach((group, gi) => {
      const groupEl = h("div", { class: "pgroup" });
      cls(groupEl, "collapsed", group.collapsed);
      cls(groupEl, "flex", !group.collapsed);
      groupEl.style.flex = group.collapsed ? "0 0 auto" : `${group.weight} 1 0`;

      // Tab strip
      const tabs = h("div", { class: "ptabs" });
      for (const pid of group.panelIds) {
        const panel = this.panels.get(pid);
        if (!panel) continue;
        const active = pid === group.activeId && !group.collapsed;
        const tab = h("div", { class: `ptab${active ? " active" : ""}`, title: panel.title }, panel.title);
        this.wireTab(tab, group, gi, pid);
        tabs.appendChild(tab);
      }
      const menuBtn = h("button", { class: "pmenu iconbtn", title: "Panel menu" });
      menuBtn.appendChild(icon("hamburger", 12));
      on(menuBtn, "click", (e) => {
        e.stopPropagation();
        this.showGroupMenu(menuBtn, group);
      });
      tabs.appendChild(menuBtn);
      groupEl.appendChild(tabs);

      // Body + footer of the active panel
      if (!group.collapsed) {
        const panel = this.panels.get(group.activeId);
        if (panel) {
          const body = h("div", { class: "pbody" });
          body.appendChild(panel.el);
          groupEl.appendChild(body);
          if (panel.footer) groupEl.appendChild(panel.footer);
          panel.onShow?.();
        }
      }

      this.el.appendChild(groupEl);
      this.groupEls.push(groupEl);

      // Splitter between this group and the next expanded one
      const nextExpanded = this.layout.groups.slice(gi + 1).findIndex((g) => !g.collapsed);
      if (!group.collapsed && nextExpanded >= 0) {
        this.el.appendChild(this.makeSplitter(gi, gi + 1 + nextExpanded));
      }
    });

    this.renderFloats();
    this.onLayoutChange?.();
  }

  /**
   * Float windows are created and destroyed, never re-created in place: a
   * panel's element is moved into the window and back, and moving an iframe
   * reloads it, so the fewer moves the better.
   */
  private renderFloats(): void {
    for (const [id, win] of this.floatWins) {
      if (!(id in this.layout.floats)) { win.dispose(); this.floatWins.delete(id); }
    }
    for (const [id, rect] of Object.entries(this.layout.floats)) {
      const panel = this.panels.get(id);
      if (!panel || this.floatWins.has(id)) continue;
      const win = new FloatWindow({
        title: panel.title,
        rect,
        onChange: (r) => { this.layout.floats[id] = r; this.save(); },
        onDock: () => this.dockPanel(id),
        onClose: () => this.close(id),
      });
      const body = h("div", { class: "pbody" });
      body.appendChild(panel.el);
      win.body.appendChild(body);
      if (panel.footer) win.body.appendChild(panel.footer);
      this.floatWins.set(id, win);
      panel.onShow?.();
    }
  }

  private makeSplitter(aIdx: number, bIdx: number): HTMLElement {
    const sp = h("div", { class: `splitter ${this.orientation === "vertical" ? "h" : "v"}` });
    let startA = 1, startB = 1, totalPx = 1;
    drag(sp, {
      cursor: this.orientation === "vertical" ? "ns-resize" : "ew-resize",
      onStart: () => {
        const a = this.layout.groups[aIdx]!, b = this.layout.groups[bIdx]!;
        startA = a.weight; startB = b.weight;
        const ea = this.groupEls[aIdx]!, eb = this.groupEls[bIdx]!;
        totalPx = this.orientation === "vertical"
          ? ea.offsetHeight + eb.offsetHeight
          : ea.offsetWidth + eb.offsetWidth;
        sp.classList.add("dragging");
      },
      onMove: (dx, dy) => {
        const d = this.orientation === "vertical" ? dy : dx;
        if (totalPx <= 0) return;
        const total = startA + startB;
        const ratio = Math.max(0.08, Math.min(0.92, (startA / total) + d / totalPx));
        this.layout.groups[aIdx]!.weight = total * ratio;
        this.layout.groups[bIdx]!.weight = total * (1 - ratio);
        this.groupEls[aIdx]!.style.flex = `${this.layout.groups[aIdx]!.weight} 1 0`;
        this.groupEls[bIdx]!.style.flex = `${this.layout.groups[bIdx]!.weight} 1 0`;
      },
      onEnd: () => { sp.classList.remove("dragging"); this.save(); },
    });
    return sp;
  }

  // ── Tab interaction: activate, collapse, drag between groups ───────────

  private wireTab(tab: HTMLElement, group: GroupState, groupIndex: number, panelId: string): void {
    on(tab, "click", () => {
      if (group.activeId === panelId && !group.collapsed) return;
      group.activeId = panelId;
      group.collapsed = false;
      this.save();
      this.render();
    });

    on(tab, "dblclick", () => {
      group.collapsed = !group.collapsed;
      this.save();
      this.render();
    });

    let dragging = false;
    let indicator: HTMLElement | null = null;

    drag(tab, {
      cursor: "grabbing",
      onMove: (dx, dy) => {
        if (!dragging && Math.hypot(dx, dy) < 5) return;
        if (!dragging) { dragging = true; tab.classList.add("dragging"); }
        const target = this.hitGroup(lastPointer.x, lastPointer.y);
        indicator?.remove();
        indicator = null;
        if (target) {
          indicator = h("div", { class: "drop-line" });
          const el = this.groupEls[target.index];
          if (el) {
            if (target.edge === "before") this.el.insertBefore(indicator, el);
            else this.el.insertBefore(indicator, el.nextSibling);
          }
        }
      },
      onEnd: (_ev, cancelled) => {
        tab.classList.remove("dragging");
        indicator?.remove();
        indicator = null;
        if (!dragging || cancelled) { dragging = false; return; }
        dragging = false;

        const target = this.hitGroup(lastPointer.x, lastPointer.y);
        if (!target) return;

        // Remove from the source group
        group.panelIds = group.panelIds.filter((id) => id !== panelId);
        if (group.activeId === panelId) group.activeId = group.panelIds[0] ?? "";

        if (target.edge === "into") {
          const dest = this.layout.groups[target.index];
          if (dest && dest !== group) {
            dest.panelIds.push(panelId);
            dest.activeId = panelId;
            dest.collapsed = false;
          } else {
            group.panelIds.push(panelId);
            group.activeId = panelId;
          }
        } else {
          const at = target.edge === "before" ? target.index : target.index + 1;
          const insertAt = at > groupIndex ? at : at;
          this.layout.groups.splice(insertAt, 0, {
            panelIds: [panelId], activeId: panelId, collapsed: false, weight: 1,
          });
        }

        this.layout.groups = this.layout.groups.filter((g) => g.panelIds.length > 0);
        this.save();
        this.render();
      },
    });
  }

  /** Which group (and which edge of it) is under the pointer. */
  private hitGroup(x: number, y: number): { index: number; edge: "before" | "into" | "after" } | null {
    for (let i = 0; i < this.groupEls.length; i++) {
      const r = this.groupEls[i]!.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const edgeBand = Math.min(28, r.height * 0.28);
      if (y < r.top + edgeBand) return { index: i, edge: "before" };
      if (y > r.bottom - edgeBand) return { index: i, edge: "after" };
      return { index: i, edge: "into" };
    }
    // Past the end of the column
    const last = this.groupEls[this.groupEls.length - 1];
    if (last) {
      const r = last.getBoundingClientRect();
      if (y > r.bottom && x >= r.left && x <= r.right) {
        return { index: this.groupEls.length - 1, edge: "after" };
      }
    }
    return null;
  }

  private showGroupMenu(anchor: HTMLElement, group: GroupState): void {
    const panel = this.panels.get(group.activeId);
    const items: Array<{ label: string; run: () => void } | "-"> = [];
    if (panel?.menu) items.push(...panel.menu(), "-");
    items.push({
      label: group.collapsed ? "Expand Group" : "Collapse Group",
      run: () => { group.collapsed = !group.collapsed; this.save(); this.render(); },
    });
    if (panel) {
      items.push(
        { label: `Float ${panel.title}`, run: () => this.float(panel.id) },
        { label: `Close ${panel.title}`, run: () => this.close(panel.id) },
      );
    }
    showMenu(anchor, items);
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private save(): void {
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.layout)); } catch { /* private mode */ }
  }

  private load(): DockLayout | null {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as DockLayout;
      return Array.isArray(parsed?.groups) ? parsed : null;
    } catch { return null; }
  }

  resetLayout(): void {
    for (const win of this.floatWins.values()) win.dispose();
    this.floatWins.clear();
    try { localStorage.removeItem(this.storageKey); } catch { /* ignore */ }
  }
}

/** Cascade successive float windows so they do not land on top of each other. */
function defaultFloatRect(index: number): FloatRect {
  const step = 26 * (index % 6);
  return { x: Math.max(24, innerWidth - 520 + step), y: 90 + step, w: 420, h: 340 };
}

/* Track the pointer globally: `drag` gives deltas, and hit-testing wants
   absolute coordinates. */
const lastPointer = { x: 0, y: 0 };
window.addEventListener("pointermove", (e) => { lastPointer.x = e.clientX; lastPointer.y = e.clientY; }, true);

/* ── A minimal popup menu, shared by panel menus and the menu bar ───────── */

let openMenu: HTMLElement | null = null;
let detachOutside: (() => void) | null = null;
/** Submenus stack on top of the menu that opened them. */
let openSub: HTMLElement | null = null;

export interface MenuEntry {
  label: string;
  run?: () => void;
  enabled?: boolean;
  checked?: boolean;
  accel?: string;
  /** Command id whose current key is shown when `accel` is not given. */
  command?: string;
  /** A submenu: the row opens it instead of doing anything itself. */
  items?: Array<MenuEntry | "-">;
}

function accelText(it: MenuEntry): string | undefined {
  return it.accel ?? accelOf(it.command);
}

export function showMenu(
  anchor: HTMLElement,
  items: Array<MenuEntry | "-">,
  align: "below" | "right" = "below",
): void {
  closeMenu();
  const rect = anchor.getBoundingClientRect();
  const menu = h("div", { class: "popmenu" });

  // A context menu opens on `contextmenu`, which fires BETWEEN the right
  // button's pointerdown and its pointerup. That stray release then lands on
  // whatever row happens to be under the cursor and runs it — the menu
  // appears to close instantly having picked something by itself. So a row
  // only fires for a release that belongs to a press made inside the menu.
  let pressed = false;

  for (const it of items) {
    if (it === "-") { menu.appendChild(h("div", { class: "popsep" })); continue; }
    const row = h("div", { class: `popitem${it.enabled === false ? " disabled" : ""}${it.items ? " hassub" : ""}` },
      h("span", { class: "chk" }, it.checked ? "✓" : ""),
      h("span", { class: "lbl" }, it.label),
      accelText(it) ? h("span", { class: "accel" }, accelText(it)!) : null,
      it.items ? h("span", { class: "accel" }, "▸") : null,
    );

    // A submenu opens on hover and stays until the pointer leaves both it and
    // its row — the parent menu is NOT dismissed, since the press that picks
    // a child lands outside the parent and would otherwise close everything
    // before the row could act.
    if (it.items && it.enabled !== false) {
      const sub = it.items;
      on(row, "pointerenter", () => openSubmenu(row, sub));
      on(row, "pointerup", (e) => { e.stopPropagation(); openSubmenu(row, sub); });
      on(row, "pointerdown", (e) => { pressed = true; e.stopPropagation(); });
      menu.appendChild(row);
      continue;
    }
    if (!it.items) on(row, "pointerenter", () => closeSubmenu());

    if (it.enabled !== false && it.run) {
      // Fire on pointerUP, not click.
      //
      // The dismiss-on-outside-click listener runs at pointerDOWN. Removing
      // the menu there means the row is gone before `click` would be
      // dispatched, and the browser then retargets the click to a common
      // ancestor — so the handler never ran and every menu item silently did
      // nothing. Acting on pointerup, and refusing to dismiss on presses
      // inside the menu, keeps the two from racing.
      on(row, "pointerup", (e) => {
        e.stopPropagation();
        if (!pressed) return;                 // the press that opened the menu
        const run = it.run!;
        closeMenu();
        run();
      });
      on(row, "pointerdown", (e) => { pressed = true; e.stopPropagation(); });
    }
    menu.appendChild(row);
  }

  menu.style.left = `${align === "below" ? rect.left : rect.right}px`;
  menu.style.top = `${align === "below" ? rect.bottom : rect.top}px`;
  document.body.appendChild(menu);

  // Keep it on screen.
  const mr = menu.getBoundingClientRect();
  if (mr.right > innerWidth - 4) menu.style.left = `${Math.max(4, innerWidth - mr.width - 4)}px`;
  if (mr.bottom > innerHeight - 4) menu.style.top = `${Math.max(4, innerHeight - mr.height - 4)}px`;

  openMenu = menu;

  const onDown = (e: Event) => {
    const t = e.target as Node;
    if (openMenu?.contains(t) || openSub?.contains(t)) return;
    closeMenu();
  };
  const onKey = (e: Event) => {
    if ((e as KeyboardEvent).key === "Escape") closeMenu();
  };
  // Deferred by a frame so the press that opened the menu does not close it.
  const arm = setTimeout(() => {
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
  }, 0);

  detachOutside = () => {
    clearTimeout(arm);
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
  };
}

/** A zero-size element at a screen point, so `showMenu` can open where the
 *  pointer is rather than under a button. */
export function menuAnchor(x: number, y: number): HTMLElement {
  const anchor = h("div");
  anchor.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:0;height:0`;
  document.body.appendChild(anchor);
  setTimeout(() => anchor.remove(), 0);
  return anchor;
}

export function closeMenu(): void {
  detachOutside?.();
  detachOutside = null;
  closeSubmenu();
  openMenu?.remove();
  openMenu = null;
}

function closeSubmenu(): void {
  openSub?.remove();
  openSub = null;
}

/**
 * The second level. Built by the same code as the top level minus the
 * dismissal wiring, which stays with the parent: one outside-press listener
 * closes both, and a row in here fires on `pointerup` for the same reason
 * every other row does.
 */
function openSubmenu(row: HTMLElement, items: Array<MenuEntry | "-">): void {
  if (openSub && openSub.dataset.owner === rowKey(row)) return;
  closeSubmenu();

  const menu = h("div", { class: "popmenu" });
  menu.dataset.owner = rowKey(row);
  let pressed = false;

  for (const it of items) {
    if (it === "-") { menu.appendChild(h("div", { class: "popsep" })); continue; }
    const r = h("div", { class: `popitem${it.enabled === false ? " disabled" : ""}` },
      h("span", { class: "chk" }, it.checked ? "✓" : ""),
      h("span", { class: "lbl" }, it.label),
      accelText(it) ? h("span", { class: "accel" }, accelText(it)!) : null,
    );
    if (it.enabled !== false && it.run) {
      const run = it.run;
      on(r, "pointerdown", (e) => { pressed = true; e.stopPropagation(); });
      on(r, "pointerup", (e) => {
        e.stopPropagation();
        if (!pressed) return;
        closeMenu();
        run();
      });
    }
    menu.appendChild(r);
  }

  const rect = row.getBoundingClientRect();
  menu.style.left = `${rect.right - 2}px`;
  menu.style.top = `${rect.top - 4}px`;
  document.body.appendChild(menu);

  const mr = menu.getBoundingClientRect();
  if (mr.right > innerWidth - 4) menu.style.left = `${Math.max(4, rect.left - mr.width + 2)}px`;
  if (mr.bottom > innerHeight - 4) menu.style.top = `${Math.max(4, innerHeight - mr.height - 4)}px`;

  openSub = menu;
}

let rowSeq = 0;
const rowKeys = new WeakMap<HTMLElement, string>();
function rowKey(row: HTMLElement): string {
  let k = rowKeys.get(row);
  if (!k) { k = `sub${++rowSeq}`; rowKeys.set(row, k); }
  return k;
}
