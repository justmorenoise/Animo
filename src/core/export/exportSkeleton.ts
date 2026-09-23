import type { DisplayRef, Layer, Node, Project, SymbolItem } from "@/core/doc/types";
import { isDefaultColor, isImage, isSymbol, producesSlot } from "@/core/doc/types";
import { descendantsOf, maskGroups } from "@/core/doc/layerTree";
import { displaysOf, itemsOf } from "@/core/doc/displays";
import type { MaskLink } from "@/runtime/animo-pixi";
import type { ItemId, NodeId } from "@/core/doc/ids";
import { nz } from "@/core/math/angle";
import { buildBoneTimeline, buildSlotTimeline } from "./frameSplit";
import {
    DB_COMPATIBLE_VERSION,
    DB_VERSION,
    type DbAnimation,
    type DbArmature,
    type DbBone,
    type DbColor,
    type DbDisplay,
    type DbIk,
    type DbSkeleton,
    type DbSkin,
    type DbSkinSlot,
    type DbSlot,
    type DbTransform,
} from "./dbTypes";

export interface ExportDiagnostic {
  severity: "error" | "warning";
  message: string;
}

export interface SkeletonResult {
  skeleton: DbSkeleton;
  diagnostics: ExportDiagnostic[];
  /** Library image ids actually referenced, so the atlas packs only those. */
  usedImages: ItemId[];
  /**
   * Mask links, which the skeleton CANNOT carry — DragonBones has no mask
   * concept — so they ship beside it as the `ANIMO_masks` extension.
   */
  masks: MaskLink[];
  /** armature -> slot -> motion blur multiplier, only where it is not 1. */
  motionBlurSlots: Record<string, Record<string, number>>;
}

/**
 * Project -> DragonBones 5.5 skeleton JSON.
 *
 * Symbol === Armature. The main scene is the root armature; every other
 * symbol referenced from it becomes a child armature, reached from a slot
 * whose display has `type: "armature"`.
 */
export function exportSkeleton(project: Project): SkeletonResult {
  const diagnostics: ExportDiagnostic[] = [];
  const usedImages = new Set<ItemId>();
  const masks: MaskLink[] = [];
  const motionBlurSlots: Record<string, Record<string, number>> = {};

  const order = symbolsInDependencyOrder(project, diagnostics);
  const armatures: DbArmature[] = [];

  for (const symId of order) {
    const sym = project.items[symId];
    if (!isSymbol(sym)) continue;
    armatures.push(exportArmature(project, sym, diagnostics, usedImages, masks, motionBlurSlots));
  }
  reportNameClashes(project, order, "symbols", "armature", diagnostics);
  reportNameClashes(project, [...usedImages], "images", "texture", diagnostics);

  return {
    skeleton: {
      name: project.name,
      version: DB_VERSION,
      compatibleVersion: DB_COMPATIBLE_VERSION,
      frameRate: project.frameRate,
      armature: armatures,
    },
    diagnostics,
    usedImages: [...usedImages],
    masks,
    motionBlurSlots,
  };
}

/**
 * The runtime finds armatures and atlas textures by NAME, so two exported
 * library items sharing one make the factory hand out the same one for both —
 * the second image draws the first's pixels, the second symbol builds the
 * first's rig. Nothing about that fails; it has to be refused here.
 */
function reportNameClashes(
  project: Project, ids: ItemId[], what: string, looksUp: string, diags: ExportDiagnostic[],
): void {
  const count = new Map<string, number>();
  for (const id of ids) {
    const name = project.items[id]?.name;
    if (name !== undefined) count.set(name, (count.get(name) ?? 0) + 1);
  }
  for (const [name, n] of count) {
    if (n < 2) continue;
    diags.push({
      severity: "error",
      message:
        `${n} ${what} in the library are called "${name}". DragonBones finds each ${looksUp} ` +
        `by name, so all but one would show the wrong one. Give them different names.`,
    });
  }
}

/**
 * Symbols reachable from the root, dependencies first. Cycles are reported
 * and broken rather than allowed to recurse forever — a hand-edited project
 * file must not be able to hang the exporter.
 */
function symbolsInDependencyOrder(project: Project, diags: ExportDiagnostic[]): ItemId[] {
  const out: ItemId[] = [];
  const state = new Map<ItemId, "visiting" | "done">();

  const visit = (id: ItemId, stack: ItemId[]): void => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") {
      const names = [...stack, id].map((x) => project.items[x]?.name ?? x).join(" -> ");
      diags.push({ severity: "error", message: `Symbols contain each other: ${names}` });
      return;
    }
    const sym = project.items[id];
    if (!isSymbol(sym)) return;

    state.set(id, "visiting");
    // An instance on an excluded layer is not in the file, so the armature it
    // points at is only needed if something that IS exported uses it too.
    const skipped = excludedNodes(sym);
    for (const node of Object.values(sym.nodes)) {
      if (skipped.has(node.id)) continue;
      for (const itemId of itemsOf(node)) {
        if (isSymbol(project.items[itemId])) visit(itemId, [...stack, id]);
      }
    }
    state.set(id, "done");
    out.push(id);
  };

  visit(project.rootSymbolId, []);
  return out;
}

/**
 * The bind-pose colour as `slot.color`, or undefined when neutral.
 *
 * Only the MULTIPLIERS survive the trip: `PixiSlot._updateColor` reads
 * `alphaMultiplier` into `display.alpha` and packs the three colour
 * multipliers into `display.tint`, and never touches the four offsets even
 * though the parser and the tween state carry them. An offset therefore
 * renders on the stage and vanishes in the runtime, so it is reported rather
 * than emitted silently.
 */
function colorToDb(node: Node, diags: ExportDiagnostic[]): DbColor | undefined {
  const c = node.color;
  if (!c || isDefaultColor(c)) return undefined;
  if (c.aO !== 0 || c.rO !== 0 || c.gO !== 0 || c.bO !== 0) {
    diags.push({
      severity: "warning",
      message:
        `"${node.name}" uses colour offsets, which DragonBones in Pixi ignores: ` +
        `only the multipliers will be visible.`,
    });
  }
  const out: DbColor = {};
  if (c.aM !== 100) out.aM = c.aM;
  if (c.rM !== 100) out.rM = c.rM;
  if (c.gM !== 100) out.gM = c.gM;
  if (c.bM !== 100) out.bM = c.bM;
  if (c.aO !== 0) out.aO = c.aO;
  if (c.rO !== 0) out.rO = c.rO;
  if (c.gO !== 0) out.gO = c.gO;
  if (c.bO !== 0) out.bO = c.bO;
  return out;
}

/**
 * Turn this symbol's mask layers into slot-name links for the sidecar.
 *
 * A mask whose own layer produces no slot (a bone, or a node whose library
 * item is gone) cannot clip anything, and a mask with no surviving targets is
 * dropped — leaving either in the manifest would make `ANIMO_masks` silently
 * no-op at runtime instead of saying so here.
 */
function collectMasks(
  project: Project, sym: SymbolItem, names: Map<NodeId, string>, skipped: Set<NodeId>,
  out: MaskLink[], diags: ExportDiagnostic[],
): void {
  for (const [maskLayerId, masked] of maskGroups(sym)) {
    const maskLayer = sym.layers.find((l) => l.id === maskLayerId);
    const maskNode = maskLayer && sym.nodes[maskLayer.nodeId];
    if (maskNode && skipped.has(maskNode.id)) continue;
    if (!maskNode || !producesSlot(maskNode)) {
      if (maskLayer) {
        diags.push({
          severity: "warning",
          message: `Mask layer "${maskLayer.name}" has no artwork to clip with; skipped.`,
        });
      }
      continue;
    }

    if (itemsOf(maskNode).some((id) => isSymbol(project.items[id]))) {
      diags.push({
        severity: "warning",
        message:
          `Mask layer "${maskLayer!.name}" shows a symbol, but a mask can only use an image: ` +
          `the exported mask will be a plain rectangle there.`,
      });
    }

    const targets: string[] = [];
    for (const layer of masked) {
      const node = sym.nodes[layer.nodeId];
      if (node && producesSlot(node) && !skipped.has(node.id)) targets.push(names.get(node.id)!);
    }
    if (targets.length === 0) continue;

    out.push({ armature: sym.name, mask: names.get(maskNode.id)!, targets });
  }
}

/**
 * Nodes that never reach the file: layers the user marked "Exclude from
 * Export" (with their whole subtree — excluding a group has to take its
 * contents with it, or the children would silently reparent to the armature
 * root and move), plus the "empty" placeholders that hold empty layers open.
 *
 * Filtering only the slot would leave a bone and a full set of timelines
 * behind for artwork nobody can see, so every walk in `exportArmature`
 * consults this one set.
 */
function excludedNodes(sym: SymbolItem): Set<NodeId> {
  const out = new Set<NodeId>();
  for (const layer of sym.layers) {
    if (!layer.excludeFromExport) continue;
    out.add(layer.nodeId);
    for (const id of descendantsOf(sym, layer.nodeId)) out.add(id);
  }
  for (const node of Object.values(sym.nodes)) {
    if (node.kind === "empty") out.add(node.id);
  }
  return out;
}

function exportArmature(
  project: Project, sym: SymbolItem,
  diags: ExportDiagnostic[], usedImages: Set<ItemId>, masks: MaskLink[],
  motionBlurSlots: Record<string, Record<string, number>>,
): DbArmature {
  // Bone and slot names are the runtime's only handle on a node, so they
  // have to be unique within the armature. Rename collisions rather than
  // emitting a file the runtime would silently mis-wire.
  const names = uniqueNames(sym, diags);

  const skipped = excludedNodes(sym);
  reportExcluded(sym, skipped, diags);

  // A skipped node that still has a KEPT descendant keeps its bone — never
  // its slot — because dropping it would reparent that descendant to the
  // armature root and move it. Only an "empty" node can get here: excluding a
  // layer already takes its whole subtree.
  const boneOnly = new Set<NodeId>();
  for (const node of Object.values(sym.nodes)) {
    if (skipped.has(node.id)) continue;
    for (let p = node.parentId; p; p = sym.nodes[p]?.parentId ?? null) {
      if (skipped.has(p)) boneOnly.add(p);
    }
  }
  const dropped = (id: NodeId): boolean => skipped.has(id) && !boneOnly.has(id);

  const bones: DbBone[] = [];
  for (const node of nodesInHierarchyOrder(sym)) {
    if (dropped(node.id)) continue;
    const bone: DbBone = { name: names.get(node.id)! };
    const parentName = node.parentId ? names.get(node.parentId) : undefined;
    if (parentName) bone.parent = parentName;
    const t = transformToDb(node);
    if (t) bone.transform = t;
    if (node.kind === "bone" && node.boneLength) bone.length = Math.round(node.boneLength);
    if (node.inheritRotation === false) bone.inheritRotation = false;
    if (node.inheritScale === false) bone.inheritScale = false;
    bones.push(bone);
  }

  // DragonBones draws LATER entries in slot[] in front, and layers[0] is the
  // TOP layer in the UI, so the slot array is the layer list reversed.
  const drawOrder: Layer[] = [...sym.layers].reverse();

  const slots: DbSlot[] = [];
  const skinSlots: DbSkinSlot[] = [];
  const displayMaps = new Map<NodeId, Map<number, number>>();

  for (const layer of drawOrder) {
    const node = sym.nodes[layer.nodeId];
    if (!node || !producesSlot(node) || skipped.has(node.id)) continue;
    const name = names.get(node.id)!;

    const exported = exportedDisplays(sym, node);

    const slot: DbSlot = { name, parent: name };
    if (node.blendMode && node.blendMode !== "normal") {
      // `PixiSlot._updateBlendMode` is guarded by `instanceof PIXI.Sprite`, so
      // a child-armature display (a Container) never receives one.
      if (node.kind === "symbol") {
        diags.push({
          severity: "warning",
          message:
            `"${node.name}" is a symbol, so its blend mode ` +
            `"${node.blendMode}" is ignored by DragonBones in Pixi.`,
        });
      } else {
        slot.blendMode = node.blendMode;
        if (exported.refs.some((d) => isSymbol(project.items[d.itemId]))) {
          diags.push({
            severity: "warning",
            message:
              `"${node.name}" shows a symbol at some keyframes. Its blend mode ` +
              `"${node.blendMode}" applies only where it shows an image.`,
          });
        }
      }
    }
    const setupColor = colorToDb(node, diags);
    if (setupColor) slot.color = setupColor;
    slots.push(slot);
    if (node.motionBlur !== undefined && node.motionBlur !== 1) {
      (motionBlurSlots[sym.name] ??= {})[name] = node.motionBlur;
    }

    // A display whose item is gone is left out and its keys hide, rather
    // than leaving a hole that would shift every later index.
    const display: DbDisplay[] = [];
    const placed = new Map<number, number>();
    exported.refs.forEach((ref, i) => {
      const built = buildDisplay(project, node, ref, diags, usedImages);
      if (!built) return;
      placed.set(i, display.length);
      display.push(built);
    });
    const map = new Map<number, number>();
    for (const [from, to] of exported.map) {
      const at = placed.get(to);
      if (at !== undefined) map.set(from, at);
    }
    displayMaps.set(node.id, map);
    skinSlots.push({ name, display });
  }

  const skin: DbSkin[] = [{ name: "", slot: skinSlots }];

  collectMasks(project, sym, names, skipped, masks, diags);

  const ik: DbIk[] = [];
  for (const k of sym.ik) {
    const boneName = dropped(k.boneId) ? undefined : names.get(k.boneId);
    const targetName = dropped(k.targetId) ? undefined : names.get(k.targetId);
    if (!boneName || !targetName) {
      diags.push({ severity: "warning", message: `IK "${k.name}" references a missing bone; skipped.` });
      continue;
    }
    const entry: DbIk = { name: k.name, bone: boneName, target: targetName };
    if (k.chain) entry.chain = k.chain;
    if (!k.bendPositive) entry.bendPositive = false;
    if (k.weight !== 1) entry.weight = k.weight;
    ik.push(entry);
  }

  const animation: DbAnimation[] = sym.animations.map((anim) => {
    const boneTimelines = [];
    const slotTimelines = [];
    for (const node of Object.values(sym.nodes)) {
      const track = anim.tracks[node.id];
      if (!track || dropped(node.id)) continue;
      const bt = buildBoneTimeline(track, { ...node, name: names.get(node.id)! }, anim.duration);
      if (bt) boneTimelines.push(bt);
      if (producesSlot(node) && !skipped.has(node.id)) {
        const st = buildSlotTimeline(track, names.get(node.id)!, anim.duration, displayMaps.get(node.id));
        if (st) slotTimelines.push(st);
      }
    }
    const out: DbAnimation = { name: anim.name, duration: anim.duration };
    if (anim.playTimes !== 1) out.playTimes = anim.playTimes;
    if (boneTimelines.length) out.bone = boneTimelines;
    if (slotTimelines.length) out.slot = slotTimelines;
    return out;
  });

  const armature: DbArmature = {
    name: sym.name,
    type: "Armature",
    frameRate: project.frameRate,
    bone: bones,
    slot: slots,
    skin,
    animation,
  };
  if (ik.length) armature.ik = ik;

  // Child armatures have their own clock; without a default action a nested
  // symbol would sit frozen on its first frame.
  if (sym.id !== project.rootSymbolId && animation.length > 0) {
    armature.defaultActions = [{ gotoAndPlay: animation[0]!.name }];
  }

  return armature;
}

/**
 * The slot's display list as exported: display 0 always — the slot shows it
 * in the setup pose — and only the extra displays some key in some animation
 * still uses, so art a layer no longer shows stays out of the atlas. `map`
 * takes a key's `displayIndex` to its place in `refs`.
 */
function exportedDisplays(
  sym: SymbolItem, node: Node,
): { refs: DisplayRef[]; map: Map<number, number> } {
  const all = displaysOf(node);
  const used = new Set<number>([0]);
  for (const anim of sym.animations) {
    for (const k of anim.tracks[node.id]?.keys ?? []) {
      if (k.displayIndex > 0 && k.displayIndex < all.length) used.add(k.displayIndex);
    }
  }
  const refs: DisplayRef[] = [];
  const map = new Map<number, number>();
  for (const i of [...used].sort((a, b) => a - b)) {
    if (!all[i]) continue;
    map.set(i, refs.length);
    refs.push(all[i]!);
  }
  return { refs, map };
}

function buildDisplay(
  project: Project, node: Node, ref: DisplayRef,
  diags: ExportDiagnostic[], usedImages: Set<ItemId>,
): DbDisplay | null {
  const item = project.items[ref.itemId];

  if (isImage(item)) {
    usedImages.add(item.id);
    return {
      name: item.name,
      // Normalised against the UNTRIMMED size. The runtime multiplies this by
      // the SubTexture's `frame` (the original size) when one is present, so
      // normalising against the packed region would be off by the trim.
      pivot: {
        x: round4(ref.pivot.x / Math.max(1, item.width)),
        y: round4(ref.pivot.y / Math.max(1, item.height)),
      },
    };
  }

  if (isSymbol(item)) {
    // A nested symbol instance. `display.pivot` is for images only, but every
    // display type carries its own `transform`, which the runtime folds into
    // the SLOT's local matrix (`Slot._updateDisplayData` -> `_localMatrix`)
    // without touching the bone. That is exactly what a transform point needs
    // to be: the bone origin sits on it, and the child armature hangs off it
    // by -pivot, leaving any bones parented to this node where they were.
    const display: DbDisplay = { name: item.name, type: "armature" };
    if (ref.pivot.x !== 0 || ref.pivot.y !== 0) {
      display.transform = { x: round4(-ref.pivot.x), y: round4(-ref.pivot.y) };
    }
    return display;
  }

  diags.push({
    severity: "warning",
    message: `"${node.name}" points at a library item that no longer exists.`,
  });
  return null;
}

/**
 * Say out loud what was left out. An excluded layer is invisible in the file
 * and still visible on the stage, which is exactly the kind of divergence a
 * silent export turns into a bug report a week later.
 */
function reportExcluded(
  sym: SymbolItem, skipped: Set<NodeId>, diags: ExportDiagnostic[],
): void {
  const named = sym.layers.filter((l) => l.excludeFromExport && skipped.has(l.nodeId));
  if (named.length === 0) return;
  diags.push({
    severity: "warning",
    message:
      `Excluded from "${sym.name}": ${named.map((l) => `"${l.name}"`).join(", ")}` +
      `. Marked "Exclude from Export", so ${named.length === 1 ? "it is" : "they are"} ` +
      "left out of the exported files and the Preview.",
  });
}

/** Parents before children, so the JSON reads top-down like DragonBones Pro. */
function nodesInHierarchyOrder(sym: SymbolItem): Node[] {
  const out: Node[] = [];
  const emitted = new Set<NodeId>();

  const emit = (node: Node, depth: number): void => {
    if (emitted.has(node.id) || depth > 64) return;
    if (node.parentId) {
      const parent = sym.nodes[node.parentId];
      if (parent && !emitted.has(parent.id)) emit(parent, depth + 1);
    }
    if (emitted.has(node.id)) return;
    emitted.add(node.id);
    out.push(node);
  };

  // Layer order first so siblings keep a stable, meaningful order.
  for (const layer of sym.layers) {
    const node = sym.nodes[layer.nodeId];
    if (node) emit(node, 0);
  }
  for (const node of Object.values(sym.nodes)) emit(node, 0);
  return out;
}

/** DragonBones identifies bones and slots by name, so names must be unique. */
function uniqueNames(sym: SymbolItem, diags: ExportDiagnostic[]): Map<NodeId, string> {
  const map = new Map<NodeId, string>();
  const taken = new Set<string>();
  for (const layer of sym.layers) {
    const node = sym.nodes[layer.nodeId];
    if (!node) continue;
    assign(node);
  }
  for (const node of Object.values(sym.nodes)) if (!map.has(node.id)) assign(node);
  return map;

  function assign(node: Node): void {
    let name = node.name.trim() || node.kind;
    if (taken.has(name)) {
      const original = name;
      for (let i = 2; taken.has(name); i++) name = `${original}_${i}`;
      diags.push({
        severity: "warning",
        message: `Two objects in "${sym.name}" are called "${original}"; exported the second as "${name}".`,
      });
    }
    taken.add(name);
    map.set(node.id, name);
  }
}

/** Bind pose -> `transform`, omitting every default so the JSON stays small. */
function transformToDb(node: Node): DbTransform | undefined {
  const t = node.bind;
  const out: DbTransform = {};
  if (Math.abs(t.x) > 1e-4) out.x = round2(t.x);
  if (Math.abs(t.y) > 1e-4) out.y = round2(t.y);
  if (Math.abs(t.skewX) > 1e-4) out.skX = round4(t.skewX);
  if (Math.abs(t.skewY) > 1e-4) out.skY = round4(t.skewY);
  if (Math.abs(t.scaleX - 1) > 1e-4) out.scX = round4(t.scaleX);
  if (Math.abs(t.scaleY - 1) > 1e-4) out.scY = round4(t.scaleY);
  return Object.keys(out).length ? out : undefined;
}

function round2(v: number): number { return nz(Math.round(v * 100) / 100); }
function round4(v: number): number { return nz(Math.round(v * 10000) / 10000); }
