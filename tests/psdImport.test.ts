import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildPsdImport, planBounds, type PsdPlan } from "@/core/doc/psdImport";
import { newAssetId } from "@/core/doc/ids";
import { resolveAlpha } from "@/io/import/psdReader";
import { parsePsd, type PsdRaw } from "@/io/import/psdParse";
import { isImage, isSymbol, type SymbolItem } from "@/core/doc/types";
import { createProject } from "@/core/doc/defaults";
import { libraryRows } from "@/core/doc/libraryTree";

function img(name: string, x: number, y: number, w = 10, h = 10, visible = true): PsdPlan {
  return { kind: "image", name, x, y, width: w, height: h, assetId: newAssetId(), visible };
}

function group(name: string, children: PsdPlan[], visible = true): PsdPlan {
  return { kind: "group", name, visible, children };
}

/** The layers of a symbol, front to back, as names. */
function order(sym: SymbolItem): string[] {
  return sym.layers.map((l) => sym.nodes[l.nodeId]!.name);
}

function nodeNamed(sym: SymbolItem, name: string) {
  return Object.values(sym.nodes).find((n) => n.name === name)!;
}

describe("PSD import", () => {
  it("reverses Photoshop's stacking: the last child is the top layer", () => {
    const { root } = buildPsdImport("doc", [img("back", 0, 0), img("middle", 0, 0), img("front", 0, 0)]);
    expect(order(root)).toEqual(["front", "middle", "back"]);
  });

  it("turns each group into a symbol, instanced in its parent", () => {
    const { items, root } = buildPsdImport("doc", [group("arm", [img("hand", 0, 0)])]);

    const arm = items.find((i) => i.name === "arm");
    expect(isSymbol(arm)).toBe(true);
    expect(order(arm as SymbolItem)).toEqual(["hand"]);

    const instance = nodeNamed(root, "arm");
    expect(instance.kind).toBe("symbol");
    expect(instance.itemId).toBe(arm!.id);

    // Children before parents: a symbol never references an item added later.
    expect(items.map((i) => i.name)).toEqual(["hand", "arm", "doc"]);
    expect(items[items.length - 1]).toBe(root);
  });

  it("keeps every layer where Photoshop had it", () => {
    // A group whose content starts at (80, 40); one layer of it at (100, 50).
    const { items, root } = buildPsdImport("doc", [
      group("head", [img("eye", 100, 50), img("skull", 80, 40, 200, 200)]),
      img("floor", 5, 7),
    ]);

    const head = items.find((i) => i.name === "head") as SymbolItem;
    const headInstance = nodeNamed(root, "head");

    // The group symbol is built around the top-left of its own content...
    expect(headInstance.bind.x).toBe(80);
    expect(headInstance.bind.y).toBe(40);
    // ...so its contents are relative to that, and the two add back up.
    const eye = nodeNamed(head, "eye");
    expect(eye.bind.x).toBe(20);
    expect(eye.bind.y).toBe(10);
    expect(headInstance.bind.x + eye.bind.x).toBe(100);
    expect(headInstance.bind.y + eye.bind.y).toBe(50);

    // A layer at the top level keeps canvas coordinates outright.
    expect(nodeNamed(root, "floor").bind).toMatchObject({ x: 5, y: 7 });
  });

  it("gives unnamed layers a name and never repeats one", () => {
    const { items } = buildPsdImport("doc", [
      img("", 0, 0), img("", 0, 0), img("pupil", 0, 0),
      group("pupil", [img("pupil", 0, 0)]),
    ], (name) => name === "Layer 1");

    const names = items.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
    // "Layer 1" was already taken in the library, so the fallback moves on.
    expect(names).toContain("Layer 1_2");
    expect(names.filter((n) => n.startsWith("pupil")).sort())
      .toEqual(["pupil", "pupil_2", "pupil_3"]);
  });

  it("carries hidden layers across, switched off", () => {
    const { root } = buildPsdImport("doc", [img("ghost", 0, 0, 10, 10, false), img("solid", 0, 0)]);
    const ghost = root.layers.find((l) => l.name === "ghost")!;
    expect(ghost.visible).toBe(false);
    expect(root.layers.find((l) => l.name === "solid")!.visible).toBe(true);
  });

  it("keeps an empty group rather than dropping the structure", () => {
    const { items, root } = buildPsdImport("doc", [group("spare", [])]);
    const spare = items.find((i) => i.name === "spare") as SymbolItem;
    expect(spare.layers).toHaveLength(0);
    expect(nodeNamed(root, "spare").bind).toMatchObject({ x: 0, y: 0 });
  });

  it("measures a group by the pixels under it", () => {
    const g = group("g", [img("a", 10, 20, 30, 40), img("b", 5, 60, 10, 10)]);
    expect(planBounds(g)).toEqual({ x: 5, y: 20, w: 35, h: 50 });
    expect(planBounds(group("empty", []))).toBeNull();
  });
});

describe("PSD layer alpha", () => {
  // A 2x2 layer at canvas (10, 10), fully opaque.
  const layer = () => new Uint8ClampedArray([
    9, 9, 9, 255, 9, 9, 9, 255,
    9, 9, 9, 200, 9, 9, 9, 100,
  ]);
  const alphas = (d: Uint8ClampedArray) => [d[3], d[7], d[11], d[15]];

  /** A 2x2 mask, given as four 0..255 values. */
  const mask = (values: number[], x: number, y: number, outside = 0, density = 1) => ({
    data: {
      width: 2, height: 2,
      data: new Uint8ClampedArray(values.flatMap((v) => [v, v, v, 255])),
    } as ImageData,
    x, y, outside, density,
  });

  it("multiplies layer opacity into alpha", () => {
    const d = layer();
    resolveAlpha(d, 2, 2, 0.5, 10, 10);
    expect(alphas(d)).toEqual([128, 128, 100, 50]);
  });

  it("multiplies an aligned mask into alpha", () => {
    const d = layer();
    resolveAlpha(d, 2, 2, 1, 10, 10, mask([255, 0, 128, 255], 10, 10));
    expect(alphas(d)).toEqual([255, 0, 100, 100]);
  });

  it("places the mask in canvas space, not layer space", () => {
    // Mask shifted one pixel right: the layer's left column now reads what
    // was outside the mask, and its right column reads the mask's left one.
    const d = layer();
    resolveAlpha(d, 2, 2, 1, 10, 10, mask([255, 255, 255, 255], 11, 10, 0));
    expect(alphas(d)).toEqual([0, 255, 0, 100]);
  });

  it("uses the mask's default colour outside its rectangle", () => {
    const d = layer();
    resolveAlpha(d, 2, 2, 1, 10, 10, mask([0, 0, 0, 0], 100, 100, 255));
    expect(alphas(d)).toEqual([255, 255, 200, 100]);
  });

  it("fades the mask itself with density, not the pixels", () => {
    const d = layer();
    // A fully hiding mask at half density hides half.
    resolveAlpha(d, 2, 2, 1, 10, 10, mask([0, 0, 0, 0], 10, 10, 0, 0.5));
    expect(alphas(d)).toEqual([128, 128, 100, 50]);
  });
});

describe("PSD import builds library folders like the Layers panel", () => {
  /** The library an import produces, as indented rows. */
  function library(result: ReturnType<typeof buildPsdImport>): string[] {
    const p = createProject("host");
    for (const f of result.folders) p.folders[f.id] = f;
    for (const i of result.items) { p.items[i.id] = i; p.itemOrder.push(i.id); }
    return libraryRows(p, { collapsed: new Set(), filter: "", sortDir: 1 })
      .map((r) => `${"  ".repeat(r.depth)}${r.name}${r.kind === "folder" ? "/" : ""}`);
  }

  it("one folder per group, holding its symbol and its layers; the document's at the top", () => {
    const result = buildPsdImport("frog", [
      img("background", 0, 0),
      group("eyes", [group("eye_left", [img("pupil", 0, 0)]), img("eye_right", 0, 0)]),
    ], () => false, "frog 2");
    expect(library(result)).toEqual([
      "frog 2/",
      "  eyes/",
      "    eye_left/",
      "      eye_left",
      "      pupil",
      "    eye_right",
      "    eyes",
      "  background",
      "  frog",
    ]);
    expect(result.folders[0]).toMatchObject({ name: "frog 2", parentId: null });
    // Parents before children, so adding them in order never leaves a dangling parent.
    const seen = new Set<string>();
    for (const f of result.folders) {
      expect(f.parentId === null || seen.has(f.parentId)).toBe(true);
      seen.add(f.id);
    }
  });

  it("an empty group gets no folder; two groups with one name get two", () => {
    const result = buildPsdImport("doc", [
      group("empty", []), group("arm", [img("a", 0, 0)]), group("arm", [img("b", 0, 0)]),
    ]);
    // Built from the top of Photoshop's panel down: the front "arm" (the later
    // child) is met first and keeps the plain name, folder and symbol alike.
    expect(library(result)).toEqual([
      "doc/",
      "  arm/", "    arm", "    b",
      "  arm 2/", "    a", "    arm_2",
      "  doc", "  empty",
    ]);
  });
});

/* ── Against the real thing ────────────────────────────────────────────────
   The parser adapter itself needs a DOM, but the file format does not: this
   reads the actual PSD with ag-psd and checks the two assumptions everything
   else rests on — that groups nest the way the artist sees them, and that
   children are stored bottom-to-top.                                       */

// Not committed: a 2 MB PSD is not worth the repo. Drop any .psd here and
// this block runs; without one it skips, which is the normal case in CI.
const FIXTURE = resolve(process.cwd(), "tests/fixtures/projects/import.psd");

describe.skipIf(!existsSync(FIXTURE))("PSD import, against a real file", () => {
  async function readFixture() {
    const { readPsd, initializeCanvas } = await import("ag-psd");
    // Node has no canvas; the reader only needs somewhere to put pixels.
    initializeCanvas(
      () => { throw new Error("no canvas in Node"); },
      (w: number, h: number) =>
        ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as ImageData,
    );
    const buf = readFileSync(FIXTURE);
    return readPsd(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), {
      skipCompositeImageData: true, skipThumbnail: true, useImageData: true,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function toPlan(layers: any[]): PsdPlan[] {
    return layers.map((l) =>
      l.children
        ? { kind: "group", name: l.name ?? "", visible: !l.hidden, children: toPlan(l.children) }
        : {
            kind: "image", name: l.name ?? "", visible: !l.hidden, assetId: newAssetId(),
            x: l.left, y: l.top, width: l.right - l.left, height: l.bottom - l.top,
          },
    );
  }

  it("parsePsd (the worker's code) encodes every layer with its own box", async () => {
    const psd = await readFixture();
    const { readPsd } = await import("ag-psd");
    const buf = readFileSync(FIXTURE);
    const encoded: Array<{ w: number; h: number; bytes: number }> = [];
    const doc = await parsePsd(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, readPsd,
      async (data, w, h) => { encoded.push({ w, h, bytes: data.length }); return new Blob([data]); },
    );
    expect([doc.width, doc.height]).toEqual([psd.width, psd.height]);
    const images: PsdRaw[] = [];
    const walk = (l: PsdRaw[]) => l.forEach((n) => (n.kind === "group" ? walk(n.children) : images.push(n)));
    walk(doc.children);
    expect(images).toHaveLength(13);
    expect(encoded).toHaveLength(13);
    for (const e of encoded) expect(e.bytes).toBe(e.w * e.h * 4);
  });

  it("rebuilds the frog's structure and positions", async () => {
    const psd = await readFixture();
    const { items, root } = buildPsdImport("frog", toPlan(psd.children ?? []));

    // The eyes are stored last, so they are the front layer here.
    expect(order(root)).toEqual(["eyes", "body"]);

    const body = items.find((i) => i.name === "body") as SymbolItem;
    expect(order(body)).toEqual(["body_top", "arm_left", "arm_right", "leg", "foot"]);

    // "foot" sits at (268, 935) on the PSD canvas; the two offsets add up to it.
    const bodyInstance = nodeNamed(root, "body");
    const foot = nodeNamed(body, "foot");
    expect(bodyInstance.bind.x + foot.bind.x).toBe(268);
    expect(bodyInstance.bind.y + foot.bind.y).toBe(935);

    // Groups three deep: eyes ▸ eye_left ▸ pupil.
    const eyes = items.find((i) => i.name === "eyes") as SymbolItem;
    const eyeLeft = items.find((i) => i.name === "eye_left") as SymbolItem;
    expect(order(eyes)).toEqual(["eye_right", "eye_left"]);
    // Both eyes hold a group called "pupil"; the second one gets renamed,
    // since a library cannot have two items under one name.
    const pupil = Object.values(eyeLeft.nodes).find((n) => n.kind === "symbol")!;
    expect(pupil.name).toMatch(/^pupil/);

    // Every image name is unique, including the layers Photoshop left unnamed.
    const names = items.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
    expect(items.filter((i) => isImage(i))).toHaveLength(13);
  });
});
