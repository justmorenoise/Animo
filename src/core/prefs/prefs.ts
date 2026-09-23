/**
 * Application preferences: the parameters the editor itself runs on, as
 * opposed to anything the document carries.
 *
 * Pure and DOM-free so the merge — which is also the migration path for a
 * blob written by an older build — can be tested in Node. The live container
 * that reads and writes localStorage is `app/Prefs.ts`.
 *
 * Every default here is the value that used to be hardcoded at the point of
 * use, so an editor with no saved preferences looks and behaves exactly as it
 * did before this file existed.
 */

import { type Overrides, sanitizeOverrides } from "@/core/keys/keymap";
import { UI_FONT_SIZES, type UiFontSize } from "@/core/prefs/fonts";

export interface GeneralPrefs {
  autosave: boolean;
  autosaveSeconds: number;
  confirmDiscard: boolean;
  /** Refuse to re-parent a bone the IK solves (see `ikDrivenAmong`). */
  guardIkReparent: boolean;
  /** Ask before Delete removes library items and folders. */
  confirmLibraryDelete: boolean;
  /** Defaults for File ▸ New — not the current document. */
  newDocWidth: number;
  newDocHeight: number;
  newDocFps: number;
  newDocBackground: string;
}

export interface InterfacePrefs {
  accent: string;
  /** The two accents derived from it: the darker one behind a selected row,
   *  the brighter one on an editable number. They are settings of their own
   *  rather than something `applyTheme` computes, so a palette can be tuned by
   *  hand; the dialog's "Derive from accent" recomputes both. */
  accentRow: string;
  accentHot: string;
  accentBlue: string;
  setup: string;
  /** Warnings and the no-export badge: deliberately NOT the accent, since it
   *  has to read as a different kind of signal. */
  warn: string;
  fontSize: UiFontSize;
}

export interface StagePrefs {
  showGrid: boolean;
  gridSize: number;
  /** Cells between two major grid lines. */
  gridSubdivisions: number;
  gridColor: string;
  gridMajorColor: string;
  stageEdgeColor: string;
  pasteboard: string;
  showRulers: boolean;
  rulerBg: string;
  rulerTick: string;
  rulerText: string;
  showGuides: boolean;
  guideColor: string;
  /** Guides cannot be dragged, moved or deleted while this is on. */
  lockGuides: boolean;
}

export interface SnapPrefs {
  enabled: boolean;
  /** Distance in SCREEN pixels within which a snap takes hold. */
  tolerancePx: number;
  toGrid: boolean;
  toGuides: boolean;
  toObjects: boolean;
  toStage: boolean;
  toPixel: boolean;
  showLines: boolean;
  lineColor: string;
}

export interface GizmoPrefs {
  showBones: boolean;
  showGizmos: boolean;
  handleSize: number;
  select: string;
  marquee: string;
  marqueeEdge: string;
  pivot: string;
  axisX: string;
  axisY: string;
  bone: string;
  boneIk: string;
  ikTarget: string;
  ikLink: string;
}

export interface TimelinePrefs {
  frameWidth: number;
  /** The ONE playhead colour: the frame grid draws with it and `applyTheme`
   *  publishes it as `--playhead`. There used to be a second one under
   *  `interface`, which had its own swatch in the dialog and drove nothing —
   *  changing it looked like the setting was broken. */
  playhead: string;
  keyframe: string;
  tween: string;
  selected: string;
  /** Onion markers relative to the playhead while they are not anchored. */
  onionBefore: number;
  onionAfter: number;
  /** Opacity of the nearest ghost ("Starting opacity"). */
  onionOpacity: number;
  /** Fraction each further frame loses ("Decrease by"). */
  onionFalloff: number;
  /** Colour-code past and future ghosts. */
  onionTint: boolean;
  onionPastColor: string;
  onionFutureColor: string;
  onionKeyframesOnly: boolean;
  onionOutline: boolean;
}

export interface Prefs {
  general: GeneralPrefs;
  interface: InterfacePrefs;
  stage: StagePrefs;
  snap: SnapPrefs;
  gizmos: GizmoPrefs;
  timeline: TimelinePrefs;
  /** Keyboard shortcut OVERRIDES by command id; the defaults live in
   *  `core/keys/commands.ts`. */
  keys: Overrides;
}

export type PrefsCategory = keyof Prefs;

export const DEFAULT_PREFS: Prefs = {
  general: {
    autosave: true,
    autosaveSeconds: 30,
    confirmDiscard: true,
    guardIkReparent: true,
    confirmLibraryDelete: true,
    newDocWidth: 800,
    newDocHeight: 600,
    newDocFps: 24,
    newDocBackground: "#ffffff",
  },
  interface: {
    accent: "#00bcd9",
    accentRow: "#006b86",
    accentHot: "#2ccde6",
    accentBlue: "#4a90d9",
    setup: "#4fd1c5",
    warn: "#d89a2e",
    fontSize: "small",
  },
  stage: {
    showGrid: false,
    gridSize: 20,
    gridSubdivisions: 5,
    gridColor: "rgba(255,255,255,0.055)",
    gridMajorColor: "rgba(255,255,255,0.11)",
    stageEdgeColor: "#222222",
    pasteboard: "#535353",
    showRulers: true,
    rulerBg: "#3c3c3c",
    rulerTick: "#8f8f8f",
    rulerText: "#a8a8a8",
    showGuides: true,
    guideColor: "#4fd1c5",
    lockGuides: false,
  },
  snap: {
    enabled: true,
    tolerancePx: 8,
    toGrid: true,
    toGuides: true,
    toObjects: true,
    toStage: true,
    toPixel: false,
    showLines: true,
    lineColor: "#ff2fd0",
  },
  gizmos: {
    showBones: true,
    showGizmos: true,
    handleSize: 5.5,
    select: "#0090a7",
    marquee: "rgba(74,144,217,0.18)",
    marqueeEdge: "#4a90d9",
    pivot: "#ffffff",
    axisX: "#e0483d",
    axisY: "#46c05a",
    bone: "rgba(255,214,102,0.9)",
    boneIk: "rgba(120,200,255,0.92)",
    ikTarget: "rgba(90,230,160,0.95)",
    ikLink: "rgba(120,200,255,0.5)",
  },
  timeline: {
    frameWidth: 12,
    playhead: "#e8483f",
    keyframe: "#161616",
    tween: "#7a7fb0",
    selected: "rgba(0,188,217,0.45)",
    onionBefore: 2,
    onionAfter: 2,
    onionOpacity: 0.28,
    onionFalloff: 0.25,
    onionTint: true,
    onionPastColor: "#3d6bff",
    onionFutureColor: "#35c05a",
    onionKeyframesOnly: false,
    onionOutline: false,
  },
  keys: {},
};

/** Range for every numeric field, so a hand-edited or stale blob cannot put
 *  the editor in a state it has no UI to escape from (a zero grid, a
 *  1000-frame onion skin). The dialog reads the same table for its fields. */
export const PREF_LIMITS: Record<string, { min: number; max: number; step?: number; decimals?: number }> = {
  "general.autosaveSeconds": { min: 5, max: 600 },
  "general.newDocWidth": { min: 1, max: 16384 },
  "general.newDocHeight": { min: 1, max: 16384 },
  "general.newDocFps": { min: 1, max: 120 },
  "stage.gridSize": { min: 1, max: 4096 },
  "stage.gridSubdivisions": { min: 1, max: 64 },
  "snap.tolerancePx": { min: 1, max: 64 },
  "gizmos.handleSize": { min: 3, max: 14, step: 0.5, decimals: 1 },
  "timeline.frameWidth": { min: 4, max: 40 },
  "timeline.onionBefore": { min: 0, max: 100 },
  "timeline.onionAfter": { min: 0, max: 100 },
  "timeline.onionOpacity": { min: 0.05, max: 1, step: 0.01, decimals: 2 },
  "timeline.onionFalloff": { min: 0, max: 0.9, step: 0.01, decimals: 2 },
};

/** The string settings that are a CHOICE, not free text. Every colour is free
 *  text — a garbage one costs that one swatch — but a font size outside the
 *  four steps has no UI to get back out of. */
export const PREF_ENUMS: Record<string, readonly string[]> = {
  "interface.fontSize": UI_FONT_SIZES,
};

export function clampPref(path: string, value: number): number {
  const lim = PREF_LIMITS[path];
  if (!lim) return value;
  return Math.max(lim.min, Math.min(lim.max, value));
}

/**
 * Overlay the stored blob on the defaults, key by key.
 *
 * Anything of the wrong type, out of range or simply unknown is dropped
 * rather than rejected wholesale: a preference file written by a build that
 * had one field fewer must still start, and one corrupted colour must not
 * cost the user every other setting.
 */
export function mergePrefs(stored: unknown): Prefs {
  const out = structuredClone(DEFAULT_PREFS);
  if (!stored || typeof stored !== "object") return out;
  const src = stored as Record<string, unknown>;

  out.keys = sanitizeOverrides(src.keys);

  for (const cat of Object.keys(out) as PrefsCategory[]) {
    if (cat === "keys") continue;
    const from = src[cat];
    if (!from || typeof from !== "object") continue;
    const target = out[cat] as unknown as Record<string, unknown>;
    const patch = from as Record<string, unknown>;
    for (const key of Object.keys(target)) {
      if (!(key in patch)) continue;
      const v = patch[key];
      const def = target[key];
      if (typeof v !== typeof def) continue;
      if (typeof v === "number") {
        if (!Number.isFinite(v)) continue;
        target[key] = clampPref(`${cat}.${key}`, v);
      } else {
        const choices = PREF_ENUMS[`${cat}.${key}`];
        if (choices && !choices.includes(v as string)) continue;
        target[key] = v;
      }
    }
  }

  // Before the markers, the onion skin was one symmetric `onionRange`.
  const tl = src.timeline as Record<string, unknown> | undefined;
  const legacy = tl?.onionRange;
  if (typeof legacy === "number" && Number.isFinite(legacy)) {
    if (!("onionBefore" in tl!)) out.timeline.onionBefore = clampPref("timeline.onionBefore", legacy);
    if (!("onionAfter" in tl!)) out.timeline.onionAfter = clampPref("timeline.onionAfter", legacy);
  }
  return out;
}

/** Put one category back to its defaults, leaving the others alone. */
export function resetCategory(prefs: Prefs, cat: PrefsCategory): Prefs {
  const out = structuredClone(prefs);
  (out as unknown as Record<string, unknown>)[cat] =
    structuredClone(DEFAULT_PREFS[cat]);
  return out;
}
