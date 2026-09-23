import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/io/export/ExportBundle", () => ({ buildExport: vi.fn() }));

import { buildExport, type ExportResult } from "@/io/export/ExportBundle";
import { reseed } from "@/core/doc/ids";
import { createProject } from "@/core/doc/defaults";
import { Store } from "@/app/Store";
import type { AssetStore } from "@/app/AssetStore";
import { PreviewSession, type PreviewView } from "@/preview/PreviewSession";
import type { PreviewHost } from "@/preview/previewHost";
import { tickFrame } from "@/preview/protocol";

/**
 * The preview is ground truth only if it shows the CURRENT document. A build
 * packs an atlas and takes a while; a change landing during it used to be
 * swallowed — the finished build cleared the stale flag it had set.
 */

const built = vi.mocked(buildExport);

function result(tag: number): ExportResult {
  return {
    fileBase: "p",
    skeleton: { tag, armature: [{ name: "Scene 1", slot: [{ name: "s" }] }] } as never,
    pages: [],
    diagnostics: [],
    extensions: null,
  };
}

/** An export with nothing in it: a brand-new project. */
function empty(): ExportResult {
  return {
    fileBase: "p",
    skeleton: { armature: [{ name: "Scene 1", slot: [] }] } as never,
    pages: [],
    diagnostics: [],
    extensions: null,
  };
}

function viewInto(loaded: number[], log?: string[]): PreviewView {
  const host = {
    onMessage: () => () => {},
    post: () => {},
    load: (skeleton: { tag: number }) => { loaded.push(skeleton.tag); },
    clear: () => { log?.push("clear"); },
  } as unknown as PreviewHost;
  return {
    host,
    active: () => true,
    options: () => ({ debugDraw: false, showStage: false, play: false }),
    onStatus: () => {},
    onExtras: (ext) => { log?.push(`extras:${ext === null ? "none" : "some"}`); },
  };
}

function session() {
  const store = new Store(createProject("P"));
  const s = new PreviewSession(store, {} as AssetStore);
  const loaded: number[] = [];
  s.register(viewInto(loaded));
  return { store, s, loaded };
}

beforeEach(() => {
  reseed();
  built.mockReset();
  (globalThis as { window?: unknown }).window ??= globalThis;
  vi.useFakeTimers();
});

describe("preview session", () => {
  it("rebuilds for a change that arrives while a build is running", async () => {
    const { store, s, loaded } = session();
    let finishFirst!: (r: ExportResult) => void;
    built
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockImplementation(async () => result(2));

    s.invalidate();
    await vi.advanceTimersByTimeAsync(250);        // build 1 starts
    store.emit("doc");                             // an edit lands mid-build
    await vi.advanceTimersByTimeAsync(250);        // its refresh finds the build busy
    finishFirst(result(1));
    await vi.advanceTimersByTimeAsync(1000);

    expect(loaded).toEqual([1, 2]);
  });

  it("does not rebuild when nothing changed during the build", async () => {
    const { s, loaded } = session();
    built.mockImplementation(async () => result(1));
    s.invalidate();
    await vi.advanceTimersByTimeAsync(2000);
    expect(loaded).toEqual([1]);
    expect(built).toHaveBeenCalledTimes(1);
  });

  // Entering Play mode reloaded every view, restarting the Preview panel's
  // animation, and rebuilt the export although nothing had changed.
  it("hands a view that comes on screen the current build, and only that view", async () => {
    const { s, loaded } = session();
    built.mockImplementation(async () => result(1));
    s.invalidate();
    await vi.advanceTimersByTimeAsync(300);
    const other: number[] = [];
    const play = viewInto(other);
    s.register(play);

    s.present(play);
    expect(other).toEqual([1]);
    expect(loaded).toEqual([1]);
    expect(built).toHaveBeenCalledTimes(1);
  });

  it("rebuilds for everyone when the document moved on", async () => {
    const { store, s, loaded } = session();
    built.mockImplementationOnce(async () => result(1)).mockImplementation(async () => result(2));
    s.invalidate();
    await vi.advanceTimersByTimeAsync(300);
    const other: number[] = [];
    const play = viewInto(other);
    s.register(play);

    store.emit("doc");
    s.present(play);
    await vi.advanceTimersByTimeAsync(0);
    expect(other).toEqual([2]);
    expect(loaded).toEqual([1, 2]);
  });
});

// File ▸ New Project left the previous rig on screen: the empty export
// returned early and the iframe was never told.
describe("an empty document", () => {
  it("clears the frame and the extension badges instead of leaving the old one", async () => {
    const store = new Store(createProject("P"));
    const s = new PreviewSession(store, {} as AssetStore);
    const loaded: number[] = [];
    const log: string[] = [];
    s.register(viewInto(loaded, log));

    built.mockImplementationOnce(async () => result(1)).mockImplementation(async () => empty());
    s.invalidate();
    await vi.advanceTimersByTimeAsync(300);
    expect(loaded).toEqual([1]);

    store.emit("doc");                             // the new project
    await vi.advanceTimersByTimeAsync(300);
    expect(loaded).toEqual([1]);                   // nothing loaded on top
    expect(log).toEqual(["extras:none", "clear", "extras:none"]);
  });
});

describe("what rebuilds the preview", () => {
  it("an edit, not a change of view", async () => {
    const { store, s, loaded } = session();
    built.mockImplementation(async () => result(1));
    s.invalidate();
    await vi.advanceTimersByTimeAsync(300);
    store.emit("stage");                           // Play mode, a view flag
    store.emit("timeline");                        // folding a group
    await vi.advanceTimersByTimeAsync(1000);
    expect(built).toHaveBeenCalledTimes(1);
    store.emit("doc");
    await vi.advanceTimersByTimeAsync(1000);
    expect(built).toHaveBeenCalledTimes(2);
    expect(loaded).toEqual([1, 1]);
  });
});

describe("the frame a tick reports", () => {
  it("is the frame on screen, never the next one or one past the end", () => {
    expect(tickFrame(0, 60, 1)).toBe(0);
    expect(tickFrame(0.0166, 60, 1)).toBe(0);          // a one-frame animation stays on it
    expect(tickFrame(0.07, 24, 24)).toBe(1);            // 1.68 frames in: still frame 1
    expect(tickFrame(0.1, 30, 10)).toBe(3);             // 2.9999… from float error is frame 3
    expect(tickFrame(0.999, 24, 24)).toBe(23);
    expect(tickFrame(1, 24, 24)).toBe(23);
    expect(tickFrame(0.5, 24, 0)).toBe(0);
  });
});
