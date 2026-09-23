import type { FolderId, ItemId } from "@/core/doc/ids";
import type { LibraryFolder, Project } from "@/core/doc/types";
import type { Command, TouchSet } from "./Command";

/** Library folders. Organisation only: nothing here reaches the stage or the export. */

const TOUCHES: TouchSet = { library: true };

export class AddFolder implements Command {
  readonly kind = "library.folder.add";
  readonly touches = TOUCHES;
  readonly label = "New Folder";
  constructor(readonly folder: LibraryFolder) {}
  apply(p: Project): void { p.folders[this.folder.id] = { ...this.folder }; }
  revert(p: Project): void { delete p.folders[this.folder.id]; }
}

export class RenameFolder implements Command {
  readonly kind = "library.folder.rename";
  readonly touches = TOUCHES;
  readonly label = "Rename Folder";
  private before = "";
  constructor(private readonly id: FolderId, private readonly name: string) {}
  apply(p: Project): void {
    const f = p.folders[this.id];
    if (!f) return;
    this.before = f.name;
    f.name = this.name;
  }
  revert(p: Project): void {
    const f = p.folders[this.id];
    if (f) f.name = this.before;
  }
}

/** Items and folders into `into` (null: the top level). The caller checks
 *  `canMoveFolder`; a folder that would land inside itself is skipped here too. */
export class MoveToFolder implements Command {
  readonly kind = "library.move";
  readonly touches = TOUCHES;
  readonly label = "Move to Folder";
  private beforeItems = new Map<ItemId, FolderId | undefined>();
  private beforeFolders = new Map<FolderId, FolderId | null>();

  constructor(
    private readonly items: readonly ItemId[],
    private readonly folders: readonly FolderId[],
    private readonly into: FolderId | null,
  ) {}

  apply(p: Project): void {
    this.beforeItems.clear();
    this.beforeFolders.clear();
    for (const id of this.items) {
      const item = p.items[id];
      if (!item) continue;
      this.beforeItems.set(id, item.folderId);
      if (this.into) item.folderId = this.into; else delete item.folderId;
    }
    for (const id of this.folders) {
      const f = p.folders[id];
      if (!f || this.inside(p, this.into, id)) continue;
      this.beforeFolders.set(id, f.parentId);
      f.parentId = this.into;
    }
  }

  revert(p: Project): void {
    for (const [id, folderId] of this.beforeItems) {
      const item = p.items[id];
      if (!item) continue;
      if (folderId) item.folderId = folderId; else delete item.folderId;
    }
    for (const [id, parentId] of this.beforeFolders) {
      const f = p.folders[id];
      if (f) f.parentId = parentId;
    }
  }

  /** Whether `at` is `folder` or lies inside it. */
  private inside(p: Project, at: FolderId | null, folder: FolderId): boolean {
    for (let f = at, n = 0; f && n < 1000; f = p.folders[f]?.parentId ?? null, n++) {
      if (f === folder) return true;
    }
    return false;
  }
}

/** One folder, which must be empty by then: `deletePlan` removes the items and
 *  deeper folders first, in the same transaction. */
export class RemoveFolder implements Command {
  readonly kind = "library.folder.remove";
  readonly touches = TOUCHES;
  readonly label = "Delete Folder";
  private folder: LibraryFolder | null = null;
  constructor(private readonly id: FolderId) {}
  apply(p: Project): void {
    this.folder = p.folders[this.id] ?? null;
    delete p.folders[this.id];
  }
  revert(p: Project): void {
    if (this.folder) p.folders[this.id] = this.folder;
  }
}
