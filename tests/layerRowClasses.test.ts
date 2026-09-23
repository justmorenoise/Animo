import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rowClasses } from "@/view/timeline/LayerList";
import { createLayer } from "@/core/doc/defaults";
import type { NodeId } from "@/core/doc/ids";
import type { Layer } from "@/core/doc/types";

/**
 * The one thing about a timeline row that unit tests can check without a DOM:
 * the classes it asks for exist, are scoped, and collide with nothing.
 *
 * This is here because a real bug got through everything else. An empty layer
 * used to carry a bare `empty`, which is ALSO the app's empty-state class
 * (`.empty { min-height: 60px; padding: 12px }` in panels.css). The row grew
 * to three times its height; the frame grid, which draws fixed-height rows on
 * a canvas, kept its own spacing, so the two columns drifted apart and the
 * layers below the new one looked like they had been moved INSIDE it. The
 * document was right the whole time — which is exactly why the model tests
 * passed.
 */

const STYLES = fileURLToPath(new URL("../src/styles/", import.meta.url));
const css = readdirSync(STYLES)
  .filter((f) => f.endsWith(".css"))
  .map((f) => ({ file: f, text: readFileSync(STYLES + f, "utf8") }));

const layer = (patch: Partial<Layer> = {}): Layer =>
  Object.assign(createLayer("n1" as NodeId, "Layer 1", 0), patch);

const modifiers = (classes: string) => classes.split(" ").filter((c) => c !== "tl-layer");

describe("timeline row classes", () => {
  it("names an empty layer without borrowing the empty-state class", () => {
    const classes = rowClasses(layer(), "empty", true).split(" ");
    expect(classes).toContain("tl-layer");
    expect(classes).toContain("emptylayer");
    expect(classes).not.toContain("empty");
  });

  it("emits one modifier per flag, and nothing when there is none", () => {
    expect(rowClasses(layer(), "image", false)).toBe("tl-layer");
    expect(modifiers(rowClasses(layer(), "group", false))).toEqual(["group"]);
    expect(modifiers(rowClasses(layer({ isMask: true }), "image", false))).toEqual(["mask"]);
    expect(modifiers(rowClasses(layer({ maskedBy: "l1" as never }), "image", false)))
      .toEqual(["masked"]);
    expect(modifiers(rowClasses(layer({ excludeFromExport: true }), "image", false)))
      .toEqual(["noexport"]);
    // IK role is not a layer flag: it lives in `symbol.ik`, and the row is
    // told about it because a target is parented outside the chain it drives.
    expect(modifiers(rowClasses(layer(), "bone", false, "target"))).toEqual(["iktarget"]);
    expect(modifiers(rowClasses(layer(), "bone", false, "driven"))).toEqual(["ikdriven"]);
  });

  it("styles every modifier UNDER .tl-layer, and never as a global class", () => {
    const all = new Set<string>();
    for (const kind of ["image", "symbol", "group", "bone", "empty"] as const) {
      for (const l of [
        layer(), layer({ isMask: true }), layer({ maskedBy: "l1" as never }),
        layer({ excludeFromExport: true }),
      ]) {
        for (const role of [null, "target", "driven"] as const) {
          for (const c of modifiers(rowClasses(l, kind, true, role))) all.add(c);
        }
      }
    }
    expect(all.size).toBeGreaterThan(4);

    for (const cls of all) {
      const scoped = css.some((f) => f.text.includes(`.tl-layer.${cls}`));
      expect(scoped, `${cls} has no .tl-layer.${cls} rule`).toBe(true);

      // A rule on the bare class anywhere in the app would also hit the row,
      // which is the collision that stretched it.
      const bare = new RegExp(`(^|[,}]|\\*/)\\s*\\.${cls}\\s*[,{]`, "m");
      for (const f of css) {
        expect(bare.test(f.text), `${f.file} styles ".${cls}" globally`).toBe(false);
      }
    }
  });

  it("still catches the collision it was written for", () => {
    // Guards the guard: if `.empty` ever stops being a global rule, the check
    // above would pass for the wrong reason.
    const bareEmpty = /(^|[,}])\s*\.empty\s*[,{]/m;
    expect(css.some((f) => bareEmpty.test(f.text))).toBe(true);
  });
});
