import { describe, it, expect, beforeEach } from "vitest";
import { reseed, newIkId, type AssetId } from "@/core/doc/ids";
import { createProject, createImageItem, createNode, createLayer } from "@/core/doc/defaults";
import { isSymbol, DOC_VERSION, type Project, type SymbolItem } from "@/core/doc/types";
import { tf } from "@/core/math/Transform";
import { TWEEN_LINEAR } from "@/core/math/easing";
import { serializeProject, deserializeProject } from "@/io/project/ProjectFile";
import { validateProject, migrate } from "@/core/doc/schema";
import { exportSkeleton } from "@/core/export/exportSkeleton";
import type { AssetStore } from "@/app/AssetStore";

beforeEach(() => reseed());

/**
 * A stand-in for AssetStore. ProjectFile only needs blobs in and blobs out;
 * decoding is the browser's job and is not what this test is about.
 */
function fakeAssets() {
  const map = new Map<string, { id: string; name: string; blob: Blob; width: number; height: number }>();
  return {
    store: {
      get: (id: string) => map.get(id),
      clear: () => map.clear(),
      addWithId: async (id: string, blob: Blob, name: string) => {
        const asset = { id, name, blob, width: 10, height: 10 };
        map.set(id, asset);
        return asset;
      },
    } as unknown as AssetStore,
    seed(id: string, bytes: number[]) {
      map.set(id, {
        id, name: id,
        blob: new Blob([new Uint8Array(bytes)], { type: "image/png" }),
        width: 10, height: 10,
      });
    },
    size: () => map.size,
    bytesOf: async (id: string) =>
      Array.from(new Uint8Array(await map.get(id)!.blob.arrayBuffer())),
  };
}

/** A project with two images, a nested-ish hierarchy and an animation. */
function richProject(assets: ReturnType<typeof fakeAssets>): Project {
  const project = createProject("Round Trip");
  const sym = project.items[project.rootSymbolId] as SymbolItem;

  const used: string[] = [];
  for (const name of ["torso", "head"]) {
    const assetId = `asset_${name}` as AssetId;
    assets.seed(assetId, [0x89, 0x50, 0x4e, 0x47, name.length]);
    const item = createImageItem(name, assetId, 90, 130);
    project.items[item.id] = item;
    project.itemOrder.push(item.id);
    used.push(item.id);
  }

  const torso = createNode("image", "torso", { itemId: used[0] as never, x: 400, y: 300, pivotX: 45, pivotY: 65 });
  const head = createNode("image", "head", { itemId: used[1] as never, x: 400, y: 205, pivotX: 37, pivotY: 37 });
  head.parentId = torso.id;
  sym.nodes[torso.id] = torso;
  sym.nodes[head.id] = head;
  sym.layers = [createLayer(head.id, "head", 0), createLayer(torso.id, "torso", 1)];

  const anim = sym.animations[0]!;
  anim.duration = 24;
  anim.tracks[head.id] = {
    nodeId: head.id,
    endFrame: 23,
    keys: [
      { frame: 0, transform: tf(400, 205), displayIndex: 0, tween: TWEEN_LINEAR },
      { frame: 12, transform: tf(400, 175, 20, 10), displayIndex: 0, tween: TWEEN_LINEAR, rotateTurns: 1 },
      { frame: 23, transform: tf(400, 205), displayIndex: -1, tween: { kind: "none" } },
    ],
  };
  return project;
}

describe("project round trip", () => {
  it("preserves the document exactly", async () => {
    const assets = fakeAssets();
    const project = richProject(assets);
    const before = JSON.parse(JSON.stringify(project));

    const blob = await serializeProject(project, assets.store);
    const { project: loaded, diagnostics } = await deserializeProject(
      await blob.arrayBuffer(), assets.store,
    );

    expect(diagnostics).toEqual([]);
    expect(JSON.parse(JSON.stringify(loaded))).toEqual(before);
  });

  it("restores assets under their original ids, so references still resolve", async () => {
    const assets = fakeAssets();
    const project = richProject(assets);
    const originalBytes = await assets.bytesOf("asset_torso");

    const blob = await serializeProject(project, assets.store);
    assets.store.clear();
    await deserializeProject(await blob.arrayBuffer(), assets.store);

    expect(assets.size()).toBe(2);
    expect(await assets.bytesOf("asset_torso")).toEqual(originalBytes);
  });

  it("produces a byte-identical export after a round trip", async () => {
    // The strongest check available without a browser: if saving and loading
    // altered anything the runtime cares about, the two skeletons diverge.
    const assets = fakeAssets();
    const project = richProject(assets);
    const exportBefore = JSON.stringify(exportSkeleton(project).skeleton);

    const blob = await serializeProject(project, assets.store);
    const { project: loaded } = await deserializeProject(await blob.arrayBuffer(), assets.store);
    const exportAfter = JSON.stringify(exportSkeleton(loaded).skeleton);

    expect(exportAfter).toBe(exportBefore);
  });

  it("only stores assets the document still uses", async () => {
    const assets = fakeAssets();
    const project = richProject(assets);
    assets.seed("asset_orphan" as AssetId, [1, 2, 3]);      // imported then deleted

    const blob = await serializeProject(project, assets.store);
    assets.store.clear();
    await deserializeProject(await blob.arrayBuffer(), assets.store);

    expect(assets.size()).toBe(2);
  });

  it("explains itself when handed something that is not a project", async () => {
    const assets = fakeAssets();
    const notAZip = new Uint8Array([1, 2, 3, 4]).buffer;
    await expect(deserializeProject(notAZip, assets.store)).rejects.toThrow();
  });
});

describe("schema validation", () => {
  const base = () => {
    const p = createProject("V");
    const sym = p.items[p.rootSymbolId] as SymbolItem;
    const n = createNode("image", "a", {});
    sym.nodes[n.id] = n;
    sym.layers = [createLayer(n.id, "a", 0)];
    return { p, sym, n };
  };

  it("refuses a file from a newer version rather than mangling it", () => {
    const { p } = base();
    p.version = 999;
    expect(() => validateProject(p)).toThrow(/version 999/);
  });

  it("drops layers whose object is gone and warns", () => {
    const { p, sym } = base();
    sym.layers.push(createLayer("ghost" as never, "ghost", 1));
    const { project, diagnostics } = validateProject(p);
    const root = project.items[project.rootSymbolId];
    expect(isSymbol(root) && root.layers.length).toBe(1);
    expect(diagnostics.some((d) => /missing object/.test(d.message))).toBe(true);
  });

  it("cuts a parent chain that loops instead of hanging", () => {
    const { p, sym, n } = base();
    const m = createNode("image", "b", {});
    sym.nodes[m.id] = m;
    sym.layers.push(createLayer(m.id, "b", 1));
    n.parentId = m.id;
    m.parentId = n.id;                       // a loop

    const { project, diagnostics } = validateProject(p);
    const root = project.items[project.rootSymbolId] as SymbolItem;
    const parents = Object.values(root.nodes).map((x) => x.parentId);
    expect(parents.filter(Boolean).length).toBeLessThan(2);
    expect(diagnostics.some((d) => /looped back/.test(d.message))).toBe(true);
  });

  it("cuts only the loop, not a node whose chain runs into it", () => {
    const { p, sym, n } = base();
    const [b, c] = ["b", "c"].map((name, i) => {
      const x = createNode("group", name, {});
      sym.nodes[x.id] = x;
      sym.layers.push(createLayer(x.id, name, i + 1));
      return x;
    });
    n.parentId = b!.id;                      // a → b → c → b
    b!.parentId = c!.id;
    c!.parentId = b!.id;

    const { project } = validateProject(p);
    const root = project.items[project.rootSymbolId] as SymbolItem;
    expect(root.nodes[n.id]!.parentId).toBe(b!.id);
    expect([root.nodes[b!.id]!.parentId, root.nodes[c!.id]!.parentId].filter(Boolean)).toHaveLength(1);
  });

  it("lengthens an animation its tracks run past", () => {
    const { p, sym, n } = base();
    const anim = sym.animations[0]!;
    anim.duration = 30;
    anim.tracks[n.id] = {
      nodeId: n.id, endFrame: 50,
      keys: [{ frame: 0, transform: tf(), displayIndex: 0, tween: TWEEN_LINEAR }],
    };
    const { project, diagnostics } = validateProject(p);
    expect((project.items[project.rootSymbolId] as SymbolItem).animations[0]!.duration).toBe(51);
    expect(diagnostics.some((d) => /now lasts 51/.test(d.message))).toBe(true);
  });

  it("says so when it clears a mask link", () => {
    const { p, sym, n } = base();
    sym.layers[0]!.maskedBy = "gone" as never;
    const { diagnostics } = validateProject(p);
    expect(sym.layers.find((l) => l.nodeId === n.id)!.maskedBy).toBeUndefined();
    expect(diagnostics.some((d) => /mask setting/.test(d.message))).toBe(true);
  });

  it("gives an armature with no animations one, so it can still play", () => {
    const { p, sym } = base();
    sym.animations = [];
    const { project, diagnostics } = validateProject(p);
    const root = project.items[project.rootSymbolId] as SymbolItem;
    expect(root.animations.length).toBe(1);
    expect(diagnostics.some((d) => /no animations/.test(d.message))).toBe(true);
  });

  it("clamps nonsense numbers to something usable", () => {
    const { p } = base();
    p.frameRate = -5 as never;
    p.stage.width = 0 as never;
    const { project } = validateProject(p);
    expect(project.frameRate).toBe(1);
    expect(project.stage.width).toBe(1);
  });

  it("keeps new IK ids clear of the ones already in the file", () => {
    const { p, sym, n } = base();
    const t = createNode("bone", "t", {});
    sym.nodes[t.id] = t;
    sym.layers.push(createLayer(t.id, "t", 1));
    sym.ik.push({
      id: "kzz" as never, name: "ik", boneId: n.id, targetId: t.id,
      chain: 0, bendPositive: true, weight: 1,
    });
    reseed();
    validateProject(p);
    expect(parseInt(newIkId().slice(1), 36)).toBeGreaterThan(parseInt("zz", 36));
  });

  it("repairs two keyframes on one frame, which the frame algebra cannot hold", () => {
    const { p, sym, n } = base();
    sym.animations[0]!.tracks[n.id] = {
      nodeId: n.id, endFrame: 20,
      keys: [
        { frame: 0, transform: tf(0, 0), displayIndex: 0, tween: TWEEN_LINEAR },
        { frame: 10, transform: tf(1, 0), displayIndex: 0, tween: TWEEN_LINEAR },
        { frame: 10, transform: tf(2, 0), displayIndex: 0, tween: TWEEN_LINEAR },
      ],
    };
    const { project, diagnostics } = validateProject(p);
    const track = (project.items[project.rootSymbolId] as SymbolItem).animations[0]!.tracks[n.id]!;
    expect(track.keys.map((k) => k.frame)).toEqual([0, 10]);
    expect(diagnostics.some((d) => /same frame/.test(d.message))).toBe(true);
  });

  it("drops a mask link that points at a layer the symbol does not have", () => {
    const { p, sym } = base();
    sym.layers[0]!.maskedBy = "l_gone" as never;
    const { project } = validateProject(p);
    expect((project.items[project.rootSymbolId] as SymbolItem).layers[0]!.maskedBy).toBeUndefined();
  });

  it("stamps a version onto files written before there was one", () => {
    // The chain runs every step, so an unversioned file lands on the current
    // version rather than on the first one.
    const migrated = migrate({ name: "old" }) as { version: number };
    expect(migrated.version).toBe(DOC_VERSION);
  });
});

describe("document settings", () => {
  it("changes frame rate and stage, and undoes as one step", async () => {
    const { SetDocumentSettings } = await import("@/core/history/commands");
    const project = createProject("Doc");
    const before = { fps: project.frameRate, stage: { ...project.stage } };

    const cmd = new SetDocumentSettings({ frameRate: 30, width: 1280, height: 720 });
    cmd.apply(project);
    expect(project.frameRate).toBe(30);
    expect(project.stage).toMatchObject({ width: 1280, height: 720 });

    cmd.revert(project);
    expect(project.frameRate).toBe(before.fps);
    expect(project.stage).toEqual(before.stage);
  });

  it("renames the project, and refuses a blank name", async () => {
    const { SetDocumentSettings } = await import("@/core/history/commands");
    const project = createProject("Doc");

    const rename = new SetDocumentSettings({ name: "  Walker  " });
    rename.apply(project);
    expect(project.name).toBe("Walker");

    // The name is the export file stem; blank would produce "_ske.json".
    new SetDocumentSettings({ name: "   " }).apply(project);
    expect(project.name).toBe("Walker");

    rename.revert(project);
    expect(project.name).toBe("Doc");
  });

  it("names the export after the project, made file-safe", async () => {
    const { safeFileName } = await import("@/io/export/ExportBundle");
    expect(safeFileName("Dragon Boss v2")).toBe("Dragon_Boss_v2");
    expect(safeFileName("  ../weird//name  ")).toBe("weird_name");
    expect(safeFileName("***")).toBe("project");
  });

  it("clamps values that would break the document", async () => {
    const { SetDocumentSettings } = await import("@/core/history/commands");
    const project = createProject("Doc");

    new SetDocumentSettings({ frameRate: 0, width: -5, height: 999999 }).apply(project);
    expect(project.frameRate).toBe(1);
    expect(project.stage.width).toBe(1);
    expect(project.stage.height).toBe(16384);
  });

  it("survives a save and reload", async () => {
    const { SetDocumentSettings } = await import("@/core/history/commands");
    const assets = fakeAssets();
    const project = richProject(assets);
    new SetDocumentSettings({ frameRate: 30, width: 1280, height: 720, background: "#101820" })
      .apply(project);

    const blob = await serializeProject(project, assets.store);
    const { project: loaded } = await deserializeProject(await blob.arrayBuffer(), assets.store);

    expect(loaded.frameRate).toBe(30);
    expect(loaded.stage).toEqual({ width: 1280, height: 720, background: "#101820" });
  });
});
