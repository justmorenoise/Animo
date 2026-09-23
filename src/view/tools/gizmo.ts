import type { Matrix2D } from "@/core/math/Matrix2D";
import { apply } from "@/core/math/Matrix2D";
import type { Point, Rect } from "@/core/math/geom";
import { polygonContains } from "@/core/math/geom";
import type { Pose } from "@/core/doc/pose";
import { entryBox, type FrameContext } from "@/core/doc/pose";
import type { Project } from "@/core/doc/types";
import type { NodeId } from "@/core/doc/ids";

export type Corner = "nw" | "ne" | "se" | "sw";
export type Edge = "n" | "e" | "s" | "w";

export type HandleId =
  | { kind: "scale"; corner: Corner }
  | { kind: "scaleEdge"; edge: Edge }
  | { kind: "rotate"; corner: Corner }
  | { kind: "skew"; edge: Edge }
  | { kind: "pivot" }
  | { kind: "move" };

/**
 * The transform box.
 *
 * A single selection gets a box that follows the object's own rotation and
 * shear, so the handles stay glued to the artwork. A multi-selection gets an
 * axis-aligned box around everything, which is what Flash does — there is no
 * single "local" frame shared by objects at different angles.
 */
export interface Gizmo {
  /** World-space corners, in TL, TR, BR, BL order of the box's own frame. */
  corners: [Point, Point, Point, Point];
  /** World-space anchor: the object's transform point, or the group centre. */
  pivot: Point;
  axisAligned: boolean;
  /** Present only for a single selection. */
  single: { nodeId: NodeId; box: Rect; world: Matrix2D } | null;
}

/** A pose on stage and the frame it was evaluated at. */
export interface PoseAt {
  pose: Pose;
  when: FrameContext;
}

/**
 * Every selected node in every pose, counting only the frames where it is
 * actually ON STAGE — the playhead's own included. A frame outside the layer's
 * span (before its first key, past its end, a blank key) shows nothing there,
 * so there is nothing to wrap or edit: a track starting at 7 used to draw a
 * 40px box at the origin on frames 1..6, and stretched a multi-selection's box
 * and the Properties X/Y/W/H out to it.
 *
 * Groups and empty layers are never instances for the same reason, at any
 * frame: there is nothing of theirs on the stage at all.
 */
export function instancesOf(poses: readonly PoseAt[], selection: readonly NodeId[]) {
  return poses.flatMap(({ pose, when }) => selection
    .map((id) => pose.byNode.get(id))
    .filter((e): e is NonNullable<typeof e> => !!e && e.visible
      && e.node.kind !== "group" && e.node.kind !== "empty")
    .map((e) => ({ e, when })));
}

/**
 * The world-aligned box around every selected node in every given pose — a
 * multi-selection's transform box, and what the Properties panel reports as
 * X/Y/W/H for it. With Edit Multiple Frames the poses are every frame between
 * the markers, so the box wraps each instance. A node with no artwork counts
 * as its origin.
 */
export function selectionBounds(
  project: Project, poses: readonly PoseAt[], selection: readonly NodeId[],
): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const { e, when } of instancesOf(poses, selection)) {
    const box = entryBox(project, e, when);
    if (!box) { add(e.world.tx, e.world.ty); continue; }
    for (const [x, y] of [
      [box.x, box.y], [box.x + box.w, box.y],
      [box.x + box.w, box.y + box.h], [box.x, box.y + box.h],
    ] as const) {
      const p = apply({ x: 0, y: 0 }, e.world, x, y);
      add(p.x, p.y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function buildGizmo(
  project: Project, poses: readonly PoseAt[], selection: NodeId[],
): Gizmo | null {
  const instances = instancesOf(poses, selection);
  if (instances.length === 0) return null;

  if (instances.length === 1) {
    const { e, when } = instances[0]!;
    const box = entryBox(project, e, when)
      ?? { x: -20, y: -20, w: 40, h: 40 };          // bones
    const c = (x: number, y: number) => apply({ x: 0, y: 0 }, e.world, x, y);
    return {
      corners: [
        c(box.x, box.y),
        c(box.x + box.w, box.y),
        c(box.x + box.w, box.y + box.h),
        c(box.x, box.y + box.h),
      ],
      pivot: { x: e.world.tx, y: e.world.ty },
      axisAligned: false,
      single: { nodeId: e.nodeId, box, world: e.world },
    };
  }

  const r = selectionBounds(project, poses, selection);
  if (!r) return null;
  return {
    corners: [
      { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
    ],
    pivot: { x: r.x + r.w / 2, y: r.y + r.h / 2 },
    axisAligned: true,
    single: null,
  };
}

const CORNER_ORDER: Corner[] = ["nw", "ne", "se", "sw"];
const EDGE_ORDER: Edge[] = ["n", "e", "s", "w"];

/** Corner and edge-midpoint handle positions, in the gizmo's own order. */
export function handlePoints(g: Gizmo): {
  corners: Record<Corner, Point>;
  edges: Record<Edge, Point>;
} {
  const [tl, tr, br, bl] = g.corners;
  const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return {
    corners: { nw: tl, ne: tr, se: br, sw: bl },
    edges: { n: mid(tl, tr), e: mid(tr, br), s: mid(br, bl), w: mid(bl, tl) },
  };
}

/** The corner diagonally opposite `c` — the anchor a corner drag scales about. */
export function oppositeCorner(c: Corner): Corner {
  return ({ nw: "se", ne: "sw", se: "nw", sw: "ne" } as const)[c];
}

export function oppositeEdge(e: Edge): Edge {
  return ({ n: "s", e: "w", s: "n", w: "e" } as const)[e];
}

export interface HitOptions {
  /** World -> screen, so handle tolerances stay constant in pixels. */
  toScreen(p: Point): Point;
  handleRadius?: number;
  rotateBand?: number;
  edgeBand?: number;
}

/**
 * What is under the pointer. Ordered so the small, precise targets win over
 * the large ones: pivot, then handles, then rotate zones, then edges, then
 * the interior.
 */
export function hitGizmo(g: Gizmo, sx: number, sy: number, opts: HitOptions): HandleId | null {
  const R = opts.handleRadius ?? 5.5;
  // Generous: the rotate ring is an invisible target, and overshooting it
  // deselects, which is a costly mistake to make by a few pixels.
  const ROT = opts.rotateBand ?? 22;
  const EDGE = opts.edgeBand ?? 4.5;

  const S = (p: Point) => opts.toScreen(p);
  const near = (p: Point, r: number) => {
    const q = S(p);
    return Math.hypot(q.x - sx, q.y - sy) <= r;
  };

  if (near(g.pivot, 6.5)) return { kind: "pivot" };

  const { corners, edges } = handlePoints(g);
  for (const c of CORNER_ORDER) if (near(corners[c], R)) return { kind: "scale", corner: c };
  for (const e of EDGE_ORDER) if (near(edges[e], R)) return { kind: "scaleEdge", edge: e };

  // Rotate: just outside a corner, but not inside the box.
  const screenCorners = g.corners.map(S) as [Point, Point, Point, Point];
  const inside = polygonContains(screenCorners, sx, sy);
  if (!inside) {
    for (const c of CORNER_ORDER) if (near(corners[c], ROT)) return { kind: "rotate", corner: c };
  }

  // Skew: along an edge, between the handles.
  const segs: Array<{ edge: Edge; a: Point; b: Point }> = [
    { edge: "n", a: screenCorners[0], b: screenCorners[1] },
    { edge: "e", a: screenCorners[1], b: screenCorners[2] },
    { edge: "s", a: screenCorners[2], b: screenCorners[3] },
    { edge: "w", a: screenCorners[3], b: screenCorners[0] },
  ];
  for (const s of segs) {
    if (distToSegment(sx, sy, s.a, s.b) <= EDGE) return { kind: "skew", edge: s.edge };
  }

  if (inside) return { kind: "move" };
  return null;
}

export function cursorFor(h: HandleId | null, g: Gizmo | null): string {
  if (!h) return "";
  switch (h.kind) {
    case "pivot": return "crosshair";
    case "move": return "move";
    case "rotate": return rotateCursor(cornerAngle(g, h.corner));
    case "skew": return h.edge === "n" || h.edge === "s" ? "ew-resize" : "ns-resize";
    case "scaleEdge": return directionCursor(edgeAngle(g, h.edge));
    case "scale": return directionCursor(cornerAngle(g, h.corner));
  }
}

/**
 * The rotate cursor: the resize cursor's two triangles, bent.
 *
 * A `grab` hand said "you can drag this" and nothing about what the drag would
 * do — every other handle here says which way it moves. There is no standard
 * cursor for rotation, so it is an inline SVG built to match the platform's
 * resize cursors: two solid arrowheads with a white keyline, joined by a short
 * arc instead of a straight shaft, so the pair reads as the same family.
 *
 * The glyph is drawn for the BOTTOM-LEFT corner of an upright box, which sits
 * at 135° from the centre, and every other corner — and every rotation of the
 * box itself — is that same glyph turned by `cornerAngle - 135`.
 *
 * Cached per 15° bucket: `cursorFor` runs on every hover event, and building a
 * data URI per pixel of pointer movement is pure waste.
 */
const rotateCursors = new Map<number, string>();

const ROTATE_GLYPH = buildRotateGlyph();

function rotateCursor(angleDeg: number): string {
  const bucket = Math.round(((angleDeg - 135) % 360) / 15) * 15;
  const cached = rotateCursors.get(bucket);
  if (cached) return cached;

  // 32x32 with the hotspot in the middle. The shape is stroked white first and
  // painted black on top — the same keyline the OS cursors use, and what keeps
  // it legible on the white stage and on the grey pasteboard alike.
  const { arc, heads } = ROTATE_GLYPH;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 36 36">` +
    `<g transform="rotate(${bucket} 18 18)" stroke-linejoin="round">` +
    `<path d="${arc}" fill="none" stroke="#fff" stroke-width="4.6" stroke-linecap="round"/>` +
    `<path d="${heads}" fill="#fff" stroke="#fff" stroke-width="2.8"/>` +
    `<path d="${arc}" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round"/>` +
    `<path d="${heads}" fill="#000"/>` +
    `</g></svg>`;
  const css = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, grab`;
  rotateCursors.set(bucket, css);
  return css;
}

/**
 * The arc and its two arrowheads, computed rather than hand-plotted: the heads
 * have to sit exactly on the arc's ends and point along the tangent, which is
 * not something to eyeball in path data.
 */
function buildRotateGlyph(): { arc: string; heads: string } {
  const cx = 18, cy = 18, r = 10;
  const from = 70, to = 200;                   // a 130° sweep, centred on 135°
  const HEAD = 4.8;                            // tip beyond the arc's end
  const HALF = 3.1;                            // half the head's base

  const rad = (d: number) => (d * Math.PI) / 180;
  const at = (d: number) => ({ x: cx + r * Math.cos(rad(d)), y: cy + r * Math.sin(rad(d)) });
  // Unit tangent; `out` points AWAY from the arc at each end, which is the way
  // that end of the drag travels.
  const tangent = (d: number, out: 1 | -1) =>
    ({ x: -Math.sin(rad(d)) * out, y: Math.cos(rad(d)) * out });
  const radial = (d: number) => ({ x: Math.cos(rad(d)), y: Math.sin(rad(d)) });
  const n = (v: number) => Math.round(v * 100) / 100;

  const head = (deg: number, out: 1 | -1) => {
    const p = at(deg), t = tangent(deg, out), q = radial(deg);
    const tip = { x: p.x + t.x * HEAD, y: p.y + t.y * HEAD };
    const a = { x: p.x + q.x * HALF, y: p.y + q.y * HALF };
    const b = { x: p.x - q.x * HALF, y: p.y - q.y * HALF };
    return `M${n(tip.x)} ${n(tip.y)} L${n(a.x)} ${n(a.y)} L${n(b.x)} ${n(b.y)} Z`;
  };

  const p0 = at(from), p1 = at(to);
  return {
    arc: `M${n(p0.x)} ${n(p0.y)} A ${r} ${r} 0 0 1 ${n(p1.x)} ${n(p1.y)}`,
    heads: `${head(from, -1)} ${head(to, 1)}`,
  };
}

/** Pick a resize cursor from a direction, so it stays right under rotation. */
function directionCursor(angleDeg: number): string {
  const a = ((angleDeg % 180) + 180) % 180;
  if (a < 22.5 || a >= 157.5) return "ew-resize";
  if (a < 67.5) return "nwse-resize";
  if (a < 112.5) return "ns-resize";
  return "nesw-resize";
}

function edgeAngle(g: Gizmo | null, e: Edge): number {
  if (!g) return 0;
  const { edges } = handlePoints(g);
  const opp = edges[oppositeEdge(e)];
  const p = edges[e];
  return (Math.atan2(p.y - opp.y, p.x - opp.x) * 180) / Math.PI;
}

function cornerAngle(g: Gizmo | null, c: Corner): number {
  if (!g) return 45;
  const { corners } = handlePoints(g);
  const opp = corners[oppositeCorner(c)];
  const p = corners[c];
  return (Math.atan2(p.y - opp.y, p.x - opp.x) * 180) / Math.PI;
}

function distToSegment(px: number, py: number, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** Which local-box corner a named corner maps to, as 0..1 fractions. */
export function cornerFraction(c: Corner): { fx: number; fy: number } {
  return ({
    nw: { fx: 0, fy: 0 }, ne: { fx: 1, fy: 0 },
    se: { fx: 1, fy: 1 }, sw: { fx: 0, fy: 1 },
  } as const)[c];
}

export function edgeFraction(e: Edge): { fx: number; fy: number } {
  return ({
    n: { fx: 0.5, fy: 0 }, e: { fx: 1, fy: 0.5 },
    s: { fx: 0.5, fy: 1 }, w: { fx: 0, fy: 0.5 },
  } as const)[e];
}
