import { describe, it, expect, beforeEach } from "vitest";
import { reseed, type NodeId } from "@/core/doc/ids";
import { createProject, createNode, createLayer } from "@/core/doc/defaults";
import { isSymbol, type Project, type SymbolItem } from "@/core/doc/types";
import { History } from "@/core/history/History";
import type { Command } from "@/core/history/Command";
import {
  AddNode, RemoveNodes, ReorderLayer, SetParent, SetLayerMasks,
} from "@/core/history/commands";
import { ConvertToSymbol } from "@/core/history/symbolCommands";

beforeEach(() => reseed());

/** Deterministic, so a failure names a sequence that can be replayed. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Everything a structural command touches: order, parents, mask links —
 *  and, for Convert to Symbol, which symbols exist. */
function stateOf(project: Project, sym: SymbolItem): string {
  return JSON.stringify({
    items: Object.keys(project.items).sort(),
    layers: sym.layers.map((l) => [l.id, l.nodeId, l.isMask ?? null, l.maskedBy ?? null]),
    parents: Object.values(sym.nodes).map((n) => [n.id, n.parentId]).sort(),
  });
}

function scene() {
  const project = createProject("Undo");
  const sym = project.items[project.rootSymbolId];
  if (!isSymbol(sym)) throw new Error("no root");
  const add = (kind: "group" | "empty", name: string, parentId: NodeId | null = null) => {
    const node = createNode(kind, name, { parentId });
    sym.nodes[node.id] = node;
    sym.layers.push(createLayer(node.id, name, sym.layers.length));
    return node;
  };
  const g = add("group", "g");
  add("empty", "a", g.id);
  add("empty", "b", g.id);
  const mask = add("empty", "mask");
  const target = add("empty", "target");
  add("empty", "c");
  sym.layers.find((l) => l.nodeId === mask.id)!.isMask = true;
  sym.layers.find((l) => l.nodeId === target.id)!.maskedBy = sym.layers.find((l) => l.nodeId === mask.id)!.id;
  return { project, sym };
}

/** One structural command picked at random against the current document. */
function randomCommand(sym: SymbolItem, rnd: () => number, n: number): Command {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  if (sym.layers.length === 0) return addOne(sym, rnd, n, null);
  const layer = pick(sym.layers);
  switch (Math.floor(rnd() * 6)) {
    case 0:
      return new ReorderLayer(sym.id, layer.id, Math.floor(rnd() * sym.layers.length));
    case 1: {
      const groups = Object.values(sym.nodes).filter((x) => x.kind === "group");
      const parent = rnd() < 0.3 || groups.length === 0 ? null : pick(groups).id;
      return new SetParent(sym.id, [layer.nodeId], parent, rnd() < 0.5);
    }
    case 2: {
      // Make `layer` a mask over whatever sits below it, or unlink it.
      const i = sym.layers.indexOf(layer);
      const below = sym.layers[i + 1];
      if (layer.isMask || !below) return new SetLayerMasks(sym.id, new Map([[layer.id, {}]]));
      return new SetLayerMasks(sym.id, new Map([[layer.id, { isMask: true }], [below.id, { maskedBy: layer.id }]]));
    }
    case 3:
      if (sym.layers.length > 4) return new RemoveNodes(sym.id, [layer.nodeId]);
      return addOne(sym, rnd, n, layer.nodeId);
    case 4:
      return new ConvertToSymbol(sym.id, [layer.nodeId], `s${n}`);
    default:
      return addOne(sym, rnd, n, layer.nodeId);
  }
}

function addOne(sym: SymbolItem, rnd: () => number, n: number, near: NodeId | null): Command {
  const kind = rnd() < 0.3 ? "group" : "empty";
  const node = createNode(kind, `n${n}`, { parentId: rnd() < 0.5 ? near : null });
  return new AddNode(`Add n${n}`, sym.id, node, createLayer(node.id, node.name, 0),
    Math.floor(rnd() * (sym.layers.length + 1)));
}

describe("structural commands undo to exactly where they started", () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`random sequence ${seed}`, () => {
      const { project, sym } = scene();
      const history = new History(project, { maxEntries: 1000 });
      const rnd = prng(seed);
      const states = [stateOf(project, sym)];
      for (let n = 0; n < 60; n++) {
        history.apply(randomCommand(sym, rnd, n));
        states.push(stateOf(project, sym));
      }
      for (let i = states.length - 2; i >= 0; i--) {
        history.undo();
        expect(stateOf(project, sym), `undo back to step ${i}`).toBe(states[i]);
      }
      for (let i = 1; i < states.length; i++) {
        history.redo();
        expect(stateOf(project, sym), `redo to step ${i}`).toBe(states[i]);
      }
    });
  }
});
