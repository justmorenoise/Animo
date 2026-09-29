import { describe, it, expect, beforeEach } from "vitest";
import { reseed, type AssetId } from "@/core/doc/ids";
import {
  createProject, createSymbol, createNode, createLayer, createImageItem,
} from "@/core/doc/defaults";
import { isSymbol } from "@/core/doc/types";
import { symbolBounds, invalidateBounds } from "@/core/doc/pose";

beforeEach(() => { reseed(); invalidateBounds(); });

/** A project whose only symbol holds one image of the given width. Ids come
 *  from a reseeded counter, so two calls yield identical ids. */
function projectWithImage(width: number) {
  reseed();
  const project = createProject("P");
  const root = project.items[project.rootSymbolId];
  if (!isSymbol(root)) throw new Error("no root");
  const img = createImageItem("art", "asset_art" as AssetId, width, 10);
  project.items[img.id] = img;
  project.itemOrder.push(img.id);
  const inner = createSymbol("part");
  const leaf = createNode("image", "art", { itemId: img.id });
  inner.nodes[leaf.id] = leaf;
  inner.layers.push(createLayer(leaf.id, "art", 0));
  project.items[inner.id] = inner;
  project.itemOrder.push(inner.id);
  return { project, inner };
}

describe("bounds cache with two live projects", () => {
  it("does not answer one project with the other's measurement", () => {
    const a = projectWithImage(100);
    const b = projectWithImage(300);
    expect(a.inner.id).toBe(b.inner.id);

    expect(symbolBounds(a.project, a.inner.id).w).toBe(100);
    expect(symbolBounds(b.project, b.inner.id).w).toBe(300);
    expect(symbolBounds(a.project, a.inner.id).w).toBe(100);
  });

  it("invalidates an item in every project that cached it", () => {
    const a = projectWithImage(100);
    const b = projectWithImage(300);
    symbolBounds(a.project, a.inner.id);
    symbolBounds(b.project, b.inner.id);

    const img = Object.values(a.project.items).find(i => i.name === "art")!;
    (img as { width: number }).width = 150;
    invalidateBounds([a.inner.id]);
    expect(symbolBounds(a.project, a.inner.id).w).toBe(150);
    expect(symbolBounds(b.project, b.inner.id).w).toBe(300);
  });

  it("invalidates one project only when told which", () => {
    const a = projectWithImage(100);
    const b = projectWithImage(300);
    symbolBounds(a.project, a.inner.id);
    symbolBounds(b.project, b.inner.id);

    (Object.values(a.project.items).find(i => i.name === "art") as { width: number }).width = 150;
    (Object.values(b.project.items).find(i => i.name === "art") as { width: number }).width = 350;
    invalidateBounds(undefined, a.project);
    expect(symbolBounds(a.project, a.inner.id).w).toBe(150);
    expect(symbolBounds(b.project, b.inner.id).w).toBe(300);
  });
});
