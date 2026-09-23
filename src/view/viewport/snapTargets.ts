import type { Project, SymbolItem } from "@/core/doc/types";
import type { NodeId } from "@/core/doc/ids";
import { entryBox, type FrameContext, type Pose } from "@/core/doc/pose";
import { apply, mat, type Matrix2D, mul } from "@/core/math/Matrix2D";
import { type Rect, rectUnion, transformRect } from "@/core/math/geom";
import type { SnapTargets } from "@/core/math/snap";
import type { Guide } from "./Overlay";
import type { SnapPrefs } from "@/core/prefs/prefs";

/**
 * What a drag can snap TO, and where the thing being dragged currently is.
 *
 * Everything is expressed in SCENE space: the grid, the guides and the stage
 * rectangle are scene concepts (`Camera.sceneToScreen` ignores `base`), so
 * inside an edited symbol the caller converts its world delta in and out
 * rather than four frames being mixed here.
 */

/** The scene-space bounds of one node, or its origin when it draws nothing. */
function nodeRect(
  project: Project, pose: Pose, base: Matrix2D, id: NodeId, when: FrameContext,
): Rect | null {
  const e = pose.byNode.get(id);
  if (!e) return null;
  const m = mul(mat(), base, e.world);
  const box = entryBox(project, e, when);
  // A bone, a group or an empty layer has no artwork; its origin is still a
  // position worth landing on, so it contributes a degenerate rect.
  if (!box) return { x: m.tx, y: m.ty, w: 0, h: 0 };
  return transformRect(m, box);
}

export function collectSnapTargets(
  project: Project,
  symbol: SymbolItem,
  pose: Pose,
  base: Matrix2D,
  guides: Guide[],
  exclude: Set<NodeId>,
  when: FrameContext,
  prefs: SnapPrefs,
): SnapTargets {
  const xs: number[] = [];
  const ys: number[] = [];

  if (prefs.toStage) {
    const s = project.stage;
    xs.push(0, s.width / 2, s.width);
    ys.push(0, s.height / 2, s.height);
  }

  if (prefs.toGuides) {
    for (const g of guides) (g.axis === "x" ? xs : ys).push(g.at);
  }

  if (prefs.toObjects) {
    // Hidden and locked layers are unpickable, so they are also not something
    // a drag should silently catch on.
    const skip = new Set<string>(
      symbol.layers.filter((l) => l.locked || !l.visible).map((l) => l.nodeId),
    );
    for (const id of pose.byNode.keys()) {
      if (exclude.has(id) || skip.has(id)) continue;
      const r = nodeRect(project, pose, base, id, when);
      if (!r) continue;
      xs.push(r.x, r.x + r.w / 2, r.x + r.w);
      ys.push(r.y, r.y + r.h / 2, r.y + r.h);
    }
  }

  return { xs, ys };
}

/** The moving side: the edges and centre of the dragged selection's bounds,
 *  in scene space. An empty selection snaps nothing. */
export function selectionRefs(
  project: Project, pose: Pose, base: Matrix2D, ids: Iterable<NodeId>, when: FrameContext,
): { xs: number[]; ys: number[] } {
  let bounds: Rect | null = null;
  for (const id of ids) {
    const r = nodeRect(project, pose, base, id, when);
    if (r) bounds = rectUnion(bounds, r);
  }
  if (!bounds) return { xs: [], ys: [] };
  return {
    xs: [bounds.x, bounds.x + bounds.w / 2, bounds.x + bounds.w],
    ys: [bounds.y, bounds.y + bounds.h / 2, bounds.y + bounds.h],
  };
}

/** Scene-space point of a world-space one, for tools that snap a single
 *  handle rather than a box. */
export function toScene(base: Matrix2D, x: number, y: number): { x: number; y: number } {
  return apply({ x: 0, y: 0 }, base, x, y);
}
