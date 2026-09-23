/**
 * Key chords: the one string format every shortcut is stored, compared and
 * displayed through.
 *
 * Canonical form is `Mod+Ctrl+Alt+Shift+Key`, modifiers in that order and
 * only the ones held. `Mod` is ⌘ on a Mac and Ctrl everywhere else, so a
 * keymap file written on one platform means the same thing on the other.
 * `Ctrl` exists only on a Mac, where it is a separate key from ⌘; elsewhere it
 * folds into `Mod`.
 *
 * Pure and DOM-free: an event is read through `KeyLike`, the four flags plus
 * `key` and `code`, so the normalisation can be tested in Node.
 */

export type Platform = "mac" | "other";

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

const NAMED = new Set([
  "Enter", "Escape", "Space", "Tab", "Backspace", "Delete", "Insert",
  "Home", "End", "PageUp", "PageDown",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
]);

/** `+` separates the parts of a chord, so the key itself is spelled out. */
const PLUS = "Plus";

/**
 * A shifted US glyph back to the key it is typed on. The browser reports the
 * glyph (`?`) with `shiftKey` set, so without this `Shift+/` and `Shift+?`
 * would be two chords for one keypress, and which of them a layout produces
 * would decide whether a default matches.
 */
const UNSHIFT: Record<string, string> = {
  "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6",
  "&": "7", "*": "8", "(": "9", ")": "0", "_": "-", "+": "=",
  "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/",
};

/** Physical key → the character it carries on a US layout. */
const CODE_PUNCT: Record<string, string> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
  NumpadAdd: PLUS, NumpadSubtract: "-", NumpadMultiply: "*", NumpadDivide: "/", NumpadDecimal: ".",
};

const MODIFIER_KEYS = new Set([
  "Meta", "Control", "Alt", "Shift", "CapsLock", "OS", "Fn", "FnLock",
  "AltGraph", "Hyper", "Super", "Dead", "Unidentified", "Process",
]);

function isKeyName(k: string): boolean {
  if (NAMED.has(k) || k === PLUS) return true;
  if (/^[A-Z0-9]$/.test(k)) return true;
  // One printable, non-space, non-letter character.
  return [...k].length === 1 && !/\s/.test(k) && k !== "+" && !/[a-z]/.test(k);
}

/** Validate and normalise a stored chord. Null when it is not one. */
export function parseChord(text: string, platform?: Platform): string | null {
  if (typeof text !== "string" || !text) return null;
  const parts = text.endsWith("++")
    ? [...text.slice(0, -2).split("+").filter(Boolean), PLUS]
    : text.split("+");
  if (parts.some((p) => p === "")) return null;
  let key = parts.pop()!;
  if (key.length === 1 && /[a-z]/.test(key)) key = key.toUpperCase();
  if (key === "+") key = PLUS;
  if (key === " ") key = "Space";
  if (!isKeyName(key)) return null;
  const mods = new Set<Modifier>();
  for (const p of parts) {
    const m = normaliseModifier(p);
    if (!m || mods.has(m)) return null;
    mods.add(m);
  }
  if (platform === "other" && mods.has("Ctrl")) { mods.delete("Ctrl"); mods.add("Mod"); }
  return compose(mods, key);
}

function normaliseModifier(p: string): Modifier | null {
  switch (p.toLowerCase()) {
    case "mod": case "cmd": case "meta": case "command": return "Mod";
    case "ctrl": case "control": return "Ctrl";
    case "alt": case "option": case "opt": return "Alt";
    case "shift": return "Shift";
    default: return null;
  }
}

function compose(mods: Set<Modifier>, key: string): string {
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join("+");
}

/**
 * Every chord an event can be read as, most specific first. The dispatcher
 * tries them in order; recording takes the first.
 *
 * The first reading follows the character the user sees, so ⌘Z is ⌘Z on
 * AZERTY and `+` on an Italian keyboard is its own key. The second follows the
 * physical key on a US layout, which rescues ⌥ on a Mac — there `key` is the
 * composed glyph (⌥C reports `ç`) — and keeps the US defaults reachable.
 */
export function chordCandidates(ev: KeyLike, platform: Platform): string[] {
  if (MODIFIER_KEYS.has(ev.key)) return [];
  const mods = new Set<Modifier>();
  if (platform === "mac") {
    if (ev.metaKey) mods.add("Mod");
    if (ev.ctrlKey) mods.add("Ctrl");
  } else {
    // The Windows key belongs to the OS.
    if (ev.metaKey) return [];
    if (ev.ctrlKey) mods.add("Mod");
  }
  if (ev.altKey) mods.add("Alt");
  if (ev.shiftKey) mods.add("Shift");

  const out: string[] = [];
  const push = (k: string | null) => {
    if (!k || !isKeyName(k)) return;
    const c = compose(mods, k);
    if (!out.includes(c)) out.push(c);
  };

  const fromCode = keyFromCode(ev.code);
  const composedByAlt = platform === "mac" && ev.altKey && /[^\x20-\x7e]/.test(ev.key);
  if (!composedByAlt) push(keyFromKey(ev.key, ev.shiftKey));
  push(fromCode);
  return out;
}

export function chordFromEvent(ev: KeyLike, platform: Platform): string | null {
  return chordCandidates(ev, platform)[0] ?? null;
}

function keyFromKey(key: string, shift: boolean): string | null {
  if (key === " " || key === "Spacebar") return "Space";
  if (key === "Esc") return "Escape";
  if (key === "Del") return "Delete";
  if (NAMED.has(key)) return key;
  if ([...key].length !== 1) return null;
  if (/[a-zA-Z]/.test(key)) return key.toUpperCase();
  if (/[0-9]/.test(key)) return key;
  if (shift && UNSHIFT[key]) return UNSHIFT[key]!;
  if (key === "+") return PLUS;
  return key;
}

function keyFromCode(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1]!;
  m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (m) return m[1]!;
  if (code === "Space") return "Space";
  if (code === "NumpadEnter") return "Enter";
  return CODE_PUNCT[code] ?? null;
}

const MAC_MOD_GLYPH: Record<Modifier, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Mod: "⌘" };
const MAC_ORDER: Modifier[] = ["Ctrl", "Alt", "Shift", "Mod"];

const MAC_KEY: Record<string, string> = {
  Enter: "↩", Escape: "⎋", Backspace: "⌫", Delete: "⌦", Tab: "⇥", Space: "Space",
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
  PageUp: "⇞", PageDown: "⇟", Home: "↖", End: "↘", [PLUS]: "+",
};

const OTHER_KEY: Record<string, string> = {
  Escape: "Esc", Delete: "Del", PageUp: "PgUp", PageDown: "PgDn",
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", [PLUS]: "Plus",
};

/** `⇧⌘S` on a Mac, `Ctrl+Shift+S` elsewhere — Apple's modifier order there. */
export function formatChord(chord: string, platform: Platform): string {
  const parsed = parseChord(chord, platform);
  if (!parsed) return chord;
  const parts = parsed.split("+");
  const key = parts.pop()!;
  const mods = new Set(parts as Modifier[]);
  if (platform === "mac") {
    return MAC_ORDER.filter((m) => mods.has(m)).map((m) => MAC_MOD_GLYPH[m]).join("")
      + (MAC_KEY[key] ?? key);
  }
  const names: Record<Modifier, string> = { Mod: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" };
  return [...MODIFIERS.filter((m) => mods.has(m)).map((m) => names[m]), OTHER_KEY[key] ?? key].join("+");
}

export function detectPlatform(platformString: string): Platform {
  return /mac|iphone|ipad|ipod/i.test(platformString) ? "mac" : "other";
}

/** A bare modifier, for the gesture list ("⌘ + wheel"). */
export function formatModifier(name: string, platform: Platform): string {
  const m = normaliseModifier(name);
  if (!m) return formatChord(name, platform);
  if (platform === "mac") return MAC_MOD_GLYPH[m];
  return m === "Mod" || m === "Ctrl" ? "Ctrl" : m;
}
