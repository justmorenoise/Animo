import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What `ProjectService` promises about the document on screen. The file is
 * the same in the public editor and in Animo Pro's `desktop` branch, whose
 * service also manages several documents: a fix made in one copy and not the
 * other fails here.
 */

vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
const written = vi.hoisted(() => ({ fail: false, during: null as null | (() => void), count: 0 }));
vi.mock("@/io/project/FileSystem", async (original) => ({
  ...(await original<object>()),
  hasNativeFiles: () => false,
  pickSaveLocation: async () => ({ name: "elsewhere.animo" }),
  writeFile: async () => {
    written.during?.();
    if (written.fail) throw new Error("disk full");
    written.count++;
  },
  pickOpenFile: async () => null,
  readFileRef: async () => null,
}));
vi.mock("@/io/project/Recents", async (original) => ({ ...(await original<object>()), listRecents: async () => [], rememberRecent: async () => [], clearRecents: async () => {} }));
vi.mock("@/io/project/Autosave", async (original) => ({
  ...(await original<object>()),
  Autosaver: class { start() {} stop() {} touch() {} setInterval() {} async close() {} async flush() { return true; } hasWritten = false; },
  clearAutosave: async () => {}, readAutosave: async () => null, listAutosaves: async () => [],
}));

async function setup(confirm = false) {
  const { Store } = await import("@/app/Store");
  const { AssetStore } = await import("@/app/AssetStore");
  const { ProjectService } = await import("@/app/ProjectService");
  const { SetDocumentSettings } = await import("@/core/history/commands");
  const store = new Store();
  const service = new ProjectService(store, new AssetStore(), { confirmDiscard: async () => confirm });
  const edit = (name: string) => store.apply(new SetDocumentSettings({ name }));
  return { store, service, edit };
}

beforeEach(() => { written.fail = false; written.during = null; written.count = 0; });

describe("ProjectService", () => {
  it("Save As writes the file and the document is saved", async () => {
    const { store, service, edit } = await setup();
    edit("Walk");
    expect(await service.saveAs()).toBe(true);
    expect(written.count).toBe(1);
    expect(store.history.isDirty).toBe(false);
    expect(service.fileName).toBe("elsewhere.animo");
  });

  it("a Save As that fails leaves the document where it was, and unsaved", async () => {
    const { store, service, edit } = await setup();
    edit("Walk");
    const before = service.fileName;
    written.fail = true;
    expect(await service.saveAs()).toBe(false);
    expect(service.fileName).toBe(before);
    expect(store.history.isDirty).toBe(true);
  });

  it("an edit made while the file is written leaves the document unsaved", async () => {
    const { store, service, edit } = await setup();
    edit("Walk");
    written.during = () => edit("Run");
    expect(await service.saveAs()).toBe(true);
    expect(store.history.isDirty).toBe(true);
  });

  it("a file that is not a project changes nothing", async () => {
    const { store, service, edit } = await setup();
    edit("Walk");
    const project = store.project;
    expect(await service.loadFrom(new Uint8Array([1, 2, 3]).buffer, { name: "junk.animo" })).toBe(false);
    expect(store.project).toBe(project);
    expect(store.history.canUndo).toBe(true);
  });

  it("New Project asks before dropping unsaved work, and a no keeps it", async () => {
    const { store, service, edit } = await setup(false);
    edit("Walk");
    expect(await service.newProject()).toBe(false);
    expect(store.project.name).toBe("Walk");
  });
});
