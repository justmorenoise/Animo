import { Modal } from "@/view/widgets/Modal";
import { notifyAccelChange, setAccelResolver } from "@/view/widgets/accel";
import { chordCandidates, detectPlatform, formatChord, type Platform } from "@/core/keys/chord";
import { COMMANDS_BY_ID } from "@/core/keys/commands";
import { type ResolvedKeymap, resolveKeymap } from "@/core/keys/keymap";
import type { Store } from "./Store";

export interface CommandHandler {
  /** Return `false` to leave the key to the browser (Enter with no symbol). */
  run(): unknown;
  enabled?(): boolean;
  checked?(): boolean;
}

/**
 * The live keymap and the one global `keydown` listener.
 *
 * Handlers are registered by id against `core/keys/commands.ts`; the chords
 * come from the defaults plus `Prefs.keys` and are re-resolved whenever the
 * preferences change, so a rebinding in the dialog takes effect on the next
 * keypress.
 */
export class Keymap {
  readonly platform: Platform;
  private handlers = new Map<string, CommandHandler>();
  private current: ResolvedKeymap;

  constructor(store: Store) {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    this.platform = detectPlatform(nav.userAgentData?.platform || navigator.platform || navigator.userAgent);
    this.current = resolveKeymap(store.prefs.value.keys, this.platform);
    let lastKeys = store.prefs.value.keys;
    store.prefs.subscribe((p) => {
      if (p.keys === lastKeys) return;
      lastKeys = p.keys;
      this.current = resolveKeymap(p.keys, this.platform);
      notifyAccelChange();
    });
    setAccelResolver((id) => this.accelFor(id));
  }

  get resolved(): ResolvedKeymap { return this.current; }

  register(id: string, handler: CommandHandler): void {
    if (!COMMANDS_BY_ID.has(id)) throw new Error(`Unknown command: ${id}`);
    this.handlers.set(id, handler);
  }

  handler(id: string): CommandHandler | undefined { return this.handlers.get(id); }

  enabled(id: string): boolean {
    const h = this.handlers.get(id);
    return !!h && (h.enabled?.() ?? true);
  }

  run(id: string): boolean {
    const h = this.handlers.get(id);
    if (!h || h.enabled?.() === false) return false;
    return h.run() !== false;
  }

  format(chord: string): string { return formatChord(chord, this.platform); }

  accelFor(id: string): string | undefined {
    const k = this.current.byCommand.get(id)?.[0];
    return k ? this.format(k) : undefined;
  }

  install(): void {
    window.addEventListener("keydown", (e) => {
      // A modal owns the keyboard while it is up — otherwise typing a grid size
      // also runs the tool letters behind it.
      if (Modal.isOpen()) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA"
        || t.tagName === "SELECT" || t.isContentEditable);

      for (const chord of chordCandidates(e, this.platform)) {
        const id = this.current.byChord.get(chord);
        if (!id) continue;
        const handler = this.handlers.get(id);
        if (!handler) return;
        if (typing && !COMMANDS_BY_ID.get(id)!.inText) return;
        if (handler.enabled?.() === false) {
          // A disabled ⌘D must still not bookmark the page; a disabled arrow
          // or Enter has no browser action worth blocking.
          if (/(^|\+)(Mod|Ctrl|Alt)\+/.test(chord) || /^F\d+$/.test(chord)) e.preventDefault();
          return;
        }
        if (handler.run() !== false) e.preventDefault();
        return;
      }
    });
  }
}
