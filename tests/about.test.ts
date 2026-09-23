import { describe, expect, it } from "vitest";
import {
  APP_NAME, APP_TAGLINE, APP_VERSION, CREDITS, LICENSE_ID, LICENSE_NOTE,
  REPO_URL, TRADEMARK_NOTE,
} from "@/core/about";

/**
 * The About dialog is the only place the app states what it is built on, and a
 * credit that goes stale is a licence notice that is now wrong. Cheap to check,
 * and it is also what keeps THIRD-PARTY-NOTICES.md honest.
 */
describe("about", () => {
  it("names the app and its version", () => {
    expect(APP_NAME).toBe("Animo");
    expect(APP_TAGLINE).toContain("DragonBones");
    // vitest runs its own config, so the build-time token is never substituted.
    expect(APP_VERSION).toBe("dev");
  });

  it("credits every bundled dependency with a licence and a link", () => {
    expect(CREDITS.length).toBeGreaterThan(0);
    for (const c of CREDITS) {
      expect(c.name).not.toBe("");
      expect(c.license).not.toBe("");
      expect(c.what).not.toBe("");
      expect(c.url.startsWith("https://")).toBe(true);
    }
  });

  it("credits the two things the export depends on", () => {
    const names = CREDITS.map((c) => c.name);
    expect(names).toContain("DragonBones");
    expect(names).toContain("PixiJS");
  });

  it("states the licence and the export carve-out", () => {
    expect(LICENSE_ID).toBe("AGPL-3.0-or-later");
    // Without this sentence the licence would reach the games people ship.
    expect(LICENSE_NOTE).toContain("MIT");
    expect(TRADEMARK_NOTE).toContain("Egret");
    expect(REPO_URL.startsWith("https://github.com/")).toBe(true);
  });
});
