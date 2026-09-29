import { describe, expect, it, vi } from "vitest";
import { type AssetId } from "@/core/doc/ids";
import { createImageItem } from "@/core/doc/defaults";
import { AssetStore } from "@/app/AssetStore";
import { DEFAULT_ATLAS, pretrim } from "@/io/atlas/AtlasBuilder";
import { type PoolWorker, WorkerPool } from "@/io/workers/WorkerPool";
import { type TrimReply, type TrimRequest, trimOffThread, trimRequest, trimWith } from "@/io/workers/trim";
import { fillAssets } from "./helpers/assets";

/** RGBA pixels with opaque pixels only where `on(x, y)`. */
function pixels(w: number, h: number, on: (x: number, y: number) => boolean) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y)) data[(y * w + x) * 4 + 3] = 255;
  return { width: w, height: h, data };
}

describe("trimRequest", () => {
  it("finds the box of the opaque pixels", async () => {
    const px = pixels(10, 8, (x, y) => x >= 2 && x <= 5 && y >= 1 && y <= 3);
    const out = await trimRequest({ blob: new Blob(["x"]), threshold: 0 }, async () => px);
    expect(out).toMatchObject({ width: 10, height: 8, trim: { x: 2, y: 1, width: 4, height: 3, untrimmed: false } });
  });

  it("honours the alpha threshold", async () => {
    const px = pixels(4, 4, () => false);
    px.data[(1 * 4 + 1) * 4 + 3] = 20;                        // faint pixel
    const loose = await trimRequest({ blob: new Blob(), threshold: 0 }, async () => px);
    const strict = await trimRequest({ blob: new Blob(), threshold: 20 }, async () => px);
    expect(loose.trim).toMatchObject({ x: 1, y: 1, width: 1, height: 1 });
    expect(strict.trim).toMatchObject({ width: 1, height: 1, x: 0, y: 0 });     // nothing left: a 1x1 stand-in
  });

  it("reports an image with nothing to trim as untrimmed", async () => {
    const px = pixels(3, 3, () => true);
    expect((await trimRequest({ blob: new Blob(), threshold: 0 }, async () => px)).trim.untrimmed).toBe(true);
  });

  it("hands the blob it was given to the decoder, and lets its failure through", async () => {
    const blob = new Blob(["png"]);
    const decode = vi.fn(async () => { throw new Error("cannot decode"); });
    await expect(trimRequest({ blob, threshold: 0 }, decode)).rejects.toThrow("cannot decode");
    expect(decode).toHaveBeenCalledWith(blob);
  });
});

class FakeWorker implements PoolWorker {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminate() {}
  constructor(private readonly mode: "ok" | "crash" | "fail") {}
  postMessage(): void {
    setTimeout(() => {
      if (this.mode === "crash") this.onerror?.({ message: "boom", preventDefault() {} } as ErrorEvent);
      else if (this.mode === "fail") this.onmessage?.({ data: { ok: false, error: "bad picture" } } as MessageEvent);
      else this.onmessage?.({ data: { ok: true, value: { trim: { x: 1, y: 2, width: 3, height: 4, untrimmed: false }, width: 8, height: 8 } } } as MessageEvent);
    }, 1);
  }
}

const poolOf = (mode: "ok" | "crash" | "fail") =>
  new WorkerPool<TrimRequest, TrimReply>(() => new FakeWorker(mode), 2);

describe("trimWith", () => {
  it("returns what the worker found", async () => {
    const out = await trimWith(poolOf("ok"), new Blob(), 0);
    expect(out).toMatchObject({ width: 8, trim: { x: 1, y: 2, width: 3, height: 4 } });
  });

  it("is null without a pool", async () => {
    expect(await trimWith(null, new Blob(), 0)).toBeNull();
  });

  it("gives the pool up and answers null when a worker dies, so the page trims instead", async () => {
    const drop = vi.fn();
    expect(await trimWith(poolOf("crash"), new Blob(), 0, drop)).toBeNull();
    expect(drop).toHaveBeenCalledTimes(1);
  });

  it("lets a real failure through: a picture that cannot be read is not a missing worker", async () => {
    const drop = vi.fn();
    await expect(trimWith(poolOf("fail"), new Blob(), 0, drop)).rejects.toThrow("bad picture");
    expect(drop).not.toHaveBeenCalled();
  });

  it("trimOffThread is null where there are no workers", async () => {
    expect(await trimOffThread(new Blob(), 0)).toBeNull();
  });
});

describe("pretrim", () => {
  function setup(sizes: Array<[string, number, number]> = [["s1", 8, 8], ["s2", 8, 8]]) {
    const assets = new AssetStore();
    fillAssets(assets, sizes.map(([id]) => [id, id] as [string, string]));
    const items = sizes.map(([id, w, h]) => createImageItem(`img-${id}`, id as AssetId, w, h));
    return { assets, items };
  }
  const reply = (w: number, h: number): TrimReply =>
    ({ trim: { x: 1, y: 1, width: w - 2, height: h - 2, untrimmed: false }, width: w, height: h });

  it("asks once per image, all at the same time", async () => {
    const { assets, items } = setup();
    let live = 0, peak = 0;
    const trimmer = vi.fn(async () => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 2));
      live--;
      return reply(8, 8);
    });
    await pretrim(items, assets, DEFAULT_ATLAS, trimmer);
    expect(trimmer).toHaveBeenCalledTimes(2);
    expect(peak).toBe(2);
  });

  it("remembers the answers: a second build asks nothing", async () => {
    const { assets, items } = setup();
    const trimmer = vi.fn(async () => reply(8, 8));
    await pretrim(items, assets, DEFAULT_ATLAS, trimmer);
    trimmer.mockClear();
    await pretrim(items, assets, DEFAULT_ATLAS, trimmer);
    expect(trimmer).not.toHaveBeenCalled();
  });

  it("asks again when the threshold changes", async () => {
    const { assets, items } = setup();
    const trimmer = vi.fn(async () => reply(8, 8));
    await pretrim(items, assets, DEFAULT_ATLAS, trimmer);
    trimmer.mockClear();
    await pretrim(items, assets, { ...DEFAULT_ATLAS, alphaThreshold: 9 }, trimmer);
    expect(trimmer).toHaveBeenCalledTimes(2);
  });

  it("passes the threshold on", async () => {
    const { assets, items } = setup([["s1", 8, 8]]);
    const trimmer = vi.fn(async () => reply(8, 8));
    await pretrim(items, assets, { ...DEFAULT_ATLAS, alphaThreshold: 17 }, trimmer);
    expect(trimmer).toHaveBeenCalledWith(expect.any(Blob), 17);
  });

  it("asks once for an asset shared by two library items", async () => {
    const { assets } = setup([["s1", 8, 8]]);
    const items = [createImageItem("a", "s1" as AssetId, 8, 8), createImageItem("b", "s1" as AssetId, 8, 8)];
    const trimmer = vi.fn(async () => reply(8, 8));
    await pretrim(items, assets, DEFAULT_ATLAS, trimmer);
    expect(trimmer).toHaveBeenCalledTimes(1);
  });

  it("skips what does not trim: trimming off, scaled down, noTrim, a missing asset", async () => {
    const { assets, items } = setup([["s1", 8, 8]]);
    const trimmer = vi.fn(async () => reply(8, 8));
    await pretrim(items, assets, { ...DEFAULT_ATLAS, trim: false }, trimmer);
    await pretrim(items, assets, { ...DEFAULT_ATLAS, scale: 0.5 }, trimmer);
    await pretrim([{ ...items[0]!, noTrim: true }], assets, DEFAULT_ATLAS, trimmer);
    await pretrim([createImageItem("gone", "nope" as AssetId, 8, 8)], assets, DEFAULT_ATLAS, trimmer);
    expect(trimmer).not.toHaveBeenCalled();
  });

  it("does not trust an answer about a picture of another size", async () => {
    const { assets, items } = setup([["s1", 8, 8]]);
    const wrong = vi.fn(async () => reply(16, 16));
    await pretrim(items, assets, DEFAULT_ATLAS, wrong);
    const right = vi.fn(async () => reply(8, 8));
    await pretrim(items, assets, DEFAULT_ATLAS, right);
    expect(right).toHaveBeenCalledTimes(1);               // the wrong answer was not kept
  });

  it("leaves the work to the page when no worker could answer", async () => {
    const { assets, items } = setup();
    const none = vi.fn(async () => null);
    await pretrim(items, assets, DEFAULT_ATLAS, none);
    await pretrim(items, assets, DEFAULT_ATLAS, none);
    expect(none).toHaveBeenCalledTimes(4);                // asked again next time, nothing cached
  });

  it("a trimmer that throws at once is treated like one that fails later", async () => {
    const { assets, items } = setup();
    const sync = (() => { throw new Error("at once"); }) as unknown as () => Promise<null>;
    await expect(pretrim(items, assets, DEFAULT_ATLAS, sync)).resolves.toBeUndefined();
  });

  it("a worker that fails on a picture leaves it to the page, and the build goes on", async () => {
    const { assets, items } = setup();
    await expect(pretrim(items, assets, DEFAULT_ATLAS, async () => { throw new Error("bad picture"); }))
      .resolves.toBeUndefined();
  });
});
