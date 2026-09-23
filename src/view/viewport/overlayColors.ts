import type { Prefs } from "@/core/prefs/prefs";
import { withAlpha } from "@/core/prefs/color";

/** Re-exported: the frame grid dims the playhead with it too. */
export { withAlpha };

/**
 * The stage chrome palette.
 *
 * It used to be a module constant inside `Overlay.ts`; it is a value now so
 * the Preferences dialog can hand a different one in. The keys and the
 * defaults are unchanged, so an editor with no saved preferences draws
 * exactly what it drew before.
 */
export interface OverlayColors {
  ruler: string;
  rulerLine: string;
  rulerTick: string;
  rulerText: string;
  grid: string;
  gridMajor: string;
  guide: string;
  stageEdge: string;
  select: string;
  selectSoft: string;
  bone: string;
  boneCore: string;
  boneSelected: string;
  boneIk: string;
  ikTarget: string;
  ikLink: string;
  ikLinkActive: string;
  marquee: string;
  marqueeEdge: string;
  pivot: string;
  axisX: string;
  axisY: string;
  driven: string;
  emptySymbol: string;
  setup: string;
  snapLine: string;
}

export const DEFAULT_COLORS: OverlayColors = {
  ruler: "#3c3c3c",
  rulerLine: "#2a2a2a",
  rulerTick: "#8f8f8f",
  rulerText: "#a8a8a8",
  grid: "rgba(255,255,255,0.055)",
  gridMajor: "rgba(255,255,255,0.11)",
  guide: "#4fd1c5",
  stageEdge: "#222",
  select: "#00bcd9",
  selectSoft: "rgba(0,188,217,0.80)",
  bone: "rgba(44,205,230,0.9)",
  boneCore: "#2b2b2b",
  boneSelected: "#ffffff",
  boneIk: "rgba(120,200,255,0.92)",      // driven by a constraint
  ikTarget: "rgba(90,230,160,0.95)",
  ikLink: "rgba(120,200,255,0.5)",
  ikLinkActive: "rgba(150,215,255,0.95)",
  marquee: "rgba(74,144,217,0.18)",
  marqueeEdge: "#4a90d9",
  pivot: "#ffffff",
  // Red x, green y: the axis convention every 3D tool uses, and the pair the
  // eye separates fastest — which matters here, because the two axes are the
  // whole explanation for a "y" that moves something sideways.
  axisX: "#e0483d",
  axisY: "#46c05a",
  driven: "rgba(0,144,167,0.42)",       // the artwork a bone carries
  emptySymbol: "rgba(0,144,167,0.8)",
  setup: "#4fd1c5",                      // matches --setup in theme.css
  snapLine: "#ff2fd0",
};

/** The palette the preferences describe; anything they do not cover keeps its
 *  default, so adding a swatch to the dialog is a one-line change here. */
export function resolveColors(prefs: Prefs): OverlayColors {
  const { stage, gizmos, snap } = prefs;
  return {
    ...DEFAULT_COLORS,
    ruler: stage.rulerBg,
    rulerTick: stage.rulerTick,
    rulerText: stage.rulerText,
    grid: stage.gridColor,
    gridMajor: stage.gridMajorColor,
    guide: stage.guideColor,
    stageEdge: stage.stageEdgeColor,
    select: gizmos.select,
    selectSoft: withAlpha(gizmos.select, 0.85),
    marquee: gizmos.marquee,
    marqueeEdge: gizmos.marqueeEdge,
    pivot: gizmos.pivot,
    axisX: gizmos.axisX,
    axisY: gizmos.axisY,
    bone: gizmos.bone,
    boneIk: gizmos.boneIk,
    ikTarget: gizmos.ikTarget,
    ikLink: gizmos.ikLink,
    driven: withAlpha(gizmos.select, 0.42),
    emptySymbol: withAlpha(gizmos.select, 0.8),
    setup: prefs.interface.setup,
    snapLine: snap.lineColor,
  };
}
