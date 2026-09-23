import { describe, it, expect, beforeEach } from "vitest";
import { reseed, type ItemId } from "@/core/doc/ids";
import { createProject, createSymbol, createNode, createLayer, createImageItem } from "@/core/doc/defaults";
import { isSymbol, type Project, type SymbolItem } from "@/core/doc/types";
import { tf } from "@/core/math/Transform";
import { TWEEN_LINEAR } from "@/core/math/easing";
import { evaluateSymbol, invalidateBounds } from "@/core/doc/pose";
import { displayAt } from "@/core/doc/displays";
import {
  ConvertToSymbol, DuplicateLibraryItem, wouldCreateCycle, symbolDepth,
} from "@/core/history/symbolCommands";
import { History } from "@/core/history/History";
import { RenameLibraryItem, SetBindTransform } from "@/core/history/commands";
import { exportSkeleton } from "@/core/export/exportSkeleton";
import type { AssetId } from "@/core/doc/ids";

beforeEach(() => { reseed(); invalidateBounds(); });

function scene() {
  const project = createProject("Sym");
  const root = project.items[project.rootSymbolId];
  if (!isSymbol(root)) throw new Error("no root");

  const img = createImageItem("arm", "asset_arm" as AssetId, 26, 96);
  project.items[img.id] = img;
  project.itemOrder.push(img.id);

  const make = (name: string, x: number, y: number) => {
    const n = createNode("image", name, { itemId: img.id, x, y, pivotX: 13, pivotY: 48 });
    root.nodes[n.id] = n;
    root.layers.unshift(createLayer(n.id, name, root.layers.length));
    return n;
  };
  const a = make("a", 340, 300);
  const b = make("b", 380, 300);
  const outside = make("outside", 600, 100);
  return { project, root, a, b, outside, img };
}

/** World matrices of every node, keyed by name. */
function worlds(project: Project, symId: ItemId) {
  const sym = project.items[symId];
  if (!isSymbol(sym)) throw new Error("not a symbol");
  const pose = evaluateSymbol(sym, null, 0, "setup");
  return new Map(pose.entries.map((e) => [e.node.name, e.world]));
}

describe("ConvertToSymbol", () => {
  it("moves the selection into a new symbol and leaves one instance", () => {
    const { project, root, a, b, outside } = scene();
    const cmd = new ConvertToSymbol(root.id, [a.id, b.id], "Arms");
    cmd.apply(project);

    expect(cmd.symbol?.name).toBe("Arms");
    // The host keeps only what was not selected, plus the instance.
    expect(root.layers.map((l) => l.name).sort()).toEqual(["Arms", "outside"]);
    expect(root.nodes[a.id]).toBeUndefined();
    expect(root.nodes[outside.id]).toBeDefined();

    const sym = cmd.symbol!;
    expect(Object.keys(sym.nodes).length).toBe(2);
    expect(sym.layers.map((l) => l.name).sort()).toEqual(["a", "b"]);
  });

  it("keeps the artwork exactly where it was", () => {
    const { project, root, a, b } = scene();
    const before = worlds(project, root.id);

    const cmd = new ConvertToSymbol(root.id, [a.id, b.id], "Arms");
    cmd.apply(project);
    invalidateBounds();

    // Inside the symbol, positions are relative to the instance's origin;
    // adding that origin back must give the original world position.
    const inside = worlds(project, cmd.symbol!.id);
    const origin = cmd.instance!.bind;
    for (const name of ["a", "b"]) {
      expect(inside.get(name)!.tx + origin.x).toBeCloseTo(before.get(name)!.tx, 6);
      expect(inside.get(name)!.ty + origin.y).toBeCloseTo(before.get(name)!.ty, 6);
    }
  });

  it("puts the registration point at the centre of the selection's artwork", () => {
    const { project, root, a, b } = scene();
    // a at x=340, b at x=380, both 26 wide with a centred pivot -> 327..393
    const cmd = new ConvertToSymbol(root.id, [a.id, b.id], "Arms");
    cmd.apply(project);
    expect(cmd.instance!.bind.x).toBe(360);
    expect(cmd.instance!.bind.y).toBe(300);
  });

  it("carries animation across, rebased to the new origin", () => {
    const { project, root, a } = scene();
    const anim = root.animations[0]!;
    anim.tracks[a.id] = {
      nodeId: a.id, endFrame: 23,
      keys: [
        { frame: 0, transform: tf(340, 300), displayIndex: 0, tween: TWEEN_LINEAR },
        { frame: 12, transform: tf(400, 300), displayIndex: 0, tween: TWEEN_LINEAR },
      ],
    };

    const cmd = new ConvertToSymbol(root.id, [a.id], "Arm");
    cmd.apply(project);

    expect(anim.tracks[a.id]).toBeUndefined();          // gone from the host
    const moved = cmd.symbol!.animations[0]!.tracks[a.id]!;
    const originX = cmd.instance!.bind.x;
    expect(moved.keys[0]!.transform.x).toBeCloseTo(340 - originX, 6);
    expect(moved.keys[1]!.transform.x).toBeCloseTo(400 - originX, 6);
  });

  it("takes whole subtrees, never half of one", () => {
    const { project, root, a, b } = scene();
    b.parentId = a.id;                                   // b is a child of a
    const cmd = new ConvertToSymbol(root.id, [a.id], "Arm");
    cmd.apply(project);
    expect(Object.keys(cmd.symbol!.nodes).length).toBe(2);
    // The child keeps its parent link and its untouched local transform.
    expect(cmd.symbol!.nodes[b.id]!.parentId).toBe(a.id);
    expect(cmd.symbol!.nodes[b.id]!.bind.x).toBe(380);
  });

  it("undo puts everything back", () => {
    const { project, root, a, b } = scene();
    const before = JSON.parse(JSON.stringify(project));

    const cmd = new ConvertToSymbol(root.id, [a.id, b.id], "Arms");
    cmd.apply(project);
    cmd.revert(project);

    expect(JSON.parse(JSON.stringify(project))).toEqual(before);
  });

  it("exports the instance as a child armature", () => {
    const { project, root, a, b } = scene();
    new ConvertToSymbol(root.id, [a.id, b.id], "Arms").apply(project);

    const { skeleton, diagnostics } = exportSkeleton(project);
    expect(diagnostics).toEqual([]);
    const child = skeleton.armature.find((x) => x.name === "Arms")!;
    const host = skeleton.armature.find((x) => x.name === "Scene 1")!;

    // Dependencies come first, and the child auto-plays or it sits frozen.
    expect(skeleton.armature.indexOf(child)).toBeLessThan(skeleton.armature.indexOf(host));
    expect(child.defaultActions?.[0]?.gotoAndPlay).toBeTruthy();

    const display = host.skin[0]!.slot.find((sl) => sl.name === "Arms")!.display[0]!;
    expect(display).toMatchObject({ name: "Arms", type: "armature" });
    // A nested armature has no image to normalise a pivot against.
    expect(display.pivot).toBeUndefined();
  });
});

describe("cycle prevention", () => {
  /** A project with an extra, empty symbol in the library. */
  function withSymbol(name: string) {
    const project = createProject("N");
    const root = project.items[project.rootSymbolId] as SymbolItem;
    const sym = createSymbol(name);
    project.items[sym.id] = sym;
    project.itemOrder.push(sym.id);
    return { project, root, sym };
  }

  /** Place an instance of `itemId` inside `host`. */
  function instantiate(host: SymbolItem, itemId: ItemId, name: string) {
    const n = createNode("symbol", name, { itemId });
    host.nodes[n.id] = n;
    host.layers.push(createLayer(n.id, name, host.layers.length));
    return n;
  }

  it("refuses a symbol inside itself", () => {
    const { project, root } = withSymbol("Mid");
    expect(wouldCreateCycle(project, root.id, root.id)).toBe(true);
  });

  it("refuses a symbol that transitively contains the host", () => {
    const { project, root, sym } = withSymbol("Mid");
    instantiate(sym, root.id, "root_instance");        // Mid contains Root

    // So Mid cannot go inside Root.
    expect(wouldCreateCycle(project, root.id, sym.id)).toBe(true);
    // A symbol that contains nothing relevant is fine.
    const { project: p2, root: r2, sym: s2 } = withSymbol("Free");
    expect(wouldCreateCycle(p2, r2.id, s2.id)).toBe(false);
  });

  it("treats pathological nesting as a cycle rather than recursing", () => {
    const { project, root, sym } = withSymbol("Self");
    instantiate(sym, sym.id, "self");                  // hand-edited file
    expect(wouldCreateCycle(project, root.id, sym.id)).toBe(true);
  });

  it("measures nesting depth", () => {
    const { project, root, sym } = withSymbol("Child");
    expect(symbolDepth(project, root.id)).toBe(0);
    instantiate(root, sym.id, "child_1");
    expect(symbolDepth(project, root.id)).toBe(1);
  });
});

describe("DuplicateLibraryItem", () => {
  it("shares the asset when duplicating an image", async () => {
    const { DuplicateLibraryItem } = await import("@/core/history/symbolCommands");
    const { project, img } = scene();

    const cmd = new DuplicateLibraryItem(img.id, "arm_copy");
    cmd.apply(project);

    const copy = project.items[cmd.newItemId!]!;
    expect(copy.kind).toBe("image");
    expect(copy.name).toBe("arm_copy");
    expect(copy.id).not.toBe(img.id);
    // The pixels are not duplicated, only the library entry.
    expect(copy.kind === "image" && copy.assetId).toBe(img.assetId);
  });

  it("deep copies a symbol so editing the copy cannot reach the original", async () => {
    const { DuplicateLibraryItem } = await import("@/core/history/symbolCommands");
    const { project, root, a, b } = scene();
    const conv = new ConvertToSymbol(root.id, [a.id, b.id], "Arms");
    conv.apply(project);
    const source = conv.symbol!;

    const cmd = new DuplicateLibraryItem(source.id, "Arms_2");
    cmd.apply(project);
    const copy = project.items[cmd.newItemId!]!;
    if (!isSymbol(copy)) throw new Error("expected a symbol");

    expect(copy.layers.length).toBe(source.layers.length);
    // Fresh ids throughout, or the two would share nodes.
    const sourceIds = new Set(Object.keys(source.nodes));
    for (const id of Object.keys(copy.nodes)) expect(sourceIds.has(id)).toBe(false);

    const firstCopy = copy.nodes[copy.layers[0]!.nodeId]!;
    firstCopy.bind.x = 9999;
    const firstSource = source.nodes[source.layers[0]!.nodeId]!;
    expect(firstSource.bind.x).not.toBe(9999);
  });

  it("undo removes the duplicate", async () => {
    const { DuplicateLibraryItem } = await import("@/core/history/symbolCommands");
    const { project, img } = scene();
    const before = project.itemOrder.length;

    const cmd = new DuplicateLibraryItem(img.id, "copy");
    cmd.apply(project);
    expect(project.itemOrder.length).toBe(before + 1);
    cmd.revert(project);
    expect(project.itemOrder.length).toBe(before);
    expect(project.items[cmd.newItemId!]).toBeUndefined();
  });
});

describe("empty symbol instances", () => {
  it("get a placeholder box, so they can be seen and selected", async () => {
    const { localBox, isEmptySymbolInstance, EMPTY_SYMBOL_SIZE, invalidateBounds: inv } =
      await import("@/core/doc/pose");
    const { project, root } = scene();
    inv();

    const empty = createSymbol("Empty");
    project.items[empty.id] = empty;
    project.itemOrder.push(empty.id);
    const node = createNode("symbol", "empty_1", { itemId: empty.id });
    root.nodes[node.id] = node;
    root.layers.unshift(createLayer(node.id, "empty_1", 0));

    expect(isEmptySymbolInstance(project, displayAt(node, 0))).toBe(true);
    const box = localBox(project, node.itemId, node.pivot);
    // Without this, the instance has no bounds: nothing draws it and nothing
    // can click it, so it looks like the drop did nothing at all.
    expect(box).not.toBeNull();
    expect(box!.w).toBe(EMPTY_SYMBOL_SIZE);
    expect(box!.h).toBe(EMPTY_SYMBOL_SIZE);
  });

  it("a symbol with content reports its real bounds, not the placeholder", async () => {
    const { localBox, isEmptySymbolInstance, invalidateBounds: inv } = await import("@/core/doc/pose");
    const { project, root, a, b } = scene();
    const conv = new ConvertToSymbol(root.id, [a.id, b.id], "Arms");
    conv.apply(project);
    inv();

    const instance = conv.instance!;
    expect(isEmptySymbolInstance(project, displayAt(instance, 0))).toBe(false);
    const box = localBox(project, instance.itemId, instance.pivot)!;
    expect(box.w).toBeGreaterThan(60);        // two 26px arms, 40px apart
  });
});

describe("redo keeps the ids later steps refer to", () => {
  it("Convert to Symbol recreates the SAME symbol and instance", () => {
    const { project, root, a, b } = scene();
    const history = new History(project);
    const cmd = new ConvertToSymbol(root.id, [a.id, b.id], "Arms");
    history.apply(cmd);
    const symbolId = cmd.symbol!.id;
    const instanceId = cmd.instance!.id;
    history.apply(new SetBindTransform(root.id, new Map([[instanceId, tf(500, 500)]])));

    history.undo();
    history.undo();
    expect(project.items[symbolId]).toBeUndefined();
    history.redo();
    history.redo();

    expect(isSymbol(project.items[symbolId])).toBe(true);
    expect(root.nodes[instanceId]?.bind.x).toBe(500);
    expect(root.layers.filter((l) => l.nodeId === instanceId)).toHaveLength(1);
  });

  it("Duplicate recreates the SAME library item", () => {
    const { project, img } = scene();
    const history = new History(project);
    const cmd = new DuplicateLibraryItem(img.id, "arm_copy");
    history.apply(cmd);
    const copyId = cmd.newItemId!;
    history.apply(new RenameLibraryItem(copyId, "arm_renamed"));

    history.undo();
    history.undo();
    history.redo();
    history.redo();
    expect(project.items[copyId]?.name).toBe("arm_renamed");
    expect(project.itemOrder.filter((id) => id === copyId)).toHaveLength(1);
  });

  it("Duplicate re-points mask links at the copy's own layers", () => {
    const { project, root, a, b } = scene();
    const conv = new ConvertToSymbol(root.id, [a.id, b.id], "Masked");
    conv.apply(project);
    const source = conv.symbol!;
    const [maskLayer, clipped] = source.layers;
    maskLayer!.isMask = true;
    clipped!.maskedBy = maskLayer!.id;

    const cmd = new DuplicateLibraryItem(source.id, "Masked_2");
    cmd.apply(project);
    const copy = project.items[cmd.newItemId!] as SymbolItem;
    expect(copy.layers[0]!.isMask).toBe(true);
    expect(copy.layers[1]!.maskedBy).toBe(copy.layers[0]!.id);
    expect(copy.layers[1]!.maskedBy).not.toBe(maskLayer!.id);
  });
});

describe("renaming a library item", () => {
  it("knows when the name is taken by another item, and not by itself", () => {
    const { project, img } = scene();
    expect(RenameLibraryItem.clashes(project, img.id, "arm")).toBe(false);
    expect(RenameLibraryItem.clashes(project, img.id, "Scene 1")).toBe(true);
    expect(RenameLibraryItem.clashes(project, img.id, "hand")).toBe(false);
  });
});
