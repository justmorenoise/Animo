import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { buildDbImport, type DbImageRef, DbImportError } from "@/core/doc/dbImport";
import { evaluateSymbol } from "@/core/doc/pose";
import { isImage, isSymbol, type Project, type SymbolItem } from "@/core/doc/types";
import { exportSkeleton } from "@/core/export/exportSkeleton";
import { buildExtensionManifest } from "@/core/export/extensions";
import { mat, mul, type Matrix2D } from "@/core/math/Matrix2D";
import { deserializeProject } from "@/io/project/ProjectFile";
import { fakeAssets } from "./fixtures/realProject";

beforeEach(() => reseed());

async function fixture(name: string): Promise<Project> {
  const bytes = readFileSync(fileURLToPath(new URL(`./fixtures/projects/${name}`, import.meta.url)));
  const { project } = await deserializeProject(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, fakeAssets());
  return project;
}

/** Export `project`, and open what was written: the images stand in for the atlas by name. */
function roundTrip(project: Project) {
  const exported = exportSkeleton(project);
  const extensions = buildExtensionManifest(project, exported);
  const images = new Map<string, DbImageRef>();
  for (const item of Object.values(project.items)) {
    if (isImage(item)) images.set(item.name, { assetId: item.assetId, width: item.width, height: item.height });
  }
  const skeleton = JSON.parse(JSON.stringify(exported.skeleton));
  return { exported, ...buildDbImport({ name: project.name, skeleton, images, extensions: JSON.parse(JSON.stringify(extensions)) }) };
}

const symbolsOf = (p: Project) => new Map(Object.values(p.items).filter(isSymbol).map((s) => [s.name, s]));

/** What each slot draws at a frame: the matrix its artwork is drawn with, which display, its colour. */
function drawn(project: Project, sym: SymbolItem, anim: string, frame: number) {
  const visible = { ...sym, layers: sym.layers.map((l) => ({ ...l, visible: true })) };
  const pose = evaluateSymbol(visible, sym.animations.find((a) => a.name === anim) ?? null, frame);
  const out = new Map<string, { m: Matrix2D; item: string; color: number[] } | null>();
  for (const e of pose.entries) {
    if (e.node.kind !== "image" && e.node.kind !== "symbol") continue;
    if (!e.visible || !e.display) { out.set(e.node.name, null); continue; }
    const shift: Matrix2D = { a: 1, b: 0, c: 0, d: 1, tx: -e.display.pivot.x, ty: -e.display.pivot.y };
    const m = mul(mat(), e.world, shift);
    const c = e.color;
    out.set(e.node.name, { m, item: project.items[e.display.itemId]!.name, color: [c.aM, c.rM, c.gM, c.bM] });
  }
  return out;
}

function expectSameMotion(a: Project, b: Project, slotsOf: (sym: string) => Set<string>) {
  const as = symbolsOf(a), bs = symbolsOf(b);
  let compared = 0;
  for (const [name, symA] of as) {
    const symB = bs.get(name);
    const slots = slotsOf(name);
    if (!slots.size) continue;
    expect(symB, name).toBeDefined();
    for (const anim of symA.animations) {
      expect(symB!.animations.map((x) => x.name), name).toContain(anim.name);
      for (let f = 0; f < anim.duration; f++) {
        const da = drawn(a, symA, anim.name, f), db = drawn(b, symB!, anim.name, f);
        for (const slot of slots) {
          const x = da.get(slot) ?? null, y = db.get(slot) ?? null;
          const where = `${name}/${anim.name}@${f}/${slot}`;
          expect(y === null, where).toBe(x === null);
          if (!x || !y) continue;
          expect(y.item, where).toBe(x.item);
          expect(y.color, where).toEqual(x.color);
          for (const k of ["a", "b", "c", "d"] as const) expect(Math.abs(y.m[k] - x.m[k]), `${where} ${k}`).toBeLessThan(2e-3);
          for (const k of ["tx", "ty"] as const) expect(Math.abs(y.m[k] - x.m[k]), `${where} ${k}`).toBeLessThan(0.02);
          compared++;
        }
      }
    }
  }
  return compared;
}

describe("buildDbImport: an Animo export opened again shows the same thing at every frame", () => {
  for (const file of ["stickman.animo", "frog.animo"]) {
    it(file, async () => {
      const original = await fixture(file);
      const { exported, project, warnings } = roundTrip(original);
      // Slots as exported: what the file can carry, by the names it gives them.
      const slots = new Map(exported.skeleton.armature.map((arm) => [arm.name, new Set(arm.slot.map((s) => s.name))]));
      const n = expectSameMotion(original, project, (sym) => slots.get(sym) ?? new Set());
      expect(n).toBeGreaterThan(500);
      expect(warnings).toEqual([]);
      expect(project.stage).toEqual(original.stage);
      expect(project.frameRate).toBe(original.frameRate);
      expect(project.items[project.rootSymbolId]!.name).toBe(original.items[original.rootSymbolId]!.name);
    });
  }
});

describe("buildDbImport refuses what it cannot read", () => {
  it.each([
    [null, /not a DragonBones skeleton/],
    [{ name: "x" }, /not a DragonBones skeleton/],
    [{ version: "5.5", armature: [] }, /no armature/],
    [{ version: "4.5", armature: [{ name: "a" }] }, /DragonBones 4\.5 file/],
  ])("%j", (skeleton, message) => {
    expect(() => buildDbImport({ name: "x", skeleton, images: new Map() })).toThrow(DbImportError);
    expect(() => buildDbImport({ name: "x", skeleton, images: new Map() })).toThrow(message);
  });
});
