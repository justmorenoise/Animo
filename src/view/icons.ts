/**
 * Inline SVG path data on a 16x16 grid. Strokes inherit `currentColor` and
 * the stroke width comes from CSS, so one icon works in a rail, a footer and
 * a menu without duplication.
 */
export const ICON = {
  // ── Tools ──────────────────────────────────────────────────────────────
  select:      `<path d="M3.5 2 L3.5 12.4 L6.3 9.8 L8.2 13.8 L10 13 L8.1 9.1 L12 8.9 Z"/>`,
  subselect:   `<path d="M4 2.2 L4 12 L6.4 9.7 L8.1 13.3 L9.6 12.6 L8 9.1 L11.4 9 Z" fill="none"/>`,
  freeTransform: `<rect x="3.5" y="3.5" width="9" height="9"/>
                  <rect x="2" y="2" width="3" height="3"/><rect x="11" y="2" width="3" height="3"/>
                  <rect x="2" y="11" width="3" height="3"/><rect x="11" y="11" width="3" height="3"/>`,
  pivot:       `<circle cx="8" cy="8" r="3.2"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/>`,
  bone:        `<path d="M4.6 11.4 L11.4 4.6"/><circle cx="3.4" cy="12.6" r="2"/><circle cx="12.6" cy="3.4" r="2"/>`,
  ik:          `<path d="M3 13 L7 7 L13 5"/><circle cx="3" cy="13" r="1.6"/><circle cx="7" cy="7" r="1.6"/>
                <circle cx="13" cy="5" r="2.2" stroke-dasharray="1.6 1.4"/>`,
  hand:        `<path d="M5 8V4.2a1.1 1.1 0 0 1 2.2 0V8m0-.6V3.4a1.1 1.1 0 0 1 2.2 0V8m0-.4V4.4a1.1 1.1 0 0 1 2.2 0v5.1c0 2.6-1.6 4.5-4 4.5-2.1 0-3.2-1-4.1-2.6L2.8 9.6a1.1 1.1 0 0 1 1.8-1.2z"/>`,
  zoom:        `<circle cx="7" cy="7" r="4.4"/><path d="M10.4 10.4 L14 14"/>`,

  // ── Timeline ───────────────────────────────────────────────────────────
  newLayer:    `<path d="M2.5 5.5h7v8h-7z"/><path d="M5.5 2.5h8v8"/>`,
  newFolder:   `<path d="M2 4.5h4l1.2 1.6H14v7H2z"/>`,
  trash:       `<path d="M3.5 4.5h9M6 4.5V3h4v1.5M4.6 4.5l.6 9h5.6l.6-9M7 7v4M9 7v4"/>`,
  first:       `<path d="M4 3v10M13 3 6 8l7 5z" />`,
  prev:        `<path d="M4 3v10M12 4 6.5 8 12 12z"/>`,
  play:        `<path d="M4.5 3 13 8l-8.5 5z"/>`,
  pause:       `<path d="M5 3.5v9M11 3.5v9"/>`,
  next:        `<path d="M12 3v10M4 4l5.5 4L4 12z"/>`,
  last:        `<path d="M12 3v10M3 3l7 5-7 5z"/>`,
  loop:        `<path d="M3 8a5 5 0 0 1 5-5c2 0 3.6 1.1 4.4 2.7M13 8a5 5 0 0 1-5 5c-2 0-3.6-1.1-4.4-2.7"/>
                <path d="M12.6 2.6v3.2h-3.2M3.4 13.4v-3.2h3.2"/>`,
  onion:       `<circle cx="6" cy="8" r="4"/><circle cx="10" cy="8" r="4" stroke-dasharray="1.8 1.6"/>`,
  // Animate's Edit Multiple Frames: stacked frames, all solid.
  multiFrames: `<rect x="2" y="5.5" width="7.5" height="7.5"/><path d="M4.5 5.5V3h7.5v7.5H9.5"/><path d="M7 3V1.5h7.5V9H12"/>`,
  eye:         `<path d="M1.6 8S4 4 8 4s6.4 4 6.4 4-2.4 4-6.4 4-6.4-4-6.4-4z"/><circle cx="8" cy="8" r="1.8"/>`,
  lock:        `<rect x="3.6" y="7" width="8.8" height="6.4" rx="1"/><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7"/>`,
  // Hidden reads as a struck-through eye: the state is the exception, so the
  // icon has to say "not visible" on its own, with no dot next to it to
  // compare against.
  eyeOff:      `<path d="M1.6 8S4 4 8 4s6.4 4 6.4 4-2.4 4-6.4 4-6.4-4-6.4-4z"/><circle cx="8" cy="8" r="1.8"/>
                <path d="M2.4 2.4 13.6 13.6"/>`,
  outlineSq:   `<rect x="3.5" y="3.5" width="9" height="9"/>`,
  // A mask layer: a filled disc clipping a square, which is what it does.
  mask:        `<rect x="2.5" y="2.5" width="11" height="11"/><circle cx="8" cy="8" r="3.4" fill="currentColor"/>`,
  // Motion blur: a disc trailing speed lines.
  motionBlur:  `<circle cx="10.5" cy="8" r="3" fill="currentColor"/><path d="M1.5 5.5h5M2.5 8h4.5M1.5 10.5h5"/>`,
  masked:      `<circle cx="8" cy="8" r="3.4" fill="currentColor"/>`,
  // An IK target reads as the handle the stage draws for it — a dashed ring
  // with a crosshair — so the row and the thing on the stage are one object.
  // Dashed, unlike the Transform Point tool's solid ring, and a bone icon
  // would say the opposite of the truth: a target drives bones from outside
  // the chain, and is the one node in it that IS keyframed.
  ikTarget:    `<circle cx="8" cy="8" r="3.6" stroke-dasharray="1.7 1.5"/>
                <path d="M8 1.6v2.4M8 12v2.4M1.6 8h2.4M12 8h2.4"/>`,

  // ── Panels / library ───────────────────────────────────────────────────
  hamburger:   `<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>`,
  imageItem:   `<rect x="2.5" y="3.5" width="11" height="9"/><path d="M2.5 10 6 7l2.5 2.4L11 7.6l2.5 2"/>
                <circle cx="5.6" cy="6.1" r="1"/>`,
  symbolItem:  `<rect x="2.5" y="3.5" width="11" height="9"/><path d="M6 6.2 10 8l-4 1.8z"/>`,
  folderItem:  `<path d="M2 4.5h4l1.2 1.6H14v7H2z"/>`,
  emptyItem:   `<rect x="2.5" y="3.5" width="11" height="9" stroke-dasharray="2.2 1.8"/>`,
  noExport:    `<rect x="2.5" y="3.5" width="11" height="9"/><path d="M2.5 13 13.5 3"/>`,
  search:      `<circle cx="7" cy="7" r="4"/><path d="M10 10l3.4 3.4"/>`,
  properties:  `<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/><circle cx="6" cy="4.5" r="1.6" fill="currentColor"/>
                <circle cx="10" cy="8" r="1.6" fill="currentColor"/><circle cx="5" cy="11.5" r="1.6" fill="currentColor"/>`,
  outlinePanel:`<path d="M3 3.5h3M3 8h3M3 12.5h3M8 3.5h5M8 8h5M8 12.5h5"/>`,
  preview:     `<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M6.6 6.2 10.4 8l-3.8 1.8z"/>`,
  grid:        `<path d="M2 6h12M2 10h12M6 2v12M10 2v12"/>`,
  ruler:       `<rect x="2" y="5.5" width="12" height="5"/><path d="M5 5.5v2M8 5.5v3M11 5.5v2"/>`,
  // Two axes from an origin: the reference marks drawn on a selection.
  axes:        `<path d="M3.5 12.5V3.2M3.5 12.5h9.3"/><path d="M1.9 4.8 3.5 2.6l1.6 2.2"/>
                <path d="M11.2 10.9l2.2 1.6-2.2 1.6"/>`,
  snap:        `<path d="M4 2v6a4 4 0 0 0 8 0V2"/><path d="M2 13.5h12"/>`,
  fit:         `<path d="M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3"/>`,
  undo:        `<path d="M4 8h6.2a3 3 0 0 1 0 6H7"/><path d="M6.6 5 3.6 8l3 3"/>`,
  redo:        `<path d="M12 8H5.8a3 3 0 0 0 0 6H9"/><path d="M9.4 5l3 3-3 3"/>`,
  chevRight:   `<path d="M6 3.5 10.5 8 6 12.5"/>`,
  chevLeft:    `<path d="M10 3.5 5.5 8 10 12.5"/>`,
  back:        `<path d="M13 8H3.5M7 4 3.2 8 7 12"/>`,
  scene:       `<rect x="2" y="3.5" width="12" height="9" rx="1"/><path d="M2 6.2h12"/>`,
  float:       `<rect x="2.5" y="5.5" width="8" height="8"/><path d="M8.5 2.5h5v5"/><path d="M13.5 2.5 8 8"/>`,
  close:       `<path d="M4 4l8 8M12 4l-8 8"/>`,
  link:        `<path d="M6.4 9.6 9.6 6.4"/>
                <path d="M7.2 4.8 8.6 3.4a2.6 2.6 0 0 1 3.7 3.7l-1.4 1.4"/>
                <path d="M8.8 11.2 7.4 12.6a2.6 2.6 0 0 1-3.7-3.7l1.4-1.4"/>`,
  linkOff:     `<path d="M7.2 4.8 8.6 3.4a2.6 2.6 0 0 1 3.7 3.7l-1.4 1.4"/>
                <path d="M8.8 11.2 7.4 12.6a2.6 2.6 0 0 1-3.7-3.7l1.4-1.4"/>
                <path d="M2.5 13.5 13.5 2.5" opacity="0.55"/>`,
} as const;

export type IconName = keyof typeof ICON;

export function icon(name: IconName, size = 14): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", "1.35");
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  el.innerHTML = ICON[name];
  return el;
}
