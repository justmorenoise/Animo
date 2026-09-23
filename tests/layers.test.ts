import { describe, it, expect, beforeEach } from "vitest";
import { reseed, type AssetId, type NodeId } from "@/core/doc/ids";
import {
  createProject, createImageItem, createNode, createLayer, createTrack, createSymbol,
} from "@/core/doc/defaults";
import { isSymbol, type Project, type SymbolItem, type Node } from "@/core/doc/types";
import { exportSkeleton } from "@/core/export/exportSkeleton";
import { History } from "@/core/history/History";
import {
  ReorderLayer, RemoveNodes, SetLayerExcluded, SetNodeItem, SetParent,
} from "@/core/history/commands";
import { indexAbove } from "@/core/doc/layerTree";

beforeEach(() => reseed());

/**
 * Empty layers and "Exclude from Export" are both ways of putting something
 * in the timeline that must NOT reach the file. Both are invisible until an
 * export is inspected, which is exactly why they are pinned here.
 */
function scene(names: string[]): { project: Project; sym: SymbolItem } {
  const project = createProject("Rig");
  const sym = project.items[project.rootSymbolId];
  if (!isSymbol(sym)) throw new Error("no root");
  names.forEach((name, i) => {
    const item = createImageItem(name, `asset_${name}` as AssetId, 40, 30);
    project.items[item.id] = item;
    project.itemOrder.push(item.id);
    const node = createNode("image", name, { itemId: item.id });
    sym.nodes[node.id] = node;
    sym.layers.unshift(createLayer(node.id, name, i));   // index 0 is the TOP row
  });
  return { project, sym };
}

function add(sym: SymbolItem, node: Node, at = 0): Node {
  sym.nodes[node.id] = node;
  sym.layers.splice(at, 0, createLayer(node.id, node.name, sym.layers.length));
  return node;
}

const armature = (p: Project) => exportSkeleton(p).skeleton.armature[0]!;
const names = (xs: { name: string }[]) => xs.map((x) => x.name);

describe("empty layers", () => {
  it("export as nothing at all — no bone, no slot, no timeline", () => {
    const { project, sym } = scene(["art"]);
    const empty = add(sym, createNode("empty", "Layer 1"));
    sym.animations[0]!.tracks[empty.id] = createTrack(empty, 4);

    const arm = armature(project);
    expect(names(arm.bone)).toEqual(["art"]);
    expect(names(arm.slot)).toEqual(["art"]);
    expect(arm.animation[0]!.bone ?? []).toHaveLength(0);
  });

  it("keeps its bone when a kept node is parented under it", () => {
    // Dropping the bone would reparent the child to the armature root and
    // move it; the slot still must not exist.
    const { project, sym } = scene(["art"]);
    const empty = add(sym, createNode("empty", "Layer 1"));
    const art = Object.values(sym.nodes).find((n) => n.name === "art")!;
    art.parentId = empty.id;

    const arm = armature(project);
    expect(names(arm.bone).sort()).toEqual(["Layer 1", "art"]);
    expect(names(arm.slot)).toEqual(["art"]);
    expect(arm.bone.find((b) => b.name === "art")!.parent).toBe("Layer 1");
  });

  it("becomes a real instance through SetNodeItem, keeping its tracks", () => {
    const { project, sym } = scene(["art"]);
    const empty = add(sym, createNode("empty", "Layer 1"));
    const track = createTrack(empty, 6);
    sym.animations[0]!.tracks[empty.id] = track;
    const itemId = Object.values(project.items).find((i) => i.name === "art")!.id;

    const history = new History(project);
    history.apply(new SetNodeItem(sym.id, new Map([[empty.id, { itemId, kind: "image" }]])));

    expect(sym.nodes[empty.id]!.kind).toBe("image");
    expect(sym.nodes[empty.id]!.itemId).toBe(itemId);
    expect(sym.animations[0]!.tracks[empty.id]).toBe(track);
    expect(names(armature(project).slot).sort()).toEqual(["Layer 1", "art"]);

    history.undo();
    expect(sym.nodes[empty.id]!.kind).toBe("empty");
    expect(sym.nodes[empty.id]!.itemId).toBeUndefined();
    expect(sym.animations[0]!.tracks[empty.id]).toBe(track);
  });
});

describe("exclude from export", () => {
  it("removes the bone, the slot, the timeline and the image", () => {
    const { project, sym } = scene(["keep", "drop"]);
    const dropLayer = sym.layers.find((l) => l.name === "drop")!;
    const dropped = sym.nodes[dropLayer.nodeId]!;
    sym.animations[0]!.tracks[dropped.id] = createTrack(dropped, 4);
    dropLayer.excludeFromExport = true;

    const result = exportSkeleton(project);
    const arm = result.skeleton.armature[0]!;
    expect(names(arm.bone)).toEqual(["keep"]);
    expect(names(arm.slot)).toEqual(["keep"]);
    expect(arm.animation[0]!.bone ?? []).toHaveLength(0);
    expect(result.usedImages).toHaveLength(1);
    expect(result.diagnostics.some((d) => d.message.includes('"drop"'))).toBe(true);
  });

  it("takes the whole subtree of an excluded group with it", () => {
    const { project, sym } = scene(["child", "keep"]);
    const group = add(sym, createNode("group", "rig"));
    const child = Object.values(sym.nodes).find((n) => n.name === "child")!;
    child.parentId = group.id;
    sym.layers.find((l) => l.nodeId === group.id)!.excludeFromExport = true;

    const arm = armature(project);
    expect(names(arm.bone)).toEqual(["keep"]);
    expect(names(arm.slot)).toEqual(["keep"]);
  });

  it("does not export the armature or the art of a symbol only an excluded layer uses", () => {
    const { project, sym } = scene(["keep"]);
    const ref = createSymbol("Reference");
    project.items[ref.id] = ref;
    const art = createImageItem("reference_art", "asset_ref" as AssetId, 10, 10);
    project.items[art.id] = art;
    const inner = createNode("image", "reference_art", { itemId: art.id });
    ref.nodes[inner.id] = inner;
    ref.layers.push(createLayer(inner.id, "reference_art", 0));

    const instance = add(sym, createNode("symbol", "reference", { itemId: ref.id }));
    const layer = sym.layers.find((l) => l.nodeId === instance.id)!;
    expect(exportSkeleton(project).skeleton.armature.map((a) => a.name)).toContain("Reference");

    layer.excludeFromExport = true;
    const result = exportSkeleton(project);
    expect(result.skeleton.armature.map((a) => a.name)).toEqual(["Scene 1"]);
    expect(result.usedImages).not.toContain(art.id);
  });

  it("still exports a symbol that a kept layer uses too", () => {
    const { project, sym } = scene([]);
    const ref = createSymbol("Shared");
    project.items[ref.id] = ref;
    const a = add(sym, createNode("symbol", "a", { itemId: ref.id }));
    add(sym, createNode("symbol", "b", { itemId: ref.id }));
    sym.layers.find((l) => l.nodeId === a.id)!.excludeFromExport = true;
    expect(exportSkeleton(project).skeleton.armature.map((x) => x.name)).toContain("Shared");
  });

  it("leaves the names of the layers it keeps alone", () => {
    // uniqueNames deliberately runs over every layer: filtering there would
    // renumber a collision suffix the moment a sibling is excluded.
    const { project, sym } = scene(["art", "art"]);
    sym.layers[0]!.excludeFromExport = true;
    expect(names(armature(project).slot)).toEqual(["art_2"]);
  });

  it("drops an excluded mask, and an excluded target, from the sidecar", () => {
    const { project, sym } = scene(["under", "clip"]);
    sym.layers[0]!.isMask = true;
    sym.layers[1]!.maskedBy = sym.layers[0]!.id;
    expect(exportSkeleton(project).masks).toHaveLength(1);

    sym.layers[0]!.excludeFromExport = true;
    expect(exportSkeleton(project).masks).toHaveLength(0);
  });

  it("is undoable and leaves no key behind when off", () => {
    const { project, sym } = scene(["art"]);
    const layer = sym.layers[0]!;
    const history = new History(project);

    history.apply(new SetLayerExcluded(sym.id, [layer.id], true));
    expect(layer.excludeFromExport).toBe(true);
    history.undo();
    expect("excludeFromExport" in layer).toBe(false);
  });
});

describe("layer order stays depth first", () => {
  it("after inserting an empty layer above a group's child", () => {
    const { project, sym } = scene(["child"]);
    const group = add(sym, createNode("group", "rig"));
    const child = Object.values(sym.nodes).find((n) => n.name === "child")!;
    const history = new History(project);
    history.apply(new SetParent(sym.id, [child.id as NodeId], group.id));

    expect(sym.layers.map((l) => l.name)).toEqual(["rig", "child"]);
    expect(armature(project).bone.find((b) => b.name === "child")!.parent).toBe("rig");
  });
});

describe("undo puts every layer back where it was", () => {
  /** x, then group g with children c1 and c2, then y — all depth first. */
  function grouped() {
    const { project, sym } = scene(["y", "c2", "c1", "x"]);        // x, c1, c2, y
    const g = add(sym, createNode("group", "g"), 1);                // x, g, c1, c2, y
    for (const name of ["c1", "c2"]) {
      Object.values(sym.nodes).find((n) => n.name === name)!.parentId = g.id;
    }
    const order = () => sym.layers.map((l) => l.name);
    expect(order()).toEqual(["x", "g", "c1", "c2", "y"]);
    return { project, sym, g, order, id: (name: string) => sym.layers.find((l) => l.name === name)!.id };
  }

  // Normalising moves the group's children after it; the undo moved back
  // only the group and left them where normalising had put them.
  it("after moving a group below a sibling", () => {
    const { project, sym, order, id } = grouped();
    const history = new History(project);
    history.apply(new ReorderLayer(sym.id, id("g"), 4));
    expect(order()).toEqual(["x", "y", "g", "c1", "c2"]);
    history.undo();
    expect(order()).toEqual(["x", "g", "c1", "c2", "y"]);
    history.redo();
    expect(order()).toEqual(["x", "y", "g", "c1", "c2"]);
  });

  it("after deleting a group with its children", () => {
    const { project, sym, g, order } = grouped();
    const history = new History(project);
    history.apply(new RemoveNodes(sym.id, [g.id]));
    expect(order()).toEqual(["x", "y"]);
    history.undo();
    expect(order()).toEqual(["x", "g", "c1", "c2", "y"]);
  });

  // The undo re-normalised the order the parenting had left, in which the
  // reparented layer no longer sat where it started.
  it("after parenting a top layer into a group", () => {
    const { project, sym, g, order } = grouped();
    const x = Object.values(sym.nodes).find((n) => n.name === "x")!;
    const history = new History(project);
    history.apply(new SetParent(sym.id, [x.id], g.id));
    expect(order()).toEqual(["g", "x", "c1", "c2", "y"]);
    history.undo();
    expect(order()).toEqual(["x", "g", "c1", "c2", "y"]);
    expect(x.parentId).toBeNull();
  });
});

describe("dropping a layer on a row", () => {
  it("lands it directly above that row, moving down as well as up", () => {
    const { sym } = scene(["d", "c", "b", "a"]);             // a, b, c, d
    const id = (name: string) => sym.layers.find((l) => l.name === name)!.id;
    const history = new History({ ...createProject("x"), items: { [sym.id]: sym }, rootSymbolId: sym.id });

    history.apply(new ReorderLayer(sym.id, id("a"), indexAbove(sym, id("a"), id("c"))));
    expect(sym.layers.map((l) => l.name)).toEqual(["b", "a", "c", "d"]);

    history.apply(new ReorderLayer(sym.id, id("d"), indexAbove(sym, id("d"), id("b"))));
    expect(sym.layers.map((l) => l.name)).toEqual(["d", "b", "a", "c"]);
  });
});

describe("New Group", () => {
  it("adopts only the topmost of a selection, so a rig keeps its hierarchy", async () => {
    const { loadStickman } = await import("./fixtures/stickman");
    const { groupPlan } = await import("@/core/doc/layerTree");
    const { evaluateSymbol } = await import("@/core/doc/pose");
    const { SetParent, AddNode } = await import("@/core/history/commands");
    const { createNode: node, createLayer: layer } = await import("@/core/doc/defaults");
    const { History } = await import("@/core/history/History");
    const f = await loadStickman();
    const all = Object.keys(f.rig.nodes) as never[];
    const parentsBefore = Object.fromEntries(Object.values(f.rig.nodes).map((n) => [n.id, n.parentId]));
    const before = evaluateSymbol(f.rig, f.rig.animations[0]!, 7, "animate");

    const plan = groupPlan(f.rig, all, () => ({ x: 0, y: 0 }));
    const roots = Object.values(f.rig.nodes).filter((n) => !n.parentId).map((n) => n.id);
    expect(new Set(plan.members)).toEqual(new Set(roots));

    const history = new History(f.project);
    const g = node("group", "g", { x: plan.origin.x, y: plan.origin.y, parentId: plan.parent });
    history.transaction("Group", () => {
      history.apply(new AddNode("Group", f.rig.id, g, layer(g.id, "g", 0), plan.index));
      history.apply(new SetParent(f.rig.id, plan.members, g.id));
    });
    for (const n of Object.values(f.rig.nodes)) {
      if (n.id === g.id) continue;
      expect(n.parentId).toBe(parentsBefore[n.id] ?? g.id);
    }
    const after = evaluateSymbol(f.rig, f.rig.animations[0]!, 7, "animate");
    for (const [id, e] of before.byNode) {
      for (const k of ["tx", "ty"] as const) expect(after.byNode.get(id)!.world[k]).toBeCloseTo(e.world[k], 4);
    }
  });

  it("goes under the shared parent of what it groups", async () => {
    const { groupPlan } = await import("@/core/doc/layerTree");
    const { createSymbol, createNode: node, createLayer: layer } = await import("@/core/doc/defaults");
    const sym = createSymbol("s");
    const p = node("group", "p", { x: 100, y: 0 });
    const a = node("group", "a", { parentId: p.id, x: 10, y: 0 });
    const b = node("group", "b", { parentId: p.id, x: 30, y: 20 });
    const c = node("group", "c", { x: 500, y: 500 });
    for (const n of [p, a, b, c]) { sym.nodes[n.id] = n; sym.layers.push(layer(n.id, n.name, 0)); }

    const shared = groupPlan(sym, [a.id, b.id], () => ({ x: 999, y: 999 }));
    expect(shared).toMatchObject({ parent: p.id, origin: { x: 20, y: 10 }, index: 1 });

    const mixed = groupPlan(sym, [a.id, c.id], (id) => (id === a.id ? { x: 110, y: 0 } : { x: 500, y: 500 }));
    expect(mixed).toMatchObject({ parent: null, origin: { x: 305, y: 250 } });
  });
});

describe("descendantsOf / withDescendants", () => {
  /** The quadratic walk it replaced, as the reference. */
  function reference(sym: { nodes: Record<string, { id: string; parentId: string | null }> }, id: string): string[] {
    const out: string[] = [];
    const walk = (at: string, depth: number) => {
      if (depth > 64) return;
      for (const n of Object.values(sym.nodes)) {
        if (n.parentId === at && !out.includes(n.id)) { out.push(n.id); walk(n.id, depth + 1); }
      }
    };
    walk(id, 0);
    return out;
  }

  it("matches the old walk on every node of both fixtures, order included", async () => {
    const { loadStickman } = await import("./fixtures/stickman");
    const { loadFixture } = await import("./fixtures/realProject");
    const { descendantsOf } = await import("@/core/doc/layerTree");
    const { isSymbol } = await import("@/core/doc/types");
    const projects = [(await loadStickman()).project, (await loadFixture()).project];
    let checked = 0;
    for (const project of projects) {
      for (const sym of Object.values(project.items)) {
        if (!isSymbol(sym)) continue;
        for (const id of Object.keys(sym.nodes)) {
          expect(descendantsOf(sym, id as never)).toEqual(reference(sym, id));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("withDescendants takes each node once, selection first", async () => {
    const { withDescendants } = await import("@/core/doc/layerTree");
    const { createSymbol, createNode: node } = await import("@/core/doc/defaults");
    const sym = createSymbol("s");
    const a = node("group", "a");
    const b = node("group", "b", { parentId: a.id });
    const c = node("group", "c", { parentId: b.id });
    for (const n of [a, b, c]) sym.nodes[n.id] = n;
    expect(withDescendants(sym, [b.id, a.id])).toEqual([b.id, c.id, a.id]);
  });
});
