import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { sortDbFiles, subTextureCut, subTextureRegion } from "@/io/import/dbReader";
import { DbImportError } from "@/core/doc/dbImport";

/** Where `m` sends a point of the region (u along its width, v along its height). */
const at = (m: number[], u: number, v: number) => [m[0]! * u + m[2]! * v + m[4]!, m[1]! * u + m[3]! * v + m[5]!];

describe("subTextureCut", () => {
  it("an untrimmed region is the whole image, drawn at the corner", () => {
    const c = subTextureCut({ x: 10, y: 20, width: 30, height: 40 }, 1);
    expect([c.width, c.height]).toEqual([30, 40]);
    expect(c.src).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(at(c.m, 0, 0)).toEqual([0, 0]);
  });

  it("a trimmed region goes back to its place in the untrimmed frame (frameX is minus the offset)", () => {
    const c = subTextureCut({ x: 0, y: 0, width: 30, height: 40, frameX: -5, frameY: -7, frameWidth: 50, frameHeight: 60 }, 1);
    expect([c.width, c.height]).toEqual([50, 60]);
    expect(at(c.m, 0, 0)).toEqual([5, 7]);
    expect(at(c.m, 30, 40)).toEqual([35, 47]);
  });

  it("a rotated region, stored turned clockwise with the page's width and height, is turned back", () => {
    // Shown 40 wide and 30 high; on the page 30 wide and 40 high.
    const c = subTextureCut({ x: 0, y: 0, width: 30, height: 40, rotated: true }, 1);
    expect([c.width, c.height]).toEqual([40, 30]);
    // The region's top-left corner was the image's bottom-left one.
    expect(at(c.m, 0, 0)).toEqual([0, 30]);
    // Its top-right corner, the image's top-left.
    expect(at(c.m, 30, 0).map((v) => Math.abs(v))).toEqual([0, 0]);
    expect(at(c.m, 30, 40)).toEqual([40, 0]);
  });

  it("an atlas at half size is cut back to full size", () => {
    const c = subTextureCut({ x: 0, y: 0, width: 30, height: 40, frameX: -5, frameY: 0, frameWidth: 50, frameHeight: 40 }, 0.5);
    expect([c.width, c.height]).toEqual([100, 80]);
    expect(at(c.m, 0, 0)).toEqual([10, 0]);
    expect(at(c.m, 30, 40)).toEqual([70, 80]);
  });
});

describe("sortDbFiles", () => {
  const json = (v: unknown) => strToU8(JSON.stringify(v));
  it("tells the files apart by what they hold, not their names", () => {
    const sorted = sortDbFiles(new Map([
      ["out/a.json", json({ name: "a", armature: [] })],
      ["out/b.json", json({ name: "a", imagePath: "a_tex.png", SubTexture: [] })],
      ["out/c.json", json({ format: "animo-extensions", extensions: {} })],
      ["out/a_tex.png", new Uint8Array([1])],
      ["out/readme.md", strToU8("hi")],
      ["out/broken.json", strToU8("{")],
    ]));
    expect(sorted.skeleton.path).toBe("out/a.json");
    expect(sorted.atlases.map((a) => a.path)).toEqual(["out/b.json"]);
    expect(sorted.extensions).toEqual({ format: "animo-extensions", extensions: {} });
    expect([...sorted.pngs.keys()]).toEqual(["out/a_tex.png"]);
  });

  it("prefers the _ske.json of two skeletons", () => {
    const sorted = sortDbFiles(new Map([
      ["x.json", json({ armature: [] })],
      ["x_ske.json", json({ armature: [] })],
    ]));
    expect(sorted.skeleton.path).toBe("x_ske.json");
  });

  it("refuses binary files and a missing skeleton", () => {
    expect(() => sortDbFiles(new Map([["x.dbbin", new Uint8Array()]]))).toThrow(/Binary DragonBones/);
    expect(() => sortDbFiles(new Map([["x_tex.json", json({ SubTexture: [] })]]))).toThrow(DbImportError);
  });
});

describe("subTextureRegion", () => {
  it("an untrimmed region's offset is 0, not -0", () => {
    const r = subTextureRegion({ name: "a", x: 0, y: 0, width: 4, height: 4 }, "p");
    expect(Object.is(r.offsetX, 0) && Object.is(r.offsetY, 0)).toBe(true);
  });
});
