import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetStore } from "@/app/AssetStore";
import { AssetBatch } from "@/app/AssetBatch";
import { createImageItem, createProject } from "@/core/doc/defaults";
import { reseed } from "@/core/doc/ids";
import { Store } from "@/app/Store";

const layer = (name: string) => ({ kind: "image" as const, name, x: 0, y: 0, width: 2, height: 2, blob: new Blob([name]), visible: true });
vi.mock("@/io/import/psdReader", () => ({
  readPsdFile: async () => ({ name: "doc", width: 4, height: 4, warnings: [], children: [layer("eye"), layer("bad")] }),
}));

beforeEach(() => {
  reseed();
  vi.stubGlobal("ImageBitmap", class { close() {} });
  vi.stubGlobal("createImageBitmap", async (b: Blob) => {
    if ((await b.text()) === "bad") throw new Error("cannot decode");
    return { width: 2, height: 2, close() {} };
  });
});
afterEach(() => vi.unstubAllGlobals());

const png = (text: string) => new Blob([text]);

describe("AssetBatch", () => {
  it("gives back only what it brought, and nothing an image of the document uses", async () => {
    const assets = new AssetStore();
    const already = await assets.addFromBlob(png("old"), "old");
    const batch = new AssetBatch(assets);

    const same = await batch.addFromBlob(png("old"), "again");      // pixels already here: not its own
    const kept = await batch.addFromBlob(png("kept"), "kept");      // its own, but an item uses it
    const gone = await batch.addFromBlob(png("gone"), "gone");
    // Another import registers its own meanwhile, not through the batch.
    const other = await assets.addFromBlob(png("other"), "other");
    expect(same.id).toBe(already.id);

    const project = createProject("P");
    const item = createImageItem("kept", kept.id, 2, 2);
    project.items[item.id] = item;
    batch.release(project);

    expect(assets.all().map((a) => a.id).sort()).toEqual([already.id, kept.id, other.id].sort());
    expect(assets.get(gone.id)).toBeUndefined();
  });
});

describe("a PSD import that fails halfway", () => {
  it("gives back the layers it had registered and changes nothing", async () => {
    const { importPsd } = await import("@/app/PsdImport");
    const store = new Store();
    const assets = new AssetStore();
    await expect(importPsd(store, assets, new File([""], "doc.psd"))).rejects.toThrow();
    expect(assets.all()).toEqual([]);
    expect(store.history.canUndo).toBe(false);
  });
});
