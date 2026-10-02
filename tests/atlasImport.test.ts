import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetStore } from "@/app/AssetStore";
import { importAtlas } from "@/app/AtlasImport";
import { Store } from "@/app/Store";
import { createProject } from "@/core/doc/defaults";
import { type AssetId, reseed } from "@/core/doc/ids";
import { type AtlasRegion, regionCut } from "@/core/atlas/region";
import { buildAtlasImport, imageName, sequencesOf } from "@/core/doc/atlasImport";
import { evaluateSymbol } from "@/core/doc/pose";
import type { ImageItem } from "@/core/doc/types";

beforeEach(() => reseed());

/** Where `m` sends a point of the stored region (u along its width, v along its height). */
const at = (m: number[], u: number, v: number) => [m[0]! * u + m[2]! * v + m[4]!, m[1]! * u + m[3]! * v + m[5]!].map((x) => x + 0);
const region = (r: Partial<AtlasRegion>): AtlasRegion => ({
  name: "a", page: "p.png", x: 0, y: 0, w: 30, h: 40, rotation: 0, offsetX: 0, offsetY: 0, width: 30, height: 40, ...r,
});

describe("regionCut", () => {
  it("a trimmed region goes back to its offset in the untrimmed image", () => {
    const c = regionCut(region({ x: 7, y: 9, offsetX: 5, offsetY: 6, width: 50, height: 60 }));
    expect([c.width, c.height]).toEqual([50, 60]);
    expect(c.src).toEqual({ x: 7, y: 9, w: 30, h: 40 });
    expect(at(c.m, 0, 0)).toEqual([5, 6]);
    expect(at(c.m, 30, 40)).toEqual([35, 46]);
  });

  // An image 40 wide and 30 high, trimmed to itself, stored 30 wide and 40 high.
  it("turned clockwise: the image's top-left corner is the region's top-right", () => {
    const c = regionCut(region({ rotation: 90, width: 40, height: 30, offsetX: 2, offsetY: 3 }));
    expect(at(c.m, 30, 0)).toEqual([2, 3]);
    expect(at(c.m, 0, 0)).toEqual([2, 33]);
    expect(at(c.m, 30, 40)).toEqual([42, 3]);
  });

  it("turned counter-clockwise: the image's top-left corner is the region's bottom-left", () => {
    const c = regionCut(region({ rotation: -90, width: 40, height: 30, offsetX: 2, offsetY: 3 }));
    expect(at(c.m, 0, 40)).toEqual([2, 3]);
    expect(at(c.m, 0, 0)).toEqual([42, 3]);
    expect(at(c.m, 30, 40)).toEqual([2, 33]);
  });

  it("a page stored at half size is cut back to full size", () => {
    const c = regionCut(region({ offsetX: 5, width: 40 }), 0.5);
    expect([c.width, c.height]).toEqual([80, 80]);
    expect(at(c.m, 30, 40)).toEqual([70, 80]);
  });
});

describe("sequences", () => {
  it.each([
    [["walk_0002.png", "walk_0001.png", "walk_0010.png", "idle.png"], [{ name: "walk", frames: ["walk_0001.png", "walk_0002.png", "walk_0010.png"] }]],
    [["run/1", "run/2", "jump-01", "jump-02"], [{ name: "run", frames: ["run/1", "run/2"] }, { name: "jump", frames: ["jump-01", "jump-02"] }]],
    [["a1", "b1", "c1"], []],
    [["01", "02"], [{ name: "", frames: ["01", "02"] }]],
  ])("%j", (names, expected) => {
    expect(sequencesOf(names)).toEqual(expected);
  });

  it("an extension is not part of the name", () => {
    expect(["a.png", "b.JPG", "c.webp", "d.v2"].map(imageName)).toEqual(["a", "b", "c", "d.v2"]);
  });
});

describe("buildAtlasImport", () => {
  const img = (name: string, pivot?: { x: number; y: number }) => ({ name, assetId: name as AssetId, width: 20, height: 10, pivot });

  it("every image in one folder, named without its extension and apart from the library's names", () => {
    const r = buildAtlasImport("hero", "hero", [img("arm.png"), img("leg.png")], [], (n) => n === "arm");
    expect(r.folder).toMatchObject({ name: "hero", parentId: null });
    expect(r.items.map((i) => [i.name, i.folderId])).toEqual([["arm_2", r.folder.id], ["leg", r.folder.id]]);
  });

  it("a sequence is a symbol showing each frame in turn, holding a frame that repeats, about each frame's pivot", () => {
    const r = buildAtlasImport("hero", "hero", [img("w1", { x: 0, y: 1 }), img("w2"), img("w3")],
      [{ name: "walk", frames: ["w1", "w2", "w2", "w3", "w1"] }], () => false);
    const sym = r.symbols[0]!;
    expect(sym.name).toBe("walk");
    expect(sym.folderId).toBe(r.folder.id);
    const anim = sym.animations[0]!;
    expect([anim.name, anim.duration]).toEqual(["walk", 5]);
    const node = Object.values(sym.nodes)[0]!;
    expect(node.pivot).toEqual({ x: 0, y: 10 });
    expect(node.extraDisplays?.map((d) => d.pivot)).toEqual([{ x: 10, y: 5 }, { x: 10, y: 5 }]);
    expect(anim.tracks[node.id]!.keys.map((k) => [k.frame, k.displayIndex])).toEqual([[0, 0], [1, 1], [3, 2], [4, 0]]);
    const shown = [0, 1, 2, 3, 4].map((f) => {
      const e = evaluateSymbol(sym, anim, f).entries[0]!;
      return (r.items.find((i) => i.id === e.display!.itemId) as ImageItem).name;
    });
    expect(shown).toEqual(["w1", "w2", "w2", "w3", "w1"]);
  });

  it("a sequence named like an image, or with no name, gets a name of its own", () => {
    const r = buildAtlasImport("hero", "hero", [img("walk"), img("01"), img("02")],
      [{ name: "walk", frames: ["01", "02"] }, { name: "", frames: ["01", "02"] }], () => false);
    expect(r.symbols.map((s) => s.name)).toEqual(["walk_2", "hero"]);
  });
});

describe("importAtlas", () => {
  afterEach(() => vi.unstubAllGlobals());
  const blob = (s: string) => new Blob([s]);
  const decode = () => (vi.stubGlobal("ImageBitmap", class {}), vi.stubGlobal("createImageBitmap", async (b: Blob) => {
    if ((await b.text()).startsWith("bad")) throw new Error("cannot decode");
    return { width: 4, height: 4, close() {} };
  }));
  const setup = async () => {
    const project = createProject("Atlas");
    const store = new Store(project);
    const assets = new AssetStore();
    decode();
    const kept = await assets.addFromBlob(blob("same"), "kept");
    return { store, assets, kept };
  };
  const img = (name: string, content = name) => ({ name, blob: blob(content), width: 4, height: 4 });

  it("one undo step takes the folder, the images and the symbols away again", async () => {
    const { store, assets } = await setup();
    const before = Object.keys(store.project.items).length;
    const out = await importAtlas(store, assets, "hero", [img("w1.png"), img("w2.png")], [{ name: "walk", frames: ["w1.png", "w2.png"] }]);
    expect(out).toEqual({ folderName: "hero", images: 2, symbols: 1 });
    expect(Object.keys(store.project.items).length).toBe(before + 3);
    expect(store.selection.items.map((id) => store.project.items[id]!.name)).toEqual(["walk"]);
    store.history.undo();
    expect(Object.keys(store.project.items).length).toBe(before);
    expect(Object.values(store.project.folders)).toEqual([]);
  });

  it("an image that cannot be read takes back only the assets it added, not one it shared with the document", async () => {
    const { store, assets, kept } = await setup();
    await expect(importAtlas(store, assets, "hero", [img("a", "same"), img("b"), img("c", "bad")], [])).rejects.toThrow();
    expect(assets.all().map((a) => a.id)).toEqual([kept.id]);
    expect(Object.values(store.project.folders)).toEqual([]);
  });

  it("so does a failure once every image is in", async () => {
    const { store, assets, kept } = await setup();
    vi.spyOn(store, "transaction").mockImplementation(() => { throw new Error("broken"); });
    await expect(importAtlas(store, assets, "hero", [img("a", "same"), img("b")], [])).rejects.toThrow("broken");
    expect(assets.all().map((a) => a.id)).toEqual([kept.id]);
  });
});
