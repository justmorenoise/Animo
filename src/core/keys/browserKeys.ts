import { parseChord, type Platform } from "./chord";

/**
 * Chords the browser or the operating system already means something by.
 *
 * `reserved`: the page never sees the key, or sees it after the browser has
 * already acted — Chromium's `IsReservedCommandOrKey` (new/close tab and
 * window, reopen tab, next/previous tab) plus what macOS and Windows take
 * before the browser does. Binding one would produce a shortcut that cannot
 * work, so the editor refuses them.
 *
 * `browser`: delivered to the page, and `preventDefault` stops the browser's
 * own action, but the user loses something familiar (Reload, Find, page
 * zoom). Allowed, with a warning saying what it replaces.
 */
export interface BrowserConflict {
  level: "reserved" | "browser";
  what: string;
}

type Table = Record<string, string>;

const MAC_RESERVED: Table = {
  "Mod+N": "New window",
  "Mod+Shift+N": "New incognito window",
  "Mod+T": "New tab",
  "Mod+Shift+T": "Reopen closed tab",
  "Mod+W": "Close tab",
  "Mod+Shift+W": "Close window",
  "Mod+Q": "Quit the browser",
  "Mod+Shift+[": "Previous tab",
  "Mod+Shift+]": "Next tab",
  "Mod+Alt+ArrowLeft": "Previous tab",
  "Mod+Alt+ArrowRight": "Next tab",
  "Ctrl+Tab": "Next tab",
  "Ctrl+Shift+Tab": "Previous tab",
  "Ctrl+PageUp": "Previous tab",
  "Ctrl+PageDown": "Next tab",
  "Mod+H": "Hide the application (macOS)",
  "Mod+Alt+H": "Hide other applications (macOS)",
  "Mod+M": "Minimise window (macOS)",
  "Mod+`": "Cycle windows (macOS)",
  "Mod+Tab": "Switch application (macOS)",
  "Mod+Shift+Tab": "Switch application (macOS)",
  "Mod+Space": "Spotlight (macOS)",
  "Mod+Alt+Space": "Finder search (macOS)",
  "Ctrl+Space": "Input source (macOS)",
  "Mod+Ctrl+Space": "Emoji & symbols (macOS)",
  "Mod+Shift+3": "Screenshot (macOS)",
  "Mod+Shift+4": "Screenshot (macOS)",
  "Mod+Shift+5": "Screenshot (macOS)",
  "Mod+Alt+Escape": "Force quit (macOS)",
  "Mod+Shift+Q": "Log out (macOS)",
  "Mod+Ctrl+Q": "Lock screen (macOS)",
  "Ctrl+ArrowLeft": "Previous space (macOS)",
  "Ctrl+ArrowRight": "Next space (macOS)",
  "Ctrl+ArrowUp": "Mission Control (macOS)",
  "Ctrl+ArrowDown": "Application windows (macOS)",
  "F11": "Show desktop (macOS)",
};

const MAC_BROWSER: Table = {
  "Mod+R": "Reload",
  "Mod+Shift+R": "Hard reload",
  "Mod+S": "Save page",
  "Mod+O": "Open file",
  "Mod+P": "Print",
  "Mod+F": "Find",
  "Mod+G": "Find next",
  "Mod+Shift+G": "Find previous",
  "Mod+E": "Find selection",
  "Mod+D": "Bookmark page",
  "Mod+Shift+D": "Bookmark all tabs",
  "Mod+L": "Address bar",
  "Mod+Y": "History",
  "Mod+Shift+J": "Downloads",
  "Mod+Alt+U": "View source",
  "Mod+Alt+I": "Developer tools",
  "Mod+Alt+J": "JavaScript console",
  "Mod+Alt+C": "Inspect element",
  "Mod+Shift+C": "Inspect element",
  "Mod+Shift+A": "Search tabs",
  "Mod+Shift+M": "Switch profile",
  "Mod+Shift+B": "Bookmarks bar",
  "Mod+Alt+B": "Bookmark manager",
  "Mod+Shift+Delete": "Clear browsing data",
  "Mod+,": "Browser settings",
  "Mod+0": "Reset page zoom",
  "Mod+=": "Page zoom in",
  "Mod+Plus": "Page zoom in",
  "Mod+-": "Page zoom out",
  "Mod+[": "Back",
  "Mod+]": "Forward",
  "Mod+ArrowLeft": "Back",
  "Mod+ArrowRight": "Forward",
  "Mod+Ctrl+F": "Full screen",
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`Mod+${i + 1}`, "Switch to tab"])),
};

const OTHER_RESERVED: Table = {
  "Mod+N": "New window",
  "Mod+Shift+N": "New incognito window",
  "Mod+T": "New tab",
  "Mod+Shift+T": "Reopen closed tab",
  "Mod+W": "Close tab",
  "Mod+F4": "Close tab",
  "Mod+Shift+W": "Close window",
  "Mod+Tab": "Next tab",
  "Mod+Shift+Tab": "Previous tab",
  "Mod+PageUp": "Previous tab",
  "Mod+PageDown": "Next tab",
  "Alt+F4": "Close window",
  "Alt+Tab": "Switch window",
  "Alt+Shift+Tab": "Switch window",
  "Mod+Alt+Delete": "System menu",
  "Mod+Shift+Escape": "Task manager",
  "Alt+Space": "Window menu",
};

const OTHER_BROWSER: Table = {
  "Mod+R": "Reload",
  "F5": "Reload",
  "Mod+F5": "Hard reload",
  "Shift+F5": "Hard reload",
  "Mod+Shift+R": "Hard reload",
  "Mod+S": "Save page",
  "Mod+O": "Open file",
  "Mod+P": "Print",
  "Mod+F": "Find",
  "F3": "Find next",
  "Shift+F3": "Find previous",
  "Mod+G": "Find next",
  "Mod+Shift+G": "Find previous",
  "Mod+D": "Bookmark page",
  "Mod+Shift+D": "Bookmark all tabs",
  "Mod+L": "Address bar",
  "Alt+D": "Address bar",
  "F6": "Focus address bar",
  "Shift+F6": "Focus previous pane",
  "F7": "Caret browsing",
  "Mod+E": "Search",
  "Mod+K": "Search",
  "Mod+H": "History",
  "Mod+J": "Downloads",
  "Mod+U": "View source",
  "Mod+Shift+I": "Developer tools",
  "Mod+Shift+J": "JavaScript console",
  "Mod+Shift+C": "Inspect element",
  "F12": "Developer tools",
  "Mod+Shift+A": "Search tabs",
  "Mod+Shift+B": "Bookmarks bar",
  "Mod+Shift+O": "Bookmark manager",
  "Mod+Shift+Delete": "Clear browsing data",
  "Mod+0": "Reset page zoom",
  "Mod+=": "Page zoom in",
  "Mod+Plus": "Page zoom in",
  "Mod+-": "Page zoom out",
  "Alt+ArrowLeft": "Back",
  "Alt+ArrowRight": "Forward",
  "Alt+Home": "Home page",
  "Alt+F": "Browser menu",
  "Alt+E": "Browser menu",
  "F1": "Help",
  "F10": "Browser menu",
  "F11": "Full screen",
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`Mod+${i + 1}`, "Switch to tab"])),
};

export function browserConflict(chord: string, platform: Platform): BrowserConflict | null {
  const c = parseChord(chord, platform);
  if (!c) return null;
  const reserved = platform === "mac" ? MAC_RESERVED : OTHER_RESERVED;
  const browser = platform === "mac" ? MAC_BROWSER : OTHER_BROWSER;
  if (reserved[c]) return { level: "reserved", what: reserved[c]! };
  if (browser[c]) return { level: "browser", what: browser[c]! };
  return null;
}
