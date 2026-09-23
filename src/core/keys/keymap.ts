import { parseChord, type Platform } from "./chord";
import { COMMANDS, COMMANDS_BY_ID } from "./commands";
import { browserConflict } from "./browserKeys";

/**
 * The effective keymap: defaults with the user's overrides on top.
 *
 * Only OVERRIDES are stored (`Prefs.keys`), one full chord list per command
 * the user changed, so a default that changes in a later build still reaches
 * every command nobody touched.
 */

export type Overrides = Record<string, string[]>;

export interface KeymapIssue {
  kind: "reserved" | "conflict";
  commandId: string;
  chord: string;
  /** For a conflict, the command that kept the chord. */
  owner?: string;
  what?: string;
}

export interface ResolvedKeymap {
  byCommand: Map<string, string[]>;
  byChord: Map<string, string>;
  issues: KeymapIssue[];
}

/** The chords a command asks for, before conflicts are settled. */
export function requestedKeys(overrides: Overrides, id: string, platform: Platform): string[] {
  const raw = overrides[id] ?? COMMANDS_BY_ID.get(id)?.keys ?? [];
  const out: string[] = [];
  for (const k of raw) {
    const c = parseChord(k, platform);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Reserved chords are dropped; a chord two commands ask for goes to the one
 * the user bound explicitly, then to the earlier one in `COMMANDS`. The UI
 * never produces such a clash (`assignChord` moves the chord), but a
 * hand-edited file or a new default can.
 */
export function resolveKeymap(overrides: Overrides, platform: Platform): ResolvedKeymap {
  const byCommand = new Map<string, string[]>(COMMANDS.map((d) => [d.id, []]));
  const byChord = new Map<string, string>();
  const issues: KeymapIssue[] = [];

  const ordered = [
    ...COMMANDS.filter((d) => d.id in overrides),
    ...COMMANDS.filter((d) => !(d.id in overrides)),
  ];
  for (const d of ordered) {
    for (const chord of requestedKeys(overrides, d.id, platform)) {
      const conflict = browserConflict(chord, platform);
      if (conflict?.level === "reserved") {
        issues.push({ kind: "reserved", commandId: d.id, chord, what: conflict.what });
        continue;
      }
      const owner = byChord.get(chord);
      if (owner) {
        issues.push({ kind: "conflict", commandId: d.id, chord, owner });
        continue;
      }
      byChord.set(chord, d.id);
      byCommand.get(d.id)!.push(chord);
    }
  }
  return { byCommand, byChord, issues };
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/** Drop overrides that say what the default already says. */
function prune(overrides: Overrides, platform: Platform): Overrides {
  const out: Overrides = {};
  for (const [id, keys] of Object.entries(overrides)) {
    const def = COMMANDS_BY_ID.get(id);
    if (!def) continue;
    const defaults = requestedKeys({}, id, platform);
    if (!sameKeys(keys, defaults)) out[id] = keys;
  }
  return out;
}

/**
 * Bind `chord` to `id`, replacing `replacing` when given. Whoever held the
 * chord loses it, and that loss is written as an override too — otherwise its
 * default would claim the chord straight back.
 */
export function assignChord(
  overrides: Overrides, id: string, chord: string, platform: Platform, replacing?: string,
): Overrides {
  const c = parseChord(chord, platform);
  if (!c || !COMMANDS_BY_ID.has(id)) return overrides;
  const next: Overrides = { ...overrides };
  const resolved = resolveKeymap(overrides, platform);
  const owner = resolved.byChord.get(c);
  if (owner && owner !== id) {
    next[owner] = resolved.byCommand.get(owner)!.filter((k) => k !== c);
  }
  const mine = resolved.byCommand.get(id)!.slice();
  const at = replacing ? mine.indexOf(replacing) : -1;
  if (mine.includes(c)) {
    if (at >= 0 && replacing !== c) mine.splice(at, 1);
  } else if (at >= 0) {
    mine[at] = c;
  } else {
    mine.push(c);
  }
  next[id] = mine;
  return prune(next, platform);
}

export function removeChord(overrides: Overrides, id: string, chord: string, platform: Platform): Overrides {
  const resolved = resolveKeymap(overrides, platform);
  const mine = (resolved.byCommand.get(id) ?? []).filter((k) => k !== chord);
  return prune({ ...overrides, [id]: mine }, platform);
}

export function resetCommand(overrides: Overrides, id: string): Overrides {
  const next = { ...overrides };
  delete next[id];
  return next;
}

/**
 * Keep what a stored blob can safely mean: known command ids, each an array
 * of chords that parse. Everything else is dropped entry by entry, the way
 * `mergePrefs` treats the rest of the preferences.
 */
export function sanitizeOverrides(raw: unknown): Overrides {
  const out: Overrides = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, keys] of Object.entries(raw as Record<string, unknown>)) {
    if (!COMMANDS_BY_ID.has(id) || !Array.isArray(keys)) continue;
    const list: string[] = [];
    for (const k of keys) {
      const c = typeof k === "string" ? parseChord(k) : null;
      if (c && !list.includes(c)) list.push(c);
    }
    out[id] = list;
  }
  return out;
}

export const KEYMAP_FORMAT = "animo-keymap";

export interface KeymapFile {
  format: typeof KEYMAP_FORMAT;
  version: 1;
  platform: Platform;
  bindings: Record<string, string[]>;
}

/** The whole effective map, not just the overrides: a file someone can read
 *  and hand to someone else without knowing what the defaults were. */
export function serializeKeymap(overrides: Overrides, platform: Platform): KeymapFile {
  const resolved = resolveKeymap(overrides, platform);
  const bindings: Record<string, string[]> = {};
  for (const d of COMMANDS) bindings[d.id] = resolved.byCommand.get(d.id)!;
  return { format: KEYMAP_FORMAT, version: 1, platform, bindings };
}

export interface KeymapLoadReport {
  overrides: Overrides;
  loaded: number;
  unknown: string[];
  invalid: string[];
  reserved: string[];
}

export function parseKeymapFile(text: string, platform: Platform): KeymapLoadReport | { error: string } {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { error: "The file is not valid JSON." }; }
  if (!data || typeof data !== "object") return { error: "The file is not a keymap." };
  const file = data as Partial<KeymapFile>;
  if (file.format !== KEYMAP_FORMAT) {
    return { error: "The file is not an Animo keymap." };
  }
  if (!file.bindings || typeof file.bindings !== "object") return { error: "The keymap has no bindings." };

  const report: KeymapLoadReport = { overrides: {}, loaded: 0, unknown: [], invalid: [], reserved: [] };
  for (const [id, keys] of Object.entries(file.bindings)) {
    if (!COMMANDS_BY_ID.has(id)) { report.unknown.push(id); continue; }
    if (!Array.isArray(keys)) { report.invalid.push(id); continue; }
    const list: string[] = [];
    for (const k of keys) {
      const chord = typeof k === "string" ? parseChord(k, platform) : null;
      if (!chord) { report.invalid.push(`${id}: ${String(k)}`); continue; }
      if (browserConflict(chord, platform)?.level === "reserved") {
        report.reserved.push(`${id}: ${chord}`);
        continue;
      }
      if (!list.includes(chord)) list.push(chord);
    }
    report.loaded += list.length;
    report.overrides[id] = list;
  }
  report.overrides = prune(report.overrides, platform);
  return report;
}
