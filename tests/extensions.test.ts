import { describe, it, expect, beforeEach, vi } from "vitest";
import { reseed, type AssetId } from "@/core/doc/ids";
import { createProject, createImageItem, createNode, createLayer } from "@/core/doc/defaults";
import { isSymbol, DOC_VERSION, type Project, type SymbolItem } from "@/core/doc/types";
import { exportSkeleton } from "@/core/export/exportSkeleton";
import { buildExtensionManifest, extensionReadme } from "@/core/export/extensions";
import { History } from "@/core/history/History";
import { SetDocumentSettings, SetNodeMotionBlur } from "@/core/history/commands";
import { migrate, validateProject } from "@/core/doc/schema";
import {
  installExtensions, blurDisplacement, shutterScale, trailLength, displacementToUv,
  nextBlurState, invertAffine, multiplyAffine, type Affine,
} from "@/runtime/animo-pixi.js";

beforeEach(() => reseed());

function scene(names: string[]): { project: Project; sym: SymbolItem } {
  const project = createProject("Run");
  const sym = project.items[project.rootSymbolId];
  if (!isSymbol(sym)) throw new Error("no root");
  names.forEach((name, i) => {
    const item = createImageItem(name, `asset_${name}` as AssetId, 50, 50);
    project.items[item.id] = item;
    project.itemOrder.push(item.id);
    const node = createNode("image", name, { itemId: item.id });
    sym.nodes[node.id] = node;
    sym.layers.unshift(createLayer(node.id, name, i));
  });
  return { project, sym };
}

const manifestOf = (project: Project) => buildExtensionManifest(project, exportSkeleton(project));

const I: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
const rotation = (deg: number, px = 0, py = 0): Affine => {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  // Rotate about (px, py).
  return { a: cos, b: sin, c: -sin, d: cos, tx: px - cos * px + sin * py, ty: py - sin * px - cos * py };
};

describe("extension manifest", () => {
  it("is null for a project that needs nothing beyond the skeleton", () => {
    expect(manifestOf(scene(["a", "b"]).project)).toBeNull();
  });

  it("marks masks REQUIRED and motion blur optional", () => {
    const { project, sym } = scene(["under", "clip"]);
    sym.layers[0]!.isMask = true;
    sym.layers[1]!.maskedBy = sym.layers[0]!.id;
    project.motionBlur = { enabled: true, shutter: 180, maxLength: 64 };

    const m = manifestOf(project)!;
    expect(m.format).toBe("animo-extensions");
    expect(m.extensionsUsed).toEqual(["ANIMO_masks", "ANIMO_motion_blur"]);
    expect(m.extensionsRequired).toEqual(["ANIMO_masks"]);
    expect(m.extensions.ANIMO_masks!.masks).toHaveLength(1);
    expect(m.extensions.ANIMO_motion_blur).toMatchObject({ shutter: 180, maxLength: 64, slots: {} });
  });

  it("leaves motion blur out when disabled or with a closed shutter", () => {
    const { project } = scene(["a"]);
    project.motionBlur = { enabled: false, shutter: 180, maxLength: 64 };
    expect(manifestOf(project)).toBeNull();
    project.motionBlur = { enabled: true, shutter: 0, maxLength: 64 };
    expect(manifestOf(project)).toBeNull();
  });

  it("writes only multipliers other than 1, by slot name, and skips excluded layers", () => {
    const { project, sym } = scene(["body", "foot", "eye"]);
    project.motionBlur = { enabled: true, shutter: 180, maxLength: 64 };
    const node = (name: string) => Object.values(sym.nodes).find((n) => n.name === name)!;
    node("foot").motionBlur = 1.5;
    node("eye").motionBlur = 0;
    node("body").motionBlur = 0.5;
    sym.layers.find((l) => l.name === "body")!.excludeFromExport = true;

    const slots = manifestOf(project)!.extensions.ANIMO_motion_blur!.slots;
    expect(slots).toEqual({ [sym.name]: { foot: 1.5, eye: 0 } });
  });

  it("documents the required and optional extensions in the README", () => {
    const { project, sym } = scene(["under", "clip"]);
    sym.layers[0]!.isMask = true;
    sym.layers[1]!.maskedBy = sym.layers[0]!.id;
    project.motionBlur = { enabled: true, shutter: 180, maxLength: 64 };
    const text = extensionReadme("Run", "Scene 1", manifestOf(project)!);
    const required = text.slice(text.indexOf("## Required"), text.indexOf("## Optional"));
    expect(required).toContain("ANIMO_masks");
    expect(required).not.toContain("ANIMO_motion_blur");
    expect(text).toContain('buildArmatureDisplay("Scene 1")');
  });
});

describe("motion blur in the document", () => {
  it("is undoable at both levels, leaving no key behind", () => {
    const { project, sym } = scene(["foot"]);
    const id = Object.keys(sym.nodes)[0] as never;
    const history = new History(project);

    history.apply(new SetDocumentSettings({ motionBlur: { enabled: true, shutter: 400 } }));
    expect(project.motionBlur).toEqual({ enabled: true, shutter: 360, maxLength: 64 });
    history.undo();
    expect("motionBlur" in project).toBe(false);

    history.apply(new SetNodeMotionBlur(sym.id, [id], 1.25));
    expect(sym.nodes[id]!.motionBlur).toBe(1.25);
    history.apply(new SetNodeMotionBlur(sym.id, [id], 1));
    expect("motionBlur" in sym.nodes[id]!).toBe(false);
    history.undo();
    expect(sym.nodes[id]!.motionBlur).toBe(1.25);
  });

  it("survives a round trip through migration and validation, repaired", () => {
    const { project, sym } = scene(["foot"]);
    const node = Object.values(sym.nodes)[0]!;
    const raw = JSON.parse(JSON.stringify({ ...project, version: 3 }));
    raw.motionBlur = { enabled: true, shutter: "x", maxLength: 99999 };
    raw.items[sym.id].nodes[node.id].motionBlur = 7;

    const { project: out } = validateProject(migrate(raw));
    expect(out.version).toBe(DOC_VERSION);
    expect(out.motionBlur).toEqual({ enabled: true, shutter: 180, maxLength: 4096 });
    expect((out.items[sym.id] as SymbolItem).nodes[node.id]!.motionBlur).toBe(2);
  });
});

describe("motion blur maths", () => {
  it("affine helpers invert and compose", () => {
    const m = { a: 2, b: 0.5, c: -1, d: 3, tx: 10, ty: -4 };
    const back = multiplyAffine(m, invertAffine(m)!);
    for (const [k, v] of Object.entries(I)) expect(back[k as keyof Affine]).toBeCloseTo(v, 12);
  });

  it("turns elapsed animation time into the shutter fraction of a frame", () => {
    // 180° at 24 fps is 1/48 s open. One tick of 1/48 s of animation: k = 1.
    expect(shutterScale(180, 24, 1 / 48)).toBeCloseTo(1, 12);
    expect(shutterScale(180, 24, 0)).toBe(0);
    expect(shutterScale(180, 24, -0.1)).toBe(0);
  });

  it("gives the same trail at 60 Hz and 120 Hz for the same motion", () => {
    // A sprite moving at 480 px per second of animation.
    const speed = 480;
    const trailAt = (hz: number) => {
      const dt = 1 / hz;
      const prev = { ...I };
      const curr = { ...I, tx: speed * dt };
      const disp = blurDisplacement(prev, curr, shutterScale(180, 24, dt))!;
      return trailLength(disp, [{ x: 0, y: 0 }]);
    };
    expect(trailAt(60)).toBeCloseTo(10, 9);        // 480 · (1/48)
    expect(trailAt(120)).toBeCloseTo(trailAt(60), 9);
  });

  it("blurs nothing at the pivot of a pure rotation and most at the tip", () => {
    // A foot rotating about its ankle at (100, 100): the origin-based formula
    // would report no motion at all.
    const prev = rotation(0, 100, 100);
    const curr = rotation(10, 100, 100);
    const disp = blurDisplacement(prev, curr, 1)!;
    expect(trailLength(disp, [{ x: 100, y: 100 }])).toBeCloseTo(0, 9);
    const tip = trailLength(disp, [{ x: 160, y: 100 }]);
    expect(tip).toBeCloseTo(2 * 60 * Math.sin((5 * Math.PI) / 180), 9);   // chord of 10° at r=60
    expect(tip).toBeGreaterThan(trailLength(disp, [{ x: 130, y: 100 }]));
  });

  it("re-expresses the field in filter UV space consistently", () => {
    const disp = { a: 0.1, b: -0.05, c: 0.02, d: -0.2, tx: 3, ty: 7 };
    const W = 200, H = 80, minX = 40, minY = -10;
    const uvDisp = displacementToUv(disp, W, H, minX, minY);
    const u = { x: 0.3, y: 0.7 };
    const g = { x: u.x * W + minX, y: u.y * H + minY };
    const worldDx = disp.a * g.x + disp.c * g.y + disp.tx;
    const worldDy = disp.b * g.x + disp.d * g.y + disp.ty;
    expect((uvDisp.a * u.x + uvDisp.c * u.y + uvDisp.tx) * W).toBeCloseTo(worldDx, 9);
    expect((uvDisp.b * u.x + uvDisp.d * u.y + uvDisp.ty) * H).toBeCloseTo(worldDy, 9);
  });

  it("switches with hysteresis rather than at one cut-off", () => {
    expect(nextBlurState(false, 0.6, 1)).toBe(false);
    expect(nextBlurState(false, 1.1, 1)).toBe(true);
    expect(nextBlurState(true, 0.6, 1)).toBe(true);
    expect(nextBlurState(true, 0.4, 1)).toBe(false);
  });
});

describe("installExtensions", () => {
  const fakePixi = { Texture: {}, Filter: null, Matrix: null };

  it("warns about an unknown REQUIRED extension and stays quiet about an optional one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = installExtensions({ armature: null }, {
      format: "animo-extensions", version: 1,
      extensionsUsed: ["XYZ_future", "XYZ_nice"],
      extensionsRequired: ["XYZ_future"],
      extensions: {},
    }, { PIXI: fakePixi });
    expect(handle.missing).toEqual(["XYZ_future", "XYZ_nice"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("XYZ_future");
    warn.mockRestore();
  });

  it("re-links a mask when a target swaps its display object", () => {
    // A layer that switches between an image and a nested symbol swaps the
    // Pixi object it shows, and the new one arrives with no `.mask`.
    const mask = { texture: null, mask: null as unknown };
    const target = { display: { mask: null as unknown } as { mask: unknown } };
    const slots: Record<string, unknown> = { m: { display: mask, displayList: [] }, t: target };
    const armature = {
      name: "scene",
      getSlots: () => Object.values(slots),
      getSlot: (name: string) => slots[name],
    };
    const handle = installExtensions({ armature }, {
      format: "animo-extensions", version: 1,
      extensionsUsed: ["ANIMO_masks"], extensionsRequired: ["ANIMO_masks"],
      extensions: { ANIMO_masks: { version: 1, masks: [{ armature: "scene", mask: "m", targets: ["t"] }] } },
    }, { PIXI: fakePixi });
    expect(target.display.mask).toBe(mask);

    target.display = { mask: null };
    handle.update(1 / 60);
    expect(target.display.mask).toBe(mask);
  });

  it("ignores something that is not a manifest", () => {
    const handle = installExtensions({}, { masks: [] } as never, { PIXI: fakePixi });
    expect(handle.installed).toEqual([]);
    expect(() => { handle.update(); handle.destroy(); }).not.toThrow();
  });
});
