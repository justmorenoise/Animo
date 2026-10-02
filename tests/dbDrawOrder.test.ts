import { beforeEach, describe, expect, it } from "vitest";
import { type AssetId, reseed } from "@/core/doc/ids";
import { buildDbImport, type DbImageRef } from "@/core/doc/dbImport";
import { exportSkeleton } from "@/core/export/exportSkeleton";
import { evaluateSymbol } from "@/core/doc/pose";
import type { NodeId } from "@/core/doc/ids";
import type { Project, SymbolItem } from "@/core/doc/types";

beforeEach(() => reseed());

const images = new Map<string, DbImageRef>([["hand", { assetId: "s1" as AssetId, width: 30, height: 30 }]]);
type Json = Record<string, unknown>;
const open = (arm: Json, drawOrder?: "rig" | "keys") => buildDbImport({
  name: "x", drawOrder, images,
  skeleton: { name: "t", version: "5.5", frameRate: 24, armature: [{ name: "rig", bone: [], slot: [], skin: [], animation: [], ...arm }] },
});
const rootOf = (p: Project) => p.items[p.rootSymbolId] as SymbolItem;

/** What is drawn, back to front (the order of `entries`), with its matrix, at every frame of every animation. */
function frames(sym: SymbolItem) {
  return sym.animations.flatMap((anim) => Array.from({ length: anim.duration }, (_, f) =>
    evaluateSymbol(sym, anim, f).entries.filter((e) => e.visible && e.display).map((e) => ({ name: e.node.name, m: e.world }))));
}

// Back to front: a1 (under A), b1 (under B), a2 (under A). A turns, B moves, a chain of two bones reaches for an IK target.
const slot = (name: string, parent: string, x = 0) => ({ name, parent, x });
const rig = (slots: Array<{ name: string; parent: string }>) => ({
  bone: [
    { name: "A", length: 40 }, { name: "A2", parent: "A", length: 30, transform: { x: 40 } },
    { name: "B", transform: { x: 100 } }, { name: "T", transform: { x: 50, y: 40 } },
  ],
  ik: [{ name: "ik", bone: "A2", target: "T", chain: 1 }],
  slot: slots.map(({ name, parent }) => ({ name, parent })),
  skin: [{ slot: slots.map((s) => ({ name: s.name, display: [{ name: "hand", transform: { x: 5, skX: 10, skY: 10 } }] })) }],
  animation: [{
    name: "go", duration: 8, playTimes: 0,
    bone: [
      { name: "A", rotateFrame: [{ duration: 8, tweenEasing: 0, rotate: 0 }, { duration: 0, rotate: 60 }] },
      { name: "B", translateFrame: [{ duration: 8, tweenEasing: 0, x: 0 }, { duration: 0, x: -80, y: 20 }] },
      { name: "T", translateFrame: [{ duration: 8, tweenEasing: 0, x: 0 }, { duration: 0, x: -30, y: 10 }] },
    ],
  }],
});

describe("draw order the rig cannot keep", () => {
  const slots = [slot("a1", "A"), slot("b1", "B"), slot("a2", "A2")];

  it("names the slots out of order, and only when there are some", () => {
    const { outOfOrder } = open(rig(slots));
    expect(outOfOrder).toEqual([{ armature: "rig", slots: ["b1"] }]);
    expect(open(rig([slot("a1", "A"), slot("a2", "A2"), slot("b1", "B")])).outOfOrder).toEqual([]);
  });

  it("keys: the file's order on every frame, and every slot where the rig put it", () => {
    const rigged = frames(rootOf(open(rig(slots)).project));
    reseed();
    const { project, warnings, outOfOrder } = open(rig(slots), "keys");
    const keyed = frames(rootOf(project));
    expect(rigged[0]!.map((d) => d.name)).not.toEqual(["a1", "b1", "a2"]);
    expect(outOfOrder).toEqual([{ armature: "rig", slots: ["b1"] }]);
    expect(warnings.join(" ")).toMatch(/"b1" keep the file's draw order with a key on every frame/);
    expect(keyed.length).toBe(8);
    keyed.forEach((drawn, f) => {
      expect(drawn.map((d) => d.name), `frame ${f}`).toEqual(["a1", "b1", "a2"]);
      for (const d of drawn) {
        const r = rigged[f]!.find((x) => x.name === d.name)!;
        for (const k of ["a", "b", "c", "d", "tx", "ty"] as const) expect(d.m[k], `${d.name}@${f}.${k}`).toBeCloseTo(r.m[k], 4);
      }
    });
  });

  it("keys: a slot that was its bone's node is taken apart from it first", () => {
    // b1 named like its bone B: the rig makes them one node, which cannot move without B.
    const merged = [slot("a1", "A"), slot("B", "B"), slot("a2", "A2")];
    const rigged = frames(rootOf(open(rig(merged)).project));
    reseed();
    const { project, outOfOrder } = open(rig(merged), "keys");
    const sym = rootOf(project);
    expect(outOfOrder).toEqual([{ armature: "rig", slots: ["B"] }]);
    // Apart, and named apart (the export would put a slot sharing its bone's name back on the bone).
    // The slot keeps its name, which game code looks it up by; the bone is renamed.
    const names = Object.values(sym.nodes).map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.values(sym.nodes).find((n) => n.name === "B")!.kind).toBe("image");
    expect(Object.values(sym.nodes).find((n) => n.name === "B_2")!.kind).not.toBe("image");
    const out = exportSkeleton(project).skeleton.armature[0]!;
    const bones = out.bone.map((b) => b.name);
    expect(new Set(bones).size).toBe(bones.length);
    expect(out.slot.map((x) => x.name).sort()).toEqual(["B", "a1", "a2"]);
    frames(sym).forEach((drawn, f) => {
      expect(drawn.map((d) => d.name)).toEqual(["a1", "B", "a2"]);
      const b = drawn.find((d) => d.name === "B")!, r = rigged[f]!.find((x) => x.name === "B")!;
      expect(b.m.tx).toBeCloseTo(r.m.tx, 4);
      expect(b.m.ty).toBeCloseTo(r.m.ty, 4);
    });
  });

  it("a slot behind every kept one goes to the very back", () => {
    // B's two slots sit on either side of a1, and b1 behind everything.
    const back = [slot("b1", "B"), slot("a1", "A"), slot("c1", "B"), slot("a2", "A2")];
    const { project, outOfOrder } = open(rig(back), "keys");
    expect(outOfOrder[0]!.slots.length).toBeGreaterThan(0);
    for (const drawn of frames(rootOf(project))) expect(drawn.map((d) => d.name)).toEqual(["b1", "a1", "c1", "a2"]);
  });
});

describe("draw order, on random rigs", () => {
  /** Each row's depth puts it under its node's parent. */
  function rowsMatchParents(sym: SymbolItem): boolean {
    const stack: NodeId[] = [];
    return sym.layers.every((l) => {
      stack.length = l.depth;
      const ok = (sym.nodes[l.nodeId]!.parentId ?? null) === (stack[l.depth - 1] ?? null);
      stack[l.depth] = l.nodeId;
      return ok;
    });
  }
  let seed = 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!;

  it("keys: the file's order, the rig's picture and rows under their parents", () => {
    let cases = 0;
    for (let t = 0; t < 400; t++) {
      seed = t + 7;
      const bones: Json[] = [];
      for (let i = 0, n = 2 + Math.floor(rnd() * 5); i < n; i++) {
        const b: Json = { name: `b${i}`, length: rnd() < 0.5 ? 20 : 0, transform: { x: rnd() * 50, y: rnd() * 30, skX: rnd() * 90, skY: rnd() * 90, scX: rnd() < 0.2 ? -1 : 1 } };
        if (i > 0 && rnd() < 0.7) b.parent = `b${Math.floor(rnd() * i)}`;
        bones.push(b);
      }
      const slots: Json[] = [], skin: Json[] = [];
      for (let i = 0, n = 2 + Math.floor(rnd() * 6); i < n; i++) {
        const bone = pick(bones).name as string;
        const same = rnd() < 0.3 && !slots.some((s) => s.name === bone);
        const name = same ? bone : `s${i}`;
        const s: Json = { name, parent: bone };
        if (rnd() < 0.15) s.displayIndex = -1;
        if (rnd() < 0.2) s.color = { aM: 50 };
        slots.push(s);
        skin.push({ name, display: [{ name: "hand", transform: { x: rnd() * 10, skX: rnd() * 30, skY: rnd() * 30 } }] });
      }
      const dur = pick([1, 3, 5]);
      const arm = {
        bone: bones, slot: slots, skin: [{ slot: skin }],
        animation: [{
          name: "go", duration: dur, playTimes: 0,
          bone: bones.filter(() => rnd() < 0.6).map((b) => ({
            name: b.name,
            rotateFrame: [{ duration: dur, tweenEasing: 0, rotate: 0 }, { duration: 0, rotate: rnd() * 400 - 200 }],
            scaleFrame: [{ duration: dur, tweenEasing: 0, x: 1 }, { duration: 0, x: rnd() < 0.3 ? -1 : 1.5, y: 1.2 }],
          })),
          slot: slots.filter(() => rnd() < 0.4).map((s) => ({
            name: s.name,
            displayFrame: [{ duration: 1, value: 0 }, { duration: Math.max(0, dur - 1), value: -1 }],
            colorFrame: [{ duration: dur, tweenEasing: 0, value: { aM: 100 } }, { duration: 0, value: { aM: 20 } }],
          })),
        }],
      };
      reseed();
      const rig = open(arm);
      if (!rig.outOfOrder.length) continue;
      cases++;
      reseed();
      const sym = rootOf(open(arm, "keys").project);
      expect(rowsMatchParents(sym), `rig ${t}`).toBe(true);
      const rigged = frames(rootOf(rig.project));
      frames(sym).forEach((drawn, f) => {
        const names = drawn.map((d) => d.name);
        expect(names, `rig ${t} frame ${f}`).toEqual(slots.map((s) => s.name as string).filter((n) => names.includes(n)));
        expect([...names].sort(), `rig ${t} frame ${f}`).toEqual(rigged[f]!.map((d) => d.name).sort());
        for (const d of drawn) {
          const r = rigged[f]!.find((x) => x.name === d.name)!;
          for (const k of ["a", "b", "c", "d", "tx", "ty"] as const) expect(d.m[k], `rig ${t} ${d.name}@${f}.${k}`).toBeCloseTo(r.m[k], 3);
        }
      });
    }
    expect(cases).toBeGreaterThan(50);
  });

  it("keys: a parent scaled to nothing on a frame holds the frame before, and says so", () => {
    // B flips through scale 0 at frame 1; b1 is moved next to a2, under A.
    const arm = rig([slot("a1", "A"), slot("b1", "B"), slot("a2", "A2")]);
    const flip = { ...arm, animation: [{ name: "go", duration: 2, playTimes: 0, bone: [{ name: "A", scaleFrame: [{ duration: 2, tweenEasing: 0, x: 1 }, { duration: 0, x: -1 }] }] }] };
    const { project, warnings } = open(flip, "keys");
    expect(warnings.join(" ")).toMatch(/"b1" hangs from a node scaled to nothing on 1 frame\(s\)/);
    const keys = rootOf(project).animations[0]!.tracks[Object.values(rootOf(project).nodes).find((n) => n.name === "b1")!.id]!.keys;
    expect(keys[1]!.transform).toEqual(keys[0]!.transform);
  });
});

describe("the question", () => {
  it("names a few slots per armature and counts the rest", async () => {
    const { drawOrderMessage } = await import("@/app/ProjectService");
    const msg = drawOrderMessage([{ armature: "hero", slots: ["a", "b"] }, { armature: "mecha", slots: ["1", "2", "3", "4", "5", "6"] }]);
    expect(msg).toContain(`"a", "b" in "hero"; "1", "2", "3", "4" and 2 more in "mecha".`);
    expect(msg).toMatch(/Rebuild with Keyframes.*no longer follow their bones or IK/);
    expect(msg).toMatch(/Keep the Rig.*fix by hand/);
  });
});
