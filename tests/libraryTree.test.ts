import { describe, it, expect, beforeEach } from "vitest";
import { reseed, type AssetId, type FolderId, type ItemId } from "@/core/doc/ids";
import { createImageItem, createProject, createSymbol } from "@/core/doc/defaults";
import type { LibraryFolder, Project } from "@/core/doc/types";
import {
  canMoveFolder, deletePlan, libraryRows, rowKey, stepRow, uniqueFolderName, type RowOptions,
} from "@/core/doc/libraryTree";
import { AddFolder, MoveToFolder, RemoveFolder, RenameFolder } from "@/core/history/libraryCommands";
import { RemoveLibraryItem } from "@/core/history/commands";
import { migrate, validateProject } from "@/core/doc/schema";
import { Store } from "@/app/Store";

beforeEach(() => reseed());

const F = (id: string) => id as FolderId;

/** art/ (arms/ leg_10 leg_2) body, plus a symbol "rig" at the top. */
function lib() {
  const p = createProject("L");
  const add = (name: string, folder?: string) => {
    const i = createImageItem(name, "s1" as AssetId, 10, 10);
    if (folder) i.folderId = F(folder);
    p.items[i.id] = i;
    p.itemOrder.push(i.id);
    return i.id;
  };
  const folder = (id: string, name: string, parentId: string | null): LibraryFolder =>
    (p.folders[F(id)] = { id: F(id), name, parentId: parentId as FolderId | null });
  folder("fa", "art", null);
  folder("fb", "arms", "fa");
  const ids = {
    leg10: add("leg_10", "fa"), leg2: add("leg_2", "fa"), hand: add("hand", "fb"), body: add("body"),
  };
  const rig = createSymbol("rig");
  p.items[rig.id] = rig;
  p.itemOrder.push(rig.id);
  return { p, ids: { ...ids, rig: rig.id } };
}

const opts = (o: Partial<RowOptions> = {}): RowOptions => ({ collapsed: new Set(), filter: "", sortDir: 1, ...o });
const shape = (p: Project, o?: Partial<RowOptions>) =>
  libraryRows(p, opts(o)).map((r) => `${"  ".repeat(r.depth)}${r.kind === "folder" ? `${r.name}/` : r.name}`);

describe("libraryRows", () => {
  it("folders first, then items, numeric name order, the root scene left out", () => {
    const { p } = lib();
    expect(shape(p)).toEqual(["art/", "  arms/", "    hand", "  leg_2", "  leg_10", "body", "rig"]);
  });

  it("a closed folder hides its contents", () => {
    const { p } = lib();
    expect(shape(p, { collapsed: new Set([F("fa")]) })).toEqual(["art/", "body", "rig"]);
  });

  it("filtering opens folders on the way to a match and hides the rest", () => {
    const { p } = lib();
    expect(shape(p, { filter: "hand", collapsed: new Set([F("fa")]) })).toEqual(["art/", "  arms/", "    hand"]);
    // A matching folder shows everything inside it.
    expect(shape(p, { filter: "arms" })).toEqual(["art/", "  arms/", "    hand"]);
    expect(shape(p, { filter: "zzz" })).toEqual([]);
  });

  it("descending order reverses names but keeps folders first", () => {
    const { p } = lib();
    expect(shape(p, { sortDir: -1 })).toEqual(["art/", "  arms/", "    hand", "  leg_10", "  leg_2", "rig", "body"]);
  });

  it("an item in a folder that does not exist shows at the top level", () => {
    const { p, ids } = lib();
    p.items[ids.body]!.folderId = F("gone");
    expect(shape(p)).toContain("body");
  });
});

describe("stepRow", () => {
  it.each([
    [null, 1, "art"], [null, -1, "rig"],
    ["rig", 1, "rig"], ["art", -1, "art"], ["arms", 1, "hand"], ["leg_10", 1, "body"],
  ])("from %s by %i → %s", (from, delta, to) => {
    const { p } = lib();
    const rows = libraryRows(p, opts());
    const key = from === null ? null : rowKey(rows.find((r) => r.name === from)!);
    expect(stepRow(rows, key, delta)!.name).toBe(to);
  });

  it("is null for an empty list", () => {
    expect(stepRow([], null, 1)).toBeNull();
  });
});

describe("folder rules", () => {
  it("a folder cannot move into itself or its own inside", () => {
    const { p } = lib();
    expect(canMoveFolder(p, F("fa"), F("fb"))).toBe(false);
    expect(canMoveFolder(p, F("fa"), F("fa"))).toBe(false);
    expect(canMoveFolder(p, F("fb"), null)).toBe(true);
  });

  it("names new folders apart from their siblings", () => {
    const { p } = lib();
    expect(uniqueFolderName(p, null, "art")).toBe("art 2");
    expect(uniqueFolderName(p, F("fa"), "art")).toBe("art");
  });

  it("deleting a folder takes its contents, deepest folder first, and reports what is in use", () => {
    const { p, ids } = lib();
    const plan = deletePlan(p, [], [F("fa")], new Map([[ids.hand, 2]]));
    expect(new Set(plan.items)).toEqual(new Set([ids.leg10, ids.leg2, ids.hand]));
    expect(plan.folders).toEqual([F("fb"), F("fa")]);
    expect(plan.inUse).toEqual([ids.hand]);
  });
});

describe("folder commands", () => {
  it("add, rename, move and delete undo back to the start", () => {
    const { p, ids } = lib();
    const store = new Store(p);
    const before = structuredClone(store.project);
    store.apply(new AddFolder({ id: F("fz"), name: "new", parentId: null }));
    store.apply(new RenameFolder(F("fz"), "props"));
    store.apply(new MoveToFolder([ids.body], [F("fa")], F("fz")));
    expect(store.project.items[ids.body]!.folderId).toBe("fz");
    expect(store.project.folders[F("fa")]!.parentId).toBe("fz");

    const plan = deletePlan(store.project, [], [F("fz")], new Map());
    store.transaction("Delete", () => {
      for (const id of plan.items) store.apply(new RemoveLibraryItem(id as ItemId));
      for (const id of plan.folders) store.apply(new RemoveFolder(id));
    });
    expect(Object.keys(store.project.folders)).toEqual([]);
    expect(store.project.items[ids.rig]).toBeDefined();

    for (let i = 0; i < 5; i++) store.undo();
    expect(store.project).toEqual(before);
  });

  it("a folder is never moved inside itself", () => {
    const { p } = lib();
    const store = new Store(p);
    store.apply(new MoveToFolder([], [F("fa")], F("fb")));
    expect(store.project.folders[F("fa")]!.parentId).toBeNull();
  });
});

describe("validateProject repairs folders", () => {
  it("drops malformed folders, cuts loops and dangling links", () => {
    const { p, ids } = lib();
    const raw = JSON.parse(JSON.stringify(p));
    raw.folders.fa.parentId = "fb";                  // fa ⊂ fb ⊂ fa
    raw.folders.bad = { id: "other", name: 3 };
    raw.items[ids.body].folderId = "nowhere";
    const { project, diagnostics } = validateProject(migrate(raw));
    expect(project.folders["bad" as FolderId]).toBeUndefined();
    expect(project.items[ids.body]!.folderId).toBeUndefined();
    // Every folder reaches the top level again.
    const reachesTop = (id: FolderId) => {
      let at: FolderId | null = id;
      for (let n = 0; at; n++) { if (n > 5) return false; at = project.folders[at]!.parentId; }
      return true;
    };
    expect(reachesTop(F("fa")) && reachesTop(F("fb"))).toBe(true);
    expect(diagnostics.some((d) => d.path.startsWith("folders."))).toBe(true);
  });
});

describe("duplicates stay in the original's folder", () => {
  it.each(["image", "symbol"] as const)("a duplicated %s", async (kind) => {
    const { DuplicateLibraryItem } = await import("@/core/history/symbolCommands");
    const { p, ids } = lib();
    const id = kind === "image" ? ids.hand : ids.rig;
    p.items[id]!.folderId = F("fb");
    const store = new Store(p);
    const cmd = new DuplicateLibraryItem(id, "copy");
    store.apply(cmd);
    const copy = Object.values(store.project.items).find((i) => i.name === "copy")!;
    expect(copy.folderId).toBe("fb");
  });
});
