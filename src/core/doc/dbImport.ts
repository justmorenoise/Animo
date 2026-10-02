/**
 * A DragonBones 5.x project read back as an Animo document: the inverse of
 * `core/export/exportSkeleton.ts`. Pure: the reader (`io/import/dbReader.ts`)
 * hands it the parsed JSON and the images it cut out of the atlas, already
 * registered as assets, which is what lets every mapping rule be tested.
 *
 *   armature → symbol; the one no other armature shows → the scene
 *   bone     → a bone node (a group when it has no length and no IK)
 *   slot     → a node under its bone, with the skin's displays; when the
 *              slot is its bone's only one, shares its name and sits at its
 *              origin, the two are one node, as Animo writes them
 *   ik       → an IK constraint
 *   timelines → keyframes (`dbTimeline.ts`)
 *
 * Draw order. DragonBones orders slots freely; Animo draws the layer list
 * depth first, so everything under a node is drawn together. Siblings are
 * sorted by the front-most slot they hold, which keeps the file's order for
 * any rig whose order follows its bones; slots it cannot keep are named in
 * the warnings.
 *
 * Dropped, and named in the warnings: meshes, bounding boxes and paths,
 * skins but the first, deform, z-order and IK timelines, events, sounds and
 * actions, and the inheritance flags Animo has no counterpart for.
 */
import type { MaskLink } from "@/runtime/animo-pixi";
import { type Matrix2D, invert, matOf } from "@/core/math/Matrix2D";
import { type Transform, tf } from "@/core/math/Transform";
import { type AssetId, type ItemId, newFolderId, newIkId, newItemId, type NodeId } from "./ids";
import {
  type BlendMode, DOC_VERSION, type DisplayRef, type IkConstraint, type ImageItem, type Layer, type LibraryFolder,
  type Node, type Project, type SymbolItem,
} from "./types";
import { createAnimation, createImageItem, createLayer, createNode, type NewProjectDefaults } from "./defaults";
import { normalizeMasks } from "./layerTree";
import { bakeDrawOrder } from "./dbDrawOrder";
import {
  allFrameChannels, anglesOf, asArr, asObj, bool, colorChannel, colorOf, displayChannel, keysFor, type NodeChannels, num,
  type Raw, rotateChannel, scaleChannel, str, translateChannel,
} from "./dbTimeline";

export interface DbImageRef {
  assetId: AssetId;
  /** The untrimmed size: what a display's pivot is a fraction of. */
  width: number;
  height: number;
}

export interface DbImportInput {
  /** The document's name; the skeleton's own when it has one. */
  name: string;
  /** The parsed `_ske.json`. */
  skeleton: unknown;
  /** Every SubTexture cut out of the atlas, by name. */
  images: ReadonlyMap<string, DbImageRef>;
  /** Animo's own `_ext.json`, when the file came from Animo: masks and motion blur. */
  extensions?: unknown;
  /** The stage, frame rate and background when the file gives none. */
  defaults?: NewProjectDefaults;
  /**
   * Slots the layer tree cannot draw in the file's order: left in the rig
   * and named (`"rig"`, the default), or moved to their place and keyed on
   * every frame, no longer following their bones (`"keys"`, `dbDrawOrder.ts`).
   */
  drawOrder?: "rig" | "keys";
}

export interface DbImportResult {
  project: Project;
  /** What was dropped or changed on the way in, one sentence each. */
  warnings: string[];
  /** The slots, by armature, that the rig cannot draw in the file's order: what `drawOrder` decides about. */
  outOfOrder: Array<{ armature: string; slots: string[] }>;
}

/** A file that is not a DragonBones project this importer reads. */
export class DbImportError extends Error {}

const DEFAULTS: NewProjectDefaults = { width: 800, height: 600, frameRate: 24, background: "#ffffff" };
const EPS = 1e-4;

/** DragonBones' blend mode names, as `DataParser._getBlendMode` reads them, to Animo's. */
const BLEND: Record<string, BlendMode> = {
  normal: "normal", add: "add", multiply: "multiply", screen: "screen", overlay: "overlay",
  darken: "darken", lighten: "lighten", difference: "difference", hardlight: "hardlight",
};
/** Its numbered form (`BlendMode` in the runtime). */
const BLEND_NUMBERS = ["normal", "add", "alpha", "darken", "difference", "erase", "hardlight", "invert", "layer", "lighten", "multiply", "overlay", "screen", "subtract"];

export function buildDbImport(input: DbImportInput): DbImportResult {
  const warnings: string[] = [];
  const warn = (m: string) => { if (!warnings.includes(m)) warnings.push(m); };
  const sk = asObj(input.skeleton);
  if (!sk || !Array.isArray(sk.armature)) throw new DbImportError("This is not a DragonBones skeleton (no armature list).");
  checkVersion(str(sk.version) || str(sk.compatibleVersion), warn);

  const armatures = asArr(sk.armature).map(asObj).filter((a): a is Raw => !!a);
  if (!armatures.length) throw new DbImportError("The skeleton has no armature.");
  const name = str(sk.name).trim() || input.name;
  const defaults = input.defaults ?? DEFAULTS;
  const frameRate = num(sk.frameRate, 0) > 0 ? num(sk.frameRate, 24) : defaults.frameRate;

  // The scene is the armature no other one shows; the first such in the file.
  const shown = new Set<string>();
  for (const arm of armatures) {
    for (const d of allDisplays(arm)) if (displayType(d) === "armature") shown.add(str(d.path) || str(d.name));
  }
  const root = armatures.find((a) => !shown.has(str(a.name))) ?? armatures[0]!;
  const others = armatures.filter((a) => a !== root && !shown.has(str(a.name)));
  if (others.length) warn(`${others.map((a) => `"${str(a.name)}"`).join(", ")}: shown by no other armature; kept in the library.`);
  for (const arm of armatures) {
    const rate = num(arm.frameRate, frameRate);
    if (rate !== frameRate) warn(`"${str(arm.name)}" runs at ${rate} fps; the document runs at ${frameRate}, as the skeleton says.`);
  }

  // Library names are unique across the library: armatures first, they are what game code asks for.
  const claimed = new Set<string>();
  const unique = (base: string, fallback: string) => {
    const stem = base.trim() || fallback;
    let n = stem;
    for (let i = 2; claimed.has(n); i++) n = `${stem}_${i}`;
    claimed.add(n);
    return n;
  };
  const folder: LibraryFolder = { id: newFolderId(), name, parentId: null };
  const symbols = new Map<string, SymbolItem>();
  for (const arm of armatures) {
    const armName = str(arm.name);
    if (symbols.has(armName)) { warn(`Two armatures are called "${armName}"; the second is left out.`); continue; }
    const sym: SymbolItem = { kind: "symbol", id: newItemId(), name: unique(armName, "Armature"), nodes: {}, layers: [], ik: [], animations: [] };
    if (sym.name !== armName) warn(`The armature "${armName}" is "${sym.name}" in the library: the name was taken.`);
    if (arm !== root) sym.folderId = folder.id;
    symbols.set(armName, sym);
  }
  const images = new Map<string, ImageItem>();
  const imageFor = (texture: string): ImageItem | null => {
    const known = images.get(texture);
    if (known) return known;
    const ref = input.images.get(texture);
    if (!ref) return null;
    const item = createImageItem(unique(texture, "image"), ref.assetId, ref.width, ref.height);
    item.folderId = folder.id;
    images.set(texture, item);
    return item;
  };

  const outOfOrder: DbImportResult["outOfOrder"] = [];
  const ctx: ArmatureContext = { symbols, imageFor, warn, drawOrder: input.drawOrder ?? "rig", outOfOrder };
  for (const arm of armatures) {
    const sym = symbols.get(str(arm.name));
    if (sym && !sym.layers.length && !sym.animations.length) buildArmature(arm, sym, ctx);
  }

  const rootSym = symbols.get(str(root.name))!;
  const stage = stageOf(root, rootSym, defaults);
  applyExtensions(input.extensions, symbols, warn);

  const project: Project = {
    version: DOC_VERSION,
    name,
    frameRate,
    stage: stage.settings,
    items: {},
    folders: { [folder.id]: folder },
    itemOrder: [],
    rootSymbolId: rootSym.id,
  };
  const mb = motionBlurOf(input.extensions);
  if (mb) project.motionBlur = mb;
  applyMotionBlurSlots(input.extensions, symbols);
  for (const item of [rootSym, ...[...symbols.values()].filter((s) => s !== rootSym), ...images.values()]) {
    project.items[item.id] = item;
    project.itemOrder.push(item.id);
  }
  return { project, warnings, outOfOrder };
}

function checkVersion(version: string, warn: (m: string) => void): void {
  const [major, minor] = version.split(".").map((v) => parseInt(v, 10));
  if (major === undefined || Number.isNaN(major)) {
    warn("The skeleton states no version; read as DragonBones 5.5.");
    return;
  }
  if (major < 5) {
    throw new DbImportError(`This is a DragonBones ${version} file. Open it in DragonBones Pro and export it again as 5.5.`);
  }
  if (major > 5 || (minor ?? 0) > 5) warn(`This is a DragonBones ${version} file, newer than 5.5: what 5.5 cannot hold is left out.`);
}

/* ── Displays ─────────────────────────────────────────────────────────────*/

const DISPLAY_TYPES = ["image", "armature", "mesh", "boundingBox", "path"];

function displayType(raw: Raw): string {
  if (typeof raw.type === "number") return DISPLAY_TYPES[raw.type] ?? "unknown";
  return str(raw.type, "image");
}

function skinOf(arm: Raw): Raw | null {
  const skins = asArr(arm.skin).map(asObj).filter((s): s is Raw => !!s);
  return skins.find((s) => str(s.name) === "" || str(s.name) === "default") ?? skins[0] ?? null;
}

function allDisplays(arm: Raw): Raw[] {
  return asArr(skinOf(arm)?.slot).flatMap((s) => asArr(asObj(s)?.display)).map(asObj).filter((d): d is Raw => !!d);
}

/** A DragonBones transform (`x, y, skX, skY, scX, scY`, or `rotate` and `skew`) as Animo's. */
export function transformOf(raw: unknown): Transform {
  const t = asObj(raw) ?? {};
  const { rotate, skew } = anglesOf(t);
  return tf(num(t.x, 0), num(t.y, 0), rotate + skew, rotate, num(t.scX, 1), num(t.scY, 1));
}

const linearOf = (t: Transform): Matrix2D => {
  const ry = (t.skewY * Math.PI) / 180, rx = (t.skewX * Math.PI) / 180;
  return matOf(Math.cos(ry) * t.scaleX, Math.sin(ry) * t.scaleX, -Math.sin(rx) * t.scaleY, Math.cos(rx) * t.scaleY, 0, 0);
};
const sameLinear = (a: Transform, b: Transform) =>
  Math.abs(a.skewX - b.skewX) < EPS && Math.abs(a.skewY - b.skewY) < EPS
  && Math.abs(a.scaleX - b.scaleX) < EPS && Math.abs(a.scaleY - b.scaleY) < EPS;
const isIdentityLinear = (t: Transform) => sameLinear(t, tf());

interface Display {
  kind: "image" | "symbol";
  itemId: ItemId;
  /** Image: its transform point in its own pixels. Symbol: 0, 0. */
  pivot: { x: number; y: number };
  transform: Transform;
  name: string;
}

interface ArmatureContext {
  symbols: Map<string, SymbolItem>;
  imageFor: (texture: string) => ImageItem | null;
  warn: (m: string) => void;
  drawOrder: "rig" | "keys";
  outOfOrder: DbImportResult["outOfOrder"];
}

function readDisplay(raw: Raw | null, slot: string, ctx: ArmatureContext): Display | null {
  if (!raw) return null;
  const type = displayType(raw);
  const target = str(raw.path) || str(raw.name);
  const transform = transformOf(raw.transform);
  if (type === "image") {
    const item = ctx.imageFor(target);
    if (!item) { ctx.warn(`Slot "${slot}": no texture "${target}" in the atlas; that display is left out.`); return null; }
    const p = asObj(raw.pivot);
    const px = p ? num(p.x, 0) : 0.5, py = p ? num(p.y, 0) : 0.5;
    return { kind: "image", itemId: item.id, pivot: { x: px * item.width, y: py * item.height }, transform, name: target };
  }
  if (type === "armature") {
    const sym = ctx.symbols.get(target);
    if (!sym) { ctx.warn(`Slot "${slot}" shows the armature "${target}", which the file does not have.`); return null; }
    if (asArr(raw.actions).length) ctx.warn(`Slot "${slot}": the actions on the armature "${target}" are left out; it plays its first animation.`);
    return { kind: "symbol", itemId: sym.id, pivot: { x: 0, y: 0 }, transform, name: target };
  }
  ctx.warn(`Slot "${slot}": ${type === "mesh" ? "meshes" : type === "boundingBox" ? "bounding boxes" : type === "path" ? "paths" : `"${type}" displays`} are not supported and are left out.`);
  return null;
}

/* ── Armatures ────────────────────────────────────────────────────────────*/

interface SlotInfo { raw: Raw; name: string; bone: string; z: number; displays: Array<Display | null> }

/** `noMerge`: bones whose slot stays a node of its own, under a name of its own, so it can move. */
function buildArmature(arm: Raw, sym: SymbolItem, ctx: ArmatureContext, noMerge: ReadonlySet<string> = new Set()): void {
  const { warn } = ctx;
  const armName = str(arm.name);
  const skins = asArr(arm.skin);
  if (skins.length > 1) warn(`"${armName}": only one skin is kept, "${str(skinOf(arm)?.name) || "default"}".`);

  const bonesRaw = asArr(arm.bone).map(asObj).filter((b): b is Raw => !!b);
  const bones = new Map<string, Raw>();
  for (const b of bonesRaw) {
    if (bones.has(str(b.name))) { warn(`"${armName}": two bones are called "${str(b.name)}"; the second is left out.`); continue; }
    const type = typeof b.type === "number" ? (b.type === 0 ? "bone" : "surface") : str(b.type, "bone");
    if (type !== "bone") { warn(`"${armName}": the surface "${str(b.name)}" is not supported and is left out.`); continue; }
    if (!bool(b.inheritTranslation, true) || !bool(b.inheritReflection, true)) warn(`"${armName}": bone "${str(b.name)}" does not inherit its parent's translation or reflection; Animo bones always do.`);
    bones.set(str(b.name), b);
  }
  // A parent that is, through its own parents, the bone itself would loop: the bone is a root.
  const parentOf = (bone: string): string | null => {
    const p = str(bones.get(bone)?.parent);
    if (!p || !bones.has(p)) return null;
    for (let up: string | null = p, n = 0; up && n <= bones.size; up = str(bones.get(up)?.parent) || null, n++) {
      if (up === bone) return null;
    }
    return p;
  };

  const skinSlots = new Map<string, unknown[]>();
  for (const s of asArr(skinOf(arm)?.slot)) {
    const r = asObj(s);
    if (r) skinSlots.set(str(r.name), asArr(r.display));
  }
  const slotNames = new Set<string>();
  const slots: SlotInfo[] = asArr(arm.slot).map(asObj).filter((s): s is Raw => {
    if (!s) return false;
    if (slotNames.has(str(s.name))) { warn(`"${armName}": two slots are called "${str(s.name)}"; the second is left out.`); return false; }
    slotNames.add(str(s.name));
    return true;
  }).map((raw, z) => {
    const name = str(raw.name);
    let bone = str(raw.parent);
    if (!bones.has(bone)) { warn(`"${armName}": slot "${name}" hangs from no bone; placed at the root.`); bone = ""; }
    return { raw, name, bone, z, displays: (skinSlots.get(name) ?? []).map((d) => readDisplay(asObj(d), name, ctx)) };
  });

  const ikRaw = asArr(arm.ik).map(asObj).filter((k): k is Raw => !!k);
  const inIk = new Set(ikRaw.flatMap((k) => [str(k.bone), str(k.target)]));

  // The front-most slot under each bone, its own slots included.
  const slotsOn = new Map<string, SlotInfo[]>();
  for (const s of slots) (slotsOn.get(s.bone) ?? slotsOn.set(s.bone, []).get(s.bone)!).push(s);
  const childBones = new Map<string, string[]>();
  for (const b of bones.keys()) {
    const p = parentOf(b) ?? "";
    (childBones.get(p) ?? childBones.set(p, []).get(p)!).push(b);
  }
  const frontUnder = (bone: string, seen = new Set<string>()): number => {
    if (seen.has(bone)) return -1;
    seen.add(bone);
    return Math.max(-1, ...(childBones.get(bone) ?? []).map((c) => Math.max(...(slotsOn.get(c) ?? []).map((s) => s.z), frontUnder(c, seen))));
  };

  /** A slot is its bone's node when Animo would have written them as one. */
  const merged = new Map<string, SlotInfo>();
  for (const [bone, on] of slotsOn) {
    const s = on[0]!;
    if (!bone || on.length !== 1 || s.name !== bone || inIk.has(bone) || noMerge.has(bone)) continue;
    const first = setupDisplay(s);
    if (!first) continue;
    const t = first.transform;
    const atOrigin = isIdentityLinear(t) && (first.kind === "symbol" || (Math.abs(t.x) < EPS && Math.abs(t.y) < EPS));
    // A node is drawn in front of everything under it.
    if (atOrigin && s.z > frontUnder(bone)) merged.set(bone, s);
  }

  // Nodes: names unique within the symbol, as the exporter needs them.
  const names = new Set<string>();
  const nodeName = (base: string) => {
    let n = base || "node";
    for (let i = 2; names.has(n); i++) n = `${base}_${i}`;
    names.add(n);
    return n;
  };
  // A slot taken apart from its bone keeps its name, which game code looks
  // slots up by; the bone, which it no longer follows, is renamed.
  for (const bname of noMerge) names.add(bname);
  const boneNodes = new Map<string, Node>();
  for (const [bname, b] of bones) {
    const m = merged.get(bname);
    const length = num(b.length, 0);
    const kind = m ? setupDisplay(m)!.kind : length > 0 || inIk.has(bname) ? "bone" : "group";
    const node = createNode(kind, nodeName(bname));
    node.bind = transformOf(b.transform);
    if (kind === "bone") node.boneLength = length;
    else delete node.boneLength;
    if (!bool(b.inheritRotation, true)) node.inheritRotation = false;
    if (!bool(b.inheritScale, true)) node.inheritScale = false;
    boneNodes.set(bname, node);
  }
  const renamed = [...noMerge].map((b) => `"${b}" is "${boneNodes.get(b)!.name}"`);
  if (renamed.length) warn(`"${armName}": bones renamed so that their slots keep their names: ${renamed.join(", ")}.`);
  for (const [bname, node] of boneNodes) {
    const p = parentOf(bname);
    node.parentId = p ? boneNodes.get(p)!.id : null;
  }

  const slotNodes = new Map<string, { node: Node; perm: (i: number) => number; hidden: boolean }>();
  for (const s of slots) {
    const m = merged.get(s.bone) === s;
    // A slot named after its bone keeps that name: the export writes it back
    // onto that bone, as DragonBones Pro does (`slotsOnTheirBone`).
    const sameAsBone = !m && s.bone !== "" && s.name === s.bone && boneNodes.get(s.bone)!.name === s.name;
    const reserved = s.name === s.bone && noMerge.has(s.bone);
    const node = m ? boneNodes.get(s.bone)! : createNode(setupDisplay(s)?.kind ?? "empty", sameAsBone || reserved ? s.name : nodeName(s.name));
    if (!m) {
      node.parentId = s.bone ? boneNodes.get(s.bone)!.id : null;
      if (node.name !== s.name) warn(`"${armName}": slot "${s.name}" shares its name with another node; it is "${node.name}" in Animo.`);
    }
    slotNodes.set(s.name, { node, ...displaysInto(node, s, !m, warn, armName) });
    if (asObj(s.raw.color)) node.color = colorOf(s.raw.color);
    const blend = blendOf(s.raw.blendMode);
    if (blend === null) warn(`"${armName}": slot "${s.name}" uses a blend mode Animo and DragonBones in Pixi do not draw; it is drawn normally.`);
    else if (blend !== "normal") node.blendMode = blend;
  }

  for (const node of [...boneNodes.values(), ...[...slotNodes.values()].map((s) => s.node)]) sym.nodes[node.id] = node;

  sym.ik = ikRaw.flatMap((k): IkConstraint[] => {
    const bone = boneNodes.get(str(k.bone)), target = boneNodes.get(str(k.target));
    if (!bone || !target) { warn(`"${armName}": IK "${str(k.name)}" names a bone the armature does not have; left out.`); return []; }
    return [{
      id: newIkId(), name: str(k.name) || `${bone.name}_ik`, boneId: bone.id, targetId: target.id,
      chain: num(k.chain, 0) > 0 ? 1 : 0, bendPositive: bool(k.bendPositive, true), weight: num(k.weight, 1),
    }];
  });

  const { layers, moved } = layersFor(sym, slots, boneNodes, slotNodes);
  sym.layers = layers;
  nodeOfSlot.set(sym, new Map([...slotNodes].map(([name, s]) => [name, s.node.id])));
  sym.animations = animationsOf(arm, boneNodes, slotNodes, warn);
  if (!sym.animations.length) sym.animations = [createAnimation()];
  if (!moved.length) return;

  const listed = moved.map((s) => `"${s.name}"`).join(", ");
  if (ctx.drawOrder === "rig") {
    if (noMerge.size === 0) ctx.outOfOrder.push({ armature: armName, slots: moved.map((s) => s.name) });
    warn(`"${armName}": ${listed} cannot keep the file's draw order, because Animo draws everything under a bone together; check them against the original.`);
    return;
  }
  // A slot that is its bone's node cannot move without the bone, and one that
  // only shares its name goes back onto the bone at export: build again with it apart.
  const apart = moved.filter((s) => s.bone && s.name === s.bone && !noMerge.has(s.bone)).map((s) => s.bone);
  if (apart.length) {
    Object.assign(sym, { nodes: {}, layers: [], ik: [], animations: [] });
    buildArmature(arm, sym, ctx, new Set([...noMerge, ...apart]));
    return;
  }
  ctx.outOfOrder.push({ armature: armName, slots: moved.map((s) => s.name) });
  const z = new Map(slots.map((s) => [slotNodes.get(s.name)!.node.id, s.z]));
  const flat = bakeDrawOrder(sym, z, new Set(moved.map((s) => slotNodes.get(s.name)!.node.id)));
  warn(`"${armName}": ${listed} keep the file's draw order with a key on every frame; they no longer follow their bones or IK.`);
  for (const [id, frames] of flat) {
    warn(`"${armName}": "${sym.nodes[id]!.name}" hangs from a node scaled to nothing on ${frames} frame(s), where it keeps the frame before.`);
  }
}

/** The display a slot shows in the setup pose, or its first when that one is hidden or gone. */
function setupDisplay(s: SlotInfo): Display | null {
  const at = Math.round(num(s.raw.displayIndex, 0));
  return s.displays[at] ?? s.displays.find((d) => d) ?? null;
}

/**
 * Put a slot's displays on its node: display 0 the one the setup pose shows,
 * the others after it in the file's order. Animo keeps one transform per
 * node, so a display placed elsewhere in the slot keeps its place by its
 * transform point; turned or scaled differently it cannot, and says so.
 */
function displaysInto(
  node: Node, s: SlotInfo, ownNode: boolean, warn: (m: string) => void, armName: string,
): { perm: (i: number) => number; hidden: boolean } {
  const setupAt = Math.round(num(s.raw.displayIndex, 0));
  const hidden = !s.displays[setupAt];
  const order = s.displays.map((d, i) => ({ d, i })).filter((x) => x.d);
  const first = order.find((x) => x.i === setupAt) ?? order[0];
  // Nothing to show: an empty layer, which exports as nothing.
  if (!first) return { perm: () => -1, hidden: false };
  const listed = [first, ...order.filter((x) => x !== first)];
  const perm = new Map(listed.map((x, k) => [x.i, k]));

  const base = first.d!.transform;
  if (ownNode) node.bind = { ...base };
  const linear = linearOf(ownNode ? base : tf());
  const inv = matOf(1, 0, 0, 1, 0, 0);
  invert(inv, linear);
  const origin = ownNode ? base : tf();
  const pivotOf = (d: Display): { x: number; y: number } => {
    if (!sameLinear(d.transform, ownNode ? base : tf())) {
      warn(`"${armName}": the display "${d.name}" of slot "${s.name}" is turned or scaled differently from the slot's first; it is shown in the first one's frame.`);
    }
    const dx = d.transform.x - origin.x, dy = d.transform.y - origin.y;
    const lx = inv.a * dx + inv.c * dy, ly = inv.b * dx + inv.d * dy;
    return d.kind === "image" ? { x: d.pivot.x - lx, y: d.pivot.y - ly } : { x: -lx, y: -ly };
  };
  const refs: DisplayRef[] = listed.map((x) => ({ itemId: x.d!.itemId, pivot: pivotOf(x.d!) }));
  node.itemId = refs[0]!.itemId;
  node.pivot = refs[0]!.pivot;
  if (refs.length > 1) node.extraDisplays = refs.slice(1);
  return { perm: (i) => perm.get(i) ?? -1, hidden };
}

function blendOf(raw: unknown): BlendMode | null {
  if (raw === undefined) return "normal";
  const name = typeof raw === "number" ? BLEND_NUMBERS[raw] ?? "" : str(raw).toLowerCase();
  return BLEND[name] ?? null;
}

/* ── Draw order ───────────────────────────────────────────────────────────*/

function layersFor(
  sym: SymbolItem, slots: SlotInfo[], boneNodes: Map<string, Node>, slotNodes: Map<string, { node: Node }>,
): { layers: Layer[]; moved: SlotInfo[] } {
  const zOf = new Map<NodeId, number>();
  for (const s of slots) zOf.set(slotNodes.get(s.name)!.node.id, s.z);
  const children = new Map<NodeId | null, Node[]>();
  for (const node of Object.values(sym.nodes)) {
    const p = node.parentId && sym.nodes[node.parentId] ? node.parentId : null;
    (children.get(p) ?? children.set(p, []).get(p)!).push(node);
  }
  const front = new Map<NodeId, number>();
  const frontOf = (n: Node): number => {
    const known = front.get(n.id);
    if (known !== undefined) return known;
    front.set(n.id, -1);
    const v = Math.max(zOf.get(n.id) ?? -1, ...(children.get(n.id) ?? []).map(frontOf));
    front.set(n.id, v);
    return v;
  };
  // In the file's order where nothing else decides: bones first, then slots.
  const fileOrder = new Map<NodeId, number>();
  [...boneNodes.values(), ...[...slotNodes.values()].map((s) => s.node)].forEach((n, i) => { if (!fileOrder.has(n.id)) fileOrder.set(n.id, i); });
  const sorted = (list: Node[]) => [...list].sort((a, b) => frontOf(b) - frontOf(a) || fileOrder.get(a.id)! - fileOrder.get(b.id)!);

  const layers: Layer[] = [];
  const seen = new Set<NodeId>();
  const walk = (n: Node, depth: number) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    layers.push(createLayer(n.id, n.name, layers.length, depth));
    for (const c of sorted(children.get(n.id) ?? [])) walk(c, depth + 1);
  };
  for (const n of sorted(children.get(null) ?? [])) walk(n, 0);

  // Top row first, so the file's z runs downwards; what breaks the run moved.
  const drawn = layers.map((l) => zOf.get(l.nodeId)).filter((z): z is number => z !== undefined);
  const kept = longestDecreasing(drawn);
  return { layers, moved: slots.filter((s) => !kept.has(s.z)) };
}

/** The values of the longest strictly decreasing run (not necessarily contiguous). */
export function longestDecreasing(values: number[]): Set<number> {
  const best: number[] = values.map(() => 1), prev: number[] = values.map(() => -1);
  values.forEach((v, i) => {
    for (let j = 0; j < i; j++) if (values[j]! > v && best[j]! + 1 > best[i]!) { best[i] = best[j]! + 1; prev[i] = j; }
  });
  let at = best.indexOf(Math.max(0, ...best));
  const out = new Set<number>();
  while (at >= 0) { out.add(values[at]!); at = prev[at]!; }
  return out;
}

/* ── Animations ───────────────────────────────────────────────────────────*/

function animationsOf(
  arm: Raw, boneNodes: Map<string, Node>,
  slotNodes: Map<string, { node: Node; perm: (i: number) => number; hidden: boolean }>, warn: (m: string) => void,
) {
  const armName = str(arm.name);
  const raws = asArr(arm.animation).map(asObj).filter((a): a is Raw => !!a);
  // A child armature plays its first animation (`defaultActions` in the
  // export): the one the file starts goes first.
  const starts = str(asObj(asArr(arm.defaultActions)[0])?.gotoAndPlay);
  const ordered = starts ? [...raws.filter((a) => str(a.name) === starts), ...raws.filter((a) => str(a.name) !== starts)] : raws;

  return ordered.map((raw) => {
    const anim = createAnimation(str(raw.name) || "animation", Math.max(1, Math.round(num(raw.duration, 1))));
    anim.playTimes = Math.max(0, Math.round(num(raw.playTimes, 1)));
    const duration = anim.duration;
    const wrap = anim.playTimes !== 1;
    const dropped = (what: string) => warn(`"${armName}": ${what} in "${anim.name}" are not supported and are left out.`);
    if (raw.zOrder) dropped("draw order changes");
    if (asArr(raw.ffd).length) dropped("mesh deformations");
    if (asArr(raw.ik).length) dropped("IK changes");
    if (asArr(raw.frame).some((f) => { const r = asObj(f); return r && (r.events || r.event || r.sound || r.action || r.actions); })) dropped("events, sounds and actions");
    if (num(raw.scale, 1) !== 1) warn(`"${armName}": "${anim.name}" plays at ${num(raw.scale, 1)}× speed in the file; Animo plays it as keyed.`);

    const channels = new Map<Node, NodeChannels>();
    const of = (node: Node) => channels.get(node) ?? channels.set(node, {}).get(node)!;
    for (const t of asArr(raw.bone).map(asObj)) {
      const node = t && boneNodes.get(str(t.name));
      if (!t || !node) continue;
      const c = of(node);
      if (Array.isArray(t.frame)) {
        const all = allFrameChannels(t.frame, duration, wrap);
        if (all) Object.assign(c, all);
      }
      c.translate = translateChannel(asArr(t.translateFrame), duration, wrap) ?? c.translate;
      c.rotate = rotateChannel(asArr(t.rotateFrame), duration, wrap) ?? c.rotate;
      c.scale = scaleChannel(asArr(t.scaleFrame), duration, wrap) ?? c.scale;
    }
    for (const t of asArr(raw.slot).map(asObj)) {
      const slot = t && slotNodes.get(str(t.name));
      if (!t || !slot) continue;
      const c = of(slot.node);
      // The 5.0 list: the runtime builds a colour timeline from it whether
      // its frames name a colour or not, the plain colour where they do not.
      if (Array.isArray(t.frame)) {
        c.display = displayChannel(t.frame, duration) ?? c.display;
        c.color = colorChannel(t.frame, duration, wrap) ?? c.color;
      }
      c.display = displayChannel(asArr(t.displayFrame), duration) ?? c.display;
      c.color = colorChannel(asArr(t.colorFrame), duration, wrap) ?? c.color;
    }
    for (const s of slotNodes.values()) if (s.hidden) of(s.node);

    for (const [node, c] of channels) {
      const slot = [...slotNodes.values()].find((s) => s.node === node);
      if (!Object.values(c).some(Boolean) && !slot?.hidden) continue;
      anim.tracks[node.id] = {
        nodeId: node.id,
        keys: keysFor(c, node.bind, duration, slot?.perm, slot?.hidden),
        endFrame: duration - 1,
      };
    }
    return anim;
  });
}

/* ── Stage, masks, motion blur ────────────────────────────────────────────*/

/**
 * The stage: the scene's `canvas` when the file has one (Animo writes it),
 * else its `aabb` with a margin, else the defaults. The scene's origin is
 * the stage's top-left corner, so the top-level nodes move by the canvas'
 * corner — their keys too, which hold where the node is.
 */
function stageOf(root: Raw, sym: SymbolItem, defaults: NewProjectDefaults) {
  const canvas = asObj(root.canvas), aabb = asObj(root.aabb);
  let settings = { width: defaults.width, height: defaults.height, background: defaults.background };
  let dx = 0, dy = 0;
  if (canvas && num(canvas.width, 0) > 0 && num(canvas.height, 0) > 0) {
    settings = { width: Math.round(num(canvas.width, 0)), height: Math.round(num(canvas.height, 0)), background: defaults.background };
    if (typeof canvas.color === "number") settings.background = `#${(canvas.color & 0xffffff).toString(16).padStart(6, "0")}`;
    dx = -num(canvas.x, 0);
    dy = -num(canvas.y, 0);
  } else if (aabb && num(aabb.width, 0) > 0 && num(aabb.height, 0) > 0) {
    const w = num(aabb.width, 0), h = num(aabb.height, 0);
    const margin = Math.round(Math.max(w, h) * 0.1);
    settings = { width: Math.ceil(w) + 2 * margin, height: Math.ceil(h) + 2 * margin, background: defaults.background };
    dx = margin - num(aabb.x, 0);
    dy = margin - num(aabb.y, 0);
  }
  if (dx || dy) {
    for (const node of Object.values(sym.nodes)) {
      if (node.parentId) continue;
      node.bind = { ...node.bind, x: node.bind.x + dx, y: node.bind.y + dy };
      for (const anim of sym.animations) {
        const t = anim.tracks[node.id];
        if (t) anim.tracks[node.id] = { ...t, keys: t.keys.map((k) => ({ ...k, transform: { ...k.transform, x: k.transform.x + dx, y: k.transform.y + dy } })) };
      }
    }
  }
  return { settings };
}

/** Each symbol's nodes by the slot names the file gives them: a slot renamed in Animo keeps its links. */
const nodeOfSlot = new WeakMap<SymbolItem, Map<string, NodeId>>();

/** Animo's own masks (`ANIMO_masks` in `_ext.json`) back onto the layers. */
function applyExtensions(raw: unknown, symbols: Map<string, SymbolItem>, warn: (m: string) => void): void {
  const masks = asArr(asObj(asObj(asObj(raw)?.extensions)?.ANIMO_masks)?.masks) as MaskLink[];
  for (const link of masks) {
    const sym = symbols.get(str(link?.armature));
    if (!sym) continue;
    const layerOf = (slot: string) => sym.layers.find((l) => l.nodeId === nodeOfSlot.get(sym)?.get(slot));
    const mask = layerOf(str(link.mask));
    if (!mask) continue;
    mask.isMask = true;
    for (const t of asArr(link.targets)) {
      const target = layerOf(str(t));
      if (target) target.maskedBy = mask.id;
    }
  }
  for (const sym of symbols.values()) {
    const before = sym.layers.filter((l) => l.maskedBy).length;
    normalizeMasks(sym);
    if (sym.layers.filter((l) => l.maskedBy).length < before) warn(`"${sym.name}": a mask ended up below what it clips and was unlinked.`);
  }
}

function motionBlurOf(raw: unknown) {
  const mb = asObj(asObj(asObj(raw)?.extensions)?.ANIMO_motion_blur);
  if (!mb) return null;
  return { enabled: true, shutter: num(mb.shutter, 180), maxLength: num(mb.maxLength, 64) };
}

/** Per-slot motion blur (`ANIMO_motion_blur.slots`) back onto the nodes. */
function applyMotionBlurSlots(raw: unknown, symbols: Map<string, SymbolItem>): void {
  const slots = asObj(asObj(asObj(asObj(raw)?.extensions)?.ANIMO_motion_blur)?.slots);
  if (!slots) return;
  for (const [armName, item] of symbols) {
    const bySlot = asObj(slots[armName]);
    if (!bySlot) continue;
    for (const [slot, id] of nodeOfSlot.get(item) ?? []) {
      const v = bySlot[slot];
      if (typeof v === "number") item.nodes[id]!.motionBlur = v;
    }
  }
}
