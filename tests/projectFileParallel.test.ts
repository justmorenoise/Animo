import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { type AssetId, reseed } from "@/core/doc/ids";
import { createImageItem, createProject } from "@/core/doc/defaults";
import { AssetStore } from "@/app/AssetStore";
import { deserializeProject, RESTORE_PARALLEL, serializeProject } from "@/io/project/ProjectFile";
import { fillAssets } from "./helpers/assets";

beforeEach(() => reseed());
afterEach(() => vi.unstubAllGlobals());

/** A project with one image per name; the asset's bytes are the name, which is
 *  how the decoder stub below tells them apart. */
function projectWith(names: string[]) {
  const project = createProject("P");
  const store = new AssetStore();
  fillAssets(store, names.map((n) => [n, n] as [string, string]));
  for (const n of names) {
    const item = createImageItem(`img-${n}`, n as AssetId, 4, 4);
    project.items[item.id] = item;
    project.itemOrder.push(item.id);
  }
  return { project, store };
}

async function bytesOf(blob: Blob): Promise<ArrayBuffer> { return blob.arrayBuffer(); }

/** A decoder that takes `delay(name)` ms, fails for names starting with "bad",
 *  and counts how many run at once. */
function decoder(delay: (name: string) => number = () => 1) {
  const state = { live: 0, peak: 0, order: [] as string[] };
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
    const name = await blob.text();
    state.live++;
    state.peak = Math.max(state.peak, state.live);
    await new Promise((r) => setTimeout(r, delay(name)));
    state.live--;
    if (name.startsWith("bad")) throw new Error("cannot decode");
    state.order.push(name);
    return { width: 4, height: 4, close() {} };
  });
  return state;
}

describe("serializeProject", () => {
  it("indents project.json by default", async () => {
    decoder();
    const { project, store } = projectWith(["a"]);
    const zip = unzipSync(new Uint8Array(await bytesOf(await serializeProject(project, store))));
    expect(strFromU8(zip["project.json"]!)).toContain('\n  "');
  });

  it("writes it compact when asked, smaller, and reads back the same", async () => {
    decoder();
    const { project, store } = projectWith(["a", "b"]);
    const pretty = await serializeProject(project, store);
    const compact = await serializeProject(project, store, { pretty: false });
    expect(compact.size).toBeLessThan(pretty.size);

    const zip = unzipSync(new Uint8Array(await bytesOf(compact)));
    expect(strFromU8(zip["project.json"]!)).not.toContain("\n");

    const back = await deserializeProject(await bytesOf(compact), new AssetStore());
    expect(back.project).toEqual(project);
  });

  it("writes every image the library uses, once", async () => {
    const { project, store } = projectWith(["a", "b", "c"]);
    const zip = unzipSync(new Uint8Array(await bytesOf(await serializeProject(project, store))));
    expect(Object.keys(zip).filter((p) => p.startsWith("assets/")).sort()).toEqual(["assets/a.png", "assets/b.png", "assets/c.png"]);
    expect(strFromU8(zip["assets/b.png"]!)).toBe("b");
  });

  it("leaves out an image the store has lost and one nobody uses", async () => {
    const { project, store } = projectWith(["a", "b"]);
    // `remove` closes real bitmaps; Node has no ImageBitmap class.
    vi.stubGlobal("ImageBitmap", class {});
    store.remove("b" as AssetId);
    fillAssets(store, [["unused", "u"]], { keep: true });
    const zip = unzipSync(new Uint8Array(await bytesOf(await serializeProject(project, store))));
    expect(Object.keys(zip).filter((p) => p.startsWith("assets/"))).toEqual(["assets/a.png"]);
  });
});

describe("deserializeProject restoring images", () => {
  async function fileOf(names: string[]) {
    const { project, store } = projectWith(names);
    return bytesOf(await serializeProject(project, store));
  }

  it("brings every image back under its own id and name", async () => {
    decoder();
    const names = Array.from({ length: 14 }, (_, i) => `img${i}`);
    const assets = new AssetStore();
    const { diagnostics } = await deserializeProject(await fileOf(names), assets);
    expect(diagnostics).toEqual([]);
    expect(assets.all().map((a) => a.id).sort()).toEqual([...names].sort());
    expect(assets.get("img3" as AssetId)!.name).toBe("img-img3");
  });

  it("decodes several at once, and no more than the limit", async () => {
    const state = decoder(() => 4);
    await deserializeProject(await fileOf(Array.from({ length: 20 }, (_, i) => `i${i}`)), new AssetStore());
    expect(state.peak).toBeGreaterThan(1);
    expect(state.peak).toBeLessThanOrEqual(RESTORE_PARALLEL);
  });

  it("works with fewer images than the limit, and with none", async () => {
    decoder();
    const two = new AssetStore();
    await deserializeProject(await fileOf(["a", "b"]), two);
    expect(two.all()).toHaveLength(2);
    const none = new AssetStore();
    const { diagnostics } = await deserializeProject(await fileOf([]), none);
    expect(none.all()).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("keeps the warnings in manifest order whichever image finishes first", async () => {
    // The first bad image is the slowest to fail, the last the fastest.
    decoder((n) => (n === "bad1" ? 30 : n === "bad3" ? 1 : 5));
    const assets = new AssetStore();
    const { diagnostics } = await deserializeProject(await fileOf(["bad1", "ok", "bad2", "bad3"]), assets);
    expect(diagnostics.map((d) => d.path)).toEqual(["assets.bad1", "assets.bad2", "assets.bad3"]);
    expect(assets.all().map((a) => a.id)).toEqual(["ok"]);
  });

  it("reports an image the archive does not hold, and loads the rest", async () => {
    decoder();
    const { project, store } = projectWith(["a", "b"]);
    const zip = unzipSync(new Uint8Array(await bytesOf(await serializeProject(project, store))));
    delete zip["assets/a.png"];
    const { zipSync } = await import("fflate");
    const data = zipSync(zip);
    const assets = new AssetStore();
    const { diagnostics } = await deserializeProject(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, assets);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain("missing from the archive");
    expect(assets.all().map((a) => a.id)).toEqual(["b"]);
  });

  it("reports progress from the start and never past the end", async () => {
    decoder();
    const seen: number[] = [];
    await deserializeProject(await fileOf(Array.from({ length: 9 }, (_, i) => `p${i}`)), new AssetStore(), (f) => seen.push(f));
    expect(seen[0]).toBe(0);
    expect(seen.every((f) => f >= 0 && f <= 1)).toBe(true);
    expect(Math.max(...seen)).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  });

  it("two ids holding the same pixels: the lowest id is the one a later import reuses, whatever finished first", async () => {
    // The first decode to start takes 20 ms and the second 1 ms, then the reverse.
    for (const delays of [[20, 1], [1, 20]]) {
      let call = 0;
      vi.stubGlobal("createImageBitmap", async () => {
        await new Promise((r) => setTimeout(r, delays[call++ % 2]));
        return { width: 4, height: 4, close() {} };
      });
      const { project, store } = projectWith(["b1", "a1"]);
      fillAssets(store, [["b1", "same"], ["a1", "same"]]);       // same bytes under both ids
      const assets = new AssetStore();
      await deserializeProject(await bytesOf(await serializeProject(project, store)), assets);
      expect(assets.all()).toHaveLength(2);
      expect((await assets.addFromBlob(new Blob(["same"]), "later")).id).toBe("a1");
    }
  });

  it("a name shared by two library items goes to the asset of the first", async () => {
    decoder();
    const { project, store } = projectWith(["a"]);
    const twin = createImageItem("second", "a" as AssetId, 4, 4);
    project.items[twin.id] = twin;
    const assets = new AssetStore();
    const { project: back } = await deserializeProject(await bytesOf(await serializeProject(project, store)), assets);
    expect(back.items[twin.id]).toBeDefined();
    expect(assets.get("a" as AssetId)!.name).toBe("img-a");
  });
});
