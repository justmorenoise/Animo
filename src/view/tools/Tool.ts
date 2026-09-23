import type { Store } from "@/app/Store";
import type { AssetStore } from "@/app/AssetStore";
import type { Camera } from "@/view/viewport/Camera";
import type { Pose } from "@/core/doc/pose";
import type { Point } from "@/core/math/geom";
import type { Gizmo } from "./gizmo";

/** What the viewport hands to a tool. Tools never touch the DOM. */
export interface ToolContext {
  store: Store;
  assets: AssetStore;
  camera: Camera;
  pose(): Pose | null;
  gizmo(): Gizmo | null;
  /** Pointer event -> world coordinates. */
  toWorld(e: PointerEvent | MouseEvent): Point;
  /** Pointer event -> content-area screen coordinates (rulers excluded). */
  toContent(e: PointerEvent | MouseEvent): Point;
  /** World -> content-area screen. */
  toScreen(p: Point): Point;
  /** Topmost pickable node at a world point, alpha-accurate. */
  hitTest(wx: number, wy: number, exclude?: Set<string>): string | null;
  /** Nodes intersecting a content-area screen rect. */
  nodesInRect(r: { x: number; y: number; w: number; h: number }, exclude?: Set<string>): string[];
  invalidate(): void;
  /** Marquee rectangle to draw, in content-area screen space. */
  setMarquee(r: { x: number; y: number; w: number; h: number } | null): void;
  /** Bone being dragged out, in WORLD space; drawn by the overlay. */
  setDraftBone(segment: { ax: number; ay: number; bx: number; by: number } | null): void;
  /**
   * Open a snapping session for the nodes about to move. Call it once, at the
   * start of the drag: the reference points are the selection's bounds AS OF
   * THAT MOMENT, which is the frame a tool's delta is measured in.
   */
  beginSnap(moving: Iterable<string>): void;
  /**
   * Correct a world-space drag delta so the selection lands on a grid line, a
   * guide, the stage or another object. Also records the smart guides the
   * overlay draws, so a tool never has to know what a snap looked like.
   *
   * `free` is the escape hatch — ⌘/Ctrl held during the drag — and returns
   * the delta untouched.
   */
  snapDelta(dx: number, dy: number, free?: boolean): { dx: number; dy: number };
  /** End the session and clear the smart guides. */
  endSnap(): void;
  setCursor(cursor: string): void;
}

export interface Tool {
  readonly id: string;
  onPointerDown?(e: PointerEvent, ctx: ToolContext): void;
  onPointerMove?(e: PointerEvent, ctx: ToolContext): void;
  onPointerUp?(e: PointerEvent, ctx: ToolContext): void;
  /** Pointer moved with no button down — used to set the cursor. */
  onHover?(e: PointerEvent, ctx: ToolContext): void;
  onCancel?(ctx: ToolContext): void;
  onDeactivate?(ctx: ToolContext): void;
  /** Does this tool draw a transform box? */
  readonly showsGizmo?: boolean;
}
