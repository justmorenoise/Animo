/**
 * Keeping a DragonBones file's draw order where Animo's layer tree cannot.
 *
 * Animo draws the layer list depth first, so what hangs under a bone is
 * drawn together; DragonBones orders slots freely. `dbImport` sorts siblings
 * by the front-most slot under them and names the slots that still land out
 * of order. When the user asks for the file's order instead of the rig, each
 * of those slots is moved next to the slot drawn just behind it in the file,
 * under that slot's parent, and keyed on every frame of every animation with
 * where it was: its world matrix (IK and all) expressed in the new parent's
 * space. The picture is the file's; the slot no longer follows its bones.
 */
import { invert, mat, type Matrix2D, mul } from "@/core/math/Matrix2D";
import { fromMatrix, tf, type Transform } from "@/core/math/Transform";
import { TWEEN_LINEAR, TWEEN_NONE } from "@/core/math/easing";
import type { NodeId } from "./ids";
import { evaluateSymbol } from "./pose";
import type { Keyframe, Layer, SymbolItem } from "./types";

/**
 * `moved`: slot nodes out of the file's order. `z`: every slot node's place in
 * the file, back to front. Returns, per moved slot, the frames on which its
 * new parent was scaled to nothing: no key can place it there, and it keeps
 * the frame before.
 */
export function bakeDrawOrder(sym: SymbolItem, z: ReadonlyMap<NodeId, number>, moved: ReadonlySet<NodeId>): Map<NodeId, number> {
  const flat = new Map<NodeId, number>();
  if (!moved.size) return flat;
  // Where everything is, before anything moves.
  const poses = sym.animations.map((anim) => Array.from({ length: anim.duration }, (_, f) => evaluateSymbol(sym, anim, f)));
  const setup = evaluateSymbol(sym, null, 0, "setup");
  const worldIn = (pose: ReturnType<typeof evaluateSymbol>, id: NodeId | null): Matrix2D =>
    (id ? pose.byNode.get(id)?.world : undefined) ?? mat();

  const kept = [...z.keys()].filter((id) => !moved.has(id)).sort((a, b) => z.get(a)! - z.get(b)!);
  // Front to back, so slots that share a neighbour go in in the file's order.
  const order = [...moved].sort((a, b) => z.get(b)! - z.get(a)!);
  for (const id of order) {
    const node = sym.nodes[id]!;
    const at = z.get(id)!;
    const behind = [...kept].reverse().find((k) => z.get(k)! < at);
    const parentId = behind ? sym.nodes[behind]!.parentId : kept.length ? sym.nodes[kept[0]!]!.parentId : null;

    const local = (pose: ReturnType<typeof evaluateSymbol>, prev?: Transform): Transform | null => {
      const p = worldIn(pose, parentId);
      if (Math.abs(p.a * p.d - p.b * p.c) < 1e-9) return null;
      const inv = mat();
      invert(inv, p);
      return fromMatrix(tf(), mul(mat(), inv, worldIn(pose, id)), prev);
    };
    const bind = local(setup, node.bind) ?? node.bind;
    sym.animations.forEach((anim, i) => {
      const colored = anim.tracks[id]?.keys.some((k) => k.color) ?? false;
      let prev = bind;
      const keys: Keyframe[] = poses[i]!.map((pose, f) => {
        const e = pose.byNode.get(id)!;
        const t = local(pose, prev);
        if (t) prev = t;
        else flat.set(id, (flat.get(id) ?? 0) + 1);
        const key: Keyframe = { frame: f, transform: prev, displayIndex: e.displayIndex, tween: f < anim.duration - 1 ? TWEEN_LINEAR : TWEEN_NONE };
        if (colored) key.color = { ...e.color };
        return key;
      });
      anim.tracks[id] = { nodeId: id, keys, endFrame: anim.duration - 1 };
    });
    node.bind = bind;
    node.parentId = parentId;

    // Its row goes just in front of the slot behind it, or, at the very back,
    // behind the back-most one and everything under it.
    const own = sym.layers.findIndex((l) => l.nodeId === id);
    const [layer] = sym.layers.splice(own, 1) as [Layer];
    const ref = behind ?? kept[0];
    let index = ref ? sym.layers.findIndex((l) => l.nodeId === ref) : sym.layers.length;
    if (ref && !behind) index = endOfSubtree(sym, index);
    layer.depth = ref ? sym.layers[Math.min(index, sym.layers.length - 1)]?.depth ?? 0 : 0;
    if (ref && !behind) layer.depth = sym.layers.find((l) => l.nodeId === ref)!.depth;
    sym.layers.splice(index, 0, layer);
    kept.push(id);
    kept.sort((a, b) => z.get(a)! - z.get(b)!);
  }
  return flat;
}

/** The index just past the row at `index` and every row under it. */
function endOfSubtree(sym: SymbolItem, index: number): number {
  const depth = sym.layers[index]!.depth;
  let i = index + 1;
  while (i < sym.layers.length && sym.layers[i]!.depth > depth) i++;
  return i;
}
