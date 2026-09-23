import { describe, it, expect } from "vitest";
import {
  chordCandidates, chordFromEvent, parseChord, formatChord, type KeyLike, type Platform,
} from "@/core/keys/chord";
import { COMMANDS } from "@/core/keys/commands";
import { browserConflict } from "@/core/keys/browserKeys";
import {
  resolveKeymap, assignChord, removeChord, resetCommand, sanitizeOverrides,
  serializeKeymap, parseKeymapFile,
} from "@/core/keys/keymap";
import { mergePrefs } from "@/core/prefs/prefs";

const ev = (key: string, code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
});

describe("chordFromEvent", () => {
  it("reads ⌥⌘C on a Mac from the physical key, not the composed glyph", () => {
    expect(chordFromEvent(ev("ç", "KeyC", { metaKey: true, altKey: true }), "mac")).toBe("Mod+Alt+C");
  });

  it("keeps Ctrl apart from ⌘ on a Mac and folds it into Mod elsewhere", () => {
    expect(chordFromEvent(ev("s", "KeyS", { ctrlKey: true }), "mac")).toBe("Ctrl+S");
    expect(chordFromEvent(ev("s", "KeyS", { metaKey: true }), "mac")).toBe("Mod+S");
    expect(chordFromEvent(ev("s", "KeyS", { ctrlKey: true }), "other")).toBe("Mod+S");
  });

  it("returns nothing for a bare modifier or the Windows key", () => {
    expect(chordFromEvent(ev("Shift", "ShiftLeft", { shiftKey: true }), "mac")).toBeNull();
    expect(chordFromEvent(ev("e", "KeyE", { metaKey: true }), "other")).toBeNull();
  });

  it("folds a shifted glyph back onto its key, so ? is Shift+/", () => {
    expect(chordFromEvent(ev("?", "Slash", { shiftKey: true }), "mac")).toBe("Shift+/");
    // Italian layout: ? lives on the ' key.
    expect(chordFromEvent(ev("?", "Minus", { shiftKey: true }), "mac")).toBe("Shift+/");
    expect(chordFromEvent(ev(":", "Semicolon", { shiftKey: true, metaKey: true }), "mac")).toBe("Mod+Shift+;");
  });

  it("follows the character before the physical key", () => {
    // Italian: + is its own key, where US has ].
    const c = chordCandidates(ev("+", "BracketRight", { metaKey: true }), "mac");
    expect(c).toEqual(["Mod+Plus", "Mod+]"]);
    expect(chordFromEvent(ev(" ", "Space"), "other")).toBe("Space");
    expect(chordFromEvent(ev("F5", "F5", { shiftKey: true }), "other")).toBe("Shift+F5");
  });
});

describe("parseChord / formatChord", () => {
  it("normalises modifier order and spelling", () => {
    expect(parseChord("shift+cmd+s")).toBe("Mod+Shift+S");
    expect(parseChord("Mod++")).toBe("Mod+Plus");
    expect(parseChord("Ctrl+S", "other")).toBe("Mod+S");
    expect(parseChord("Ctrl+S", "mac")).toBe("Ctrl+S");
  });

  it("rejects what is not a chord", () => {
    for (const bad of ["", "Mod", "Mod+", "Hyper+S", "Mod+Mod+S", "Mod+abc"]) {
      expect(parseChord(bad)).toBeNull();
    }
  });

  it("formats per platform", () => {
    expect(formatChord("Mod+Alt+Shift+V", "mac")).toBe("⌥⇧⌘V");
    expect(formatChord("Mod+Alt+Shift+V", "other")).toBe("Ctrl+Alt+Shift+V");
    expect(formatChord("Backspace", "mac")).toBe("⌫");
    expect(formatChord("Mod+Plus", "other")).toBe("Ctrl+Plus");
  });

  it("round-trips every default chord", () => {
    for (const p of ["mac", "other"] as Platform[]) {
      for (const d of COMMANDS) {
        for (const k of d.keys) expect(parseChord(parseChord(k, p)!, p)).toBe(parseChord(k, p));
      }
    }
  });
});

describe("COMMANDS", () => {
  it("has unique ids", () => {
    const ids = COMMANDS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const p of ["mac", "other"] as Platform[]) {
    it(`has valid, unreserved, unshared defaults on ${p}`, () => {
      const seen = new Map<string, string>();
      for (const d of COMMANDS) {
        for (const k of d.keys) {
          const c = parseChord(k, p);
          expect(c, `${d.id} ${k}`).not.toBeNull();
          expect(browserConflict(c!, p)?.level, `${d.id} ${k}`).not.toBe("reserved");
          expect(seen.get(c!), `${d.id} ${k}`).toBeUndefined();
          seen.set(c!, d.id);
        }
      }
      expect(resolveKeymap({}, p).issues).toEqual([]);
    });
  }
});

describe("browserConflict", () => {
  it("separates what the page never receives from what it can override", () => {
    expect(browserConflict("Mod+W", "mac")?.level).toBe("reserved");
    expect(browserConflict("Mod+N", "other")?.level).toBe("reserved");
    expect(browserConflict("Mod+R", "mac")).toEqual({ level: "browser", what: "Reload" });
    expect(browserConflict("F5", "other")?.level).toBe("browser");
    expect(browserConflict("F5", "mac")).toBeNull();
    expect(browserConflict("Mod+Alt+N", "mac")).toBeNull();
  });
});

describe("keymap", () => {
  it("lets an override take a chord from a default", () => {
    const km = resolveKeymap({ "file.saveAs": ["Mod+D"] }, "mac");
    expect(km.byChord.get("Mod+D")).toBe("file.saveAs");
    expect(km.byCommand.get("edit.duplicate")).toEqual([]);
    expect(km.issues).toEqual([{ kind: "conflict", commandId: "edit.duplicate", chord: "Mod+D", owner: "file.saveAs" }]);
  });

  it("drops reserved chords", () => {
    const km = resolveKeymap({ "file.save": ["Mod+W", "Mod+S"] }, "mac");
    expect(km.byCommand.get("file.save")).toEqual(["Mod+S"]);
    expect(km.issues[0]).toMatchObject({ kind: "reserved", chord: "Mod+W" });
  });

  it("assignChord moves the chord and records the loss", () => {
    const o = assignChord({}, "file.saveAs", "Mod+D", "mac");
    expect(o["edit.duplicate"]).toEqual([]);
    expect(o["file.saveAs"]).toEqual(["Mod+Shift+S", "Mod+D"]);
    expect(resolveKeymap(o, "mac").issues).toEqual([]);
  });

  it("assignChord replaces a chord in place, and prunes back to the default", () => {
    let o = assignChord({}, "file.save", "Mod+Alt+S", "mac", "Mod+S");
    expect(o["file.save"]).toEqual(["Mod+Alt+S"]);
    o = assignChord(o, "file.save", "Mod+S", "mac", "Mod+Alt+S");
    expect(o).toEqual({});
  });

  it("removeChord and resetCommand", () => {
    let o = removeChord({}, "edit.delete", "Delete", "mac");
    expect(o["edit.delete"]).toEqual(["Backspace"]);
    o = resetCommand(o, "edit.delete");
    expect(o).toEqual({});
  });

  it("sanitizeOverrides keeps known ids and valid chords only", () => {
    expect(sanitizeOverrides({
      "file.save": ["cmd+s", "nonsense+", 4],
      "no.such": ["Mod+S"],
      "edit.copy": "Mod+C",
    })).toEqual({ "file.save": ["Mod+S"] });
    expect(sanitizeOverrides([1, 2])).toEqual({});
  });

  it("mergePrefs runs stored shortcuts through the same filter", () => {
    const p = mergePrefs({ keys: { "file.save": ["Mod+Alt+S"], bogus: ["Mod+B"] }, stage: { gridSize: 32 } });
    expect(p.keys).toEqual({ "file.save": ["Mod+Alt+S"] });
    expect(p.stage.gridSize).toBe(32);
    expect(mergePrefs({ keys: "nope" }).keys).toEqual({});
  });
});

describe("keymap files", () => {
  it("round-trips through save and load", () => {
    const o = assignChord({}, "file.saveAs", "Mod+D", "mac");
    const text = JSON.stringify(serializeKeymap(o, "mac"));
    const back = parseKeymapFile(text, "mac");
    expect("error" in back).toBe(false);
    if ("error" in back) return;
    expect(back.overrides).toEqual(o);
    expect(back.unknown).toEqual([]);
  });

  it("is portable across platforms through Mod", () => {
    const text = JSON.stringify(serializeKeymap({}, "mac"));
    const back = parseKeymapFile(text, "other");
    if ("error" in back) throw new Error(back.error);
    expect(back.overrides).toEqual({});
  });


  it("reports unknown commands, bad chords and reserved chords", () => {
    const back = parseKeymapFile(JSON.stringify({
      format: "animo-keymap", version: 1, platform: "mac",
      bindings: { "made.up": ["Mod+J"], "file.save": ["Mod+S", "Mod+W", "???+"] },
    }), "mac");
    if ("error" in back) throw new Error(back.error);
    expect(back.unknown).toEqual(["made.up"]);
    expect(back.reserved).toEqual(["file.save: Mod+W"]);
    expect(back.invalid).toEqual(["file.save: ???+"]);
    expect(back.overrides).toEqual({});
  });

  it("refuses what is not a keymap", () => {
    expect(parseKeymapFile("{", "mac")).toHaveProperty("error");
    expect(parseKeymapFile("{\"format\":\"x\"}", "mac")).toHaveProperty("error");
  });
});
