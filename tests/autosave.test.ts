import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Autosaver } from "@/io/project/Autosave";
import { History } from "@/core/history/History";
import { createProject } from "@/core/doc/defaults";

/**
 * Autosave writes the whole project to IndexedDB; the storage itself needs a
 * browser, but WHEN it tries to write does not, and that is what the
 * preferences promise the user.
 */

beforeEach(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function saver() {
  const snapshot = vi.fn(async () => { throw new Error("no storage in tests"); });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return { a: new Autosaver(() => true, snapshot, 30_000, 1_500), snapshot, warn };
}

describe("autosave", () => {
  it("saves after the editor goes quiet while it is on", async () => {
    const { a, snapshot } = saver();
    a.start();
    a.touch();
    await vi.advanceTimersByTimeAsync(1_600);
    expect(snapshot).toHaveBeenCalledTimes(1);
    a.stop();
  });

  it("writes nothing at all when it is turned off", async () => {
    const { a, snapshot } = saver();
    a.touch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshot).not.toHaveBeenCalled();

    a.start();
    a.stop();
    a.touch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshot).not.toHaveBeenCalled();
  });
});

describe("autosave and the preferences", () => {
  it("a preference write does not throw away the pending save", async () => {
    const { a, snapshot } = saver();
    a.start();
    a.touch();
    await vi.advanceTimersByTimeAsync(1_000);
    a.start();                       // what every preference write reaches
    a.setInterval(30_000);           // unchanged period
    await vi.advanceTimersByTimeAsync(600);
    expect(snapshot).toHaveBeenCalledTimes(1);
    a.stop();
  });

  it("a new period keeps the pending save too", async () => {
    const { a, snapshot } = saver();
    a.start();
    a.touch();
    await vi.advanceTimersByTimeAsync(1_000);
    a.setInterval(60_000);
    await vi.advanceTimersByTimeAsync(600);
    expect(snapshot).toHaveBeenCalledTimes(1);
    a.stop();
  });
});

describe("dirty state", () => {
  it("can be marked unsaved without a step, as recovered work is", () => {
    const history = new History(createProject("R"));
    expect(history.isDirty).toBe(false);
    history.markDirty();
    expect(history.isDirty).toBe(true);
    history.markSaved();
    expect(history.isDirty).toBe(false);
  });
});
