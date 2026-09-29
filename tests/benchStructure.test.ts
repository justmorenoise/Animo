import { beforeEach, describe, expect, it } from "vitest";
import { type AssetId, reseed } from "@/core/doc/ids";
import { createImageItem } from "@/core/doc/defaults";
import { BENCH_PRESETS, buildBenchProject, describeBench } from "@/dev/benchStructure";
import { exportSkeleton } from "@/core/export/exportSkeleton";
import { isSymbol } from "@/core/doc/types";
import { wouldCreateCycle } from "@/core/history/symbolCommands";

beforeEach(() => reseed());

const images = (n: number) =>
  Array.from({ length: n }, (_, i) => createImageItem(`art${i}`, `asset${i}` as AssetId, 64, 64));

describe("buildBenchProject", () => {
  it("builds the shape the spec asks for", () => {
    const spec = { symbols: 3, nodesPerSymbol: 4, keys: 5, nested: 1 };
    const project = buildBenchProject(spec, images(6));
    const d = describeBench(project);
    // 4 symbols of 4 layers, plus the scene's 3 instances.
    expect(d.nodes).toBe(4 * 4 + 3);
    expect(d.keys).toBe(4 * 4 * 5);
    expect(d.items).toBe(1 + 6 + 4);
  });

  it("is deterministic", () => {
    const a = buildBenchProject(BENCH_PRESETS.small!, images(5));
    reseed();
    const b = buildBenchProject(BENCH_PRESETS.small!, images(5));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("nests symbols without ever closing a loop", () => {
    const project = buildBenchProject(BENCH_PRESETS.medium!, images(20));
    for (const item of Object.values(project.items).filter(isSymbol)) {
      for (const node of Object.values(item.nodes)) {
        if (node.itemId) expect(wouldCreateCycle(project, item.id, node.itemId)).toBe(false);
      }
    }
  });

  it("really nests when asked to", () => {
    const project = buildBenchProject({ symbols: 2, nodesPerSymbol: 2, keys: 2, nested: 2 }, images(3));
    const nesting = Object.values(project.items).filter(isSymbol)
      .some((s) => Object.values(s.nodes).some((n) => n.kind === "symbol" && s.name.startsWith("part")));
    expect(nesting).toBe(true);
  });

  it.each(Object.keys(BENCH_PRESETS))("the %s preset exports", (name) => {
    const project = buildBenchProject(BENCH_PRESETS[name]!, images(12));
    const out = exportSkeleton(project);
    expect(out.skeleton.armature.length).toBeGreaterThan(1);
    expect(out.usedImages.length).toBeGreaterThan(0);
  });

  it("needs an image to draw with", () => {
    expect(() => buildBenchProject(BENCH_PRESETS.small!, [])).toThrow("at least one image");
  });
});
