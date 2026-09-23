import { describe, it, expect } from "vitest";
import { Store, SNAP_TARGETS } from "@/app/Store";
import { createProject } from "@/core/doc/defaults";

/**
 * The stage-bar button and the View ▸ Snap To submenu are two settings, not
 * one: the button turns the feature off without forgetting which targets the
 * user had chosen, and the submenu can empty the set behind its back.
 */
function store(): Store {
  return new Store(createProject("t"));
}

describe("toggleSnapping", () => {
  it("turns snapping off and leaves the targets alone", () => {
    const s = store();
    s.setSnapTarget("toPixel", false);
    s.setSnapTarget("toStage", false);
    s.toggleSnapping();

    expect(s.ui.snap).toBe(false);
    expect(s.snappingOn).toBe(false);
    expect(s.prefs.value.snap.toGrid).toBe(true);
    expect(s.prefs.value.snap.toStage).toBe(false);
  });

  it("restores the same set when switched back on", () => {
    const s = store();
    s.setSnapTarget("toObjects", false);
    s.toggleSnapping();
    s.toggleSnapping();

    expect(s.ui.snap).toBe(true);
    expect(s.prefs.value.snap.toObjects).toBe(false);
    expect(s.prefs.value.snap.toGrid).toBe(true);
  });

  it("reads as off once the last target is unticked", () => {
    const s = store();
    for (const t of SNAP_TARGETS) s.setSnapTarget(t.key, false);

    // The switch is still on, but a drag would snap to nothing — a lit button
    // that does nothing is worse than an unlit one.
    expect(s.ui.snap).toBe(true);
    expect(s.snappingOn).toBe(false);
  });

  it("turns everything back on when there is nothing left to snap to", () => {
    const s = store();
    for (const t of SNAP_TARGETS) s.setSnapTarget(t.key, false);
    s.toggleSnapping();

    expect(s.snappingOn).toBe(true);
    for (const t of SNAP_TARGETS) expect(s.prefs.value.snap[t.key]).toBe(true);
  });
});
