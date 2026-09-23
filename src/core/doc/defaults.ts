import { cloneTf, tf } from "@/core/math/Transform";
import { TWEEN_NONE } from "@/core/math/easing";
import type { Animation, ImageItem, Keyframe, Layer, Node, NodeKind, Project, SymbolItem, Track, } from "./types";
import { DEFAULT_COLOR, DOC_VERSION } from "./types";
import { type AssetId, type ItemId, newAnimId, newItemId, newLayerId, newNodeId, type NodeId, } from "./ids";

/** Layer chip colours, cycled in order — the same spirit as Animate's. */
export const LAYER_COLORS = [
  "#c94f9c", "#39c0c8", "#b06fd8", "#e08b3a", "#5cc25c",
  "#4a90d9", "#d95c5c", "#c8c04a", "#7a86e0", "#3fb89a",
] as const;

export function pickLayerColor(index: number): string {
  return LAYER_COLORS[index % LAYER_COLORS.length]!;
}

/**
 * A new animation is ONE frame long, the way a fresh Flash timeline is. The
 * span is then dragged out to the length the animation actually needs;
 * starting at a fixed 24 made every imported symbol claim a second of
 * playback it never uses.
 */
export function createAnimation(name = "animation", duration = 1): Animation {
  return { id: newAnimId(), name, duration, playTimes: 0, tracks: {} };
}

export function createSymbol(name: string): SymbolItem {
  return {
    kind: "symbol",
    id: newItemId(),
    name,
    nodes: {},
    layers: [],
    ik: [],
    animations: [createAnimation()],
  };
}

export function createImageItem(
  name: string, assetId: AssetId, width: number, height: number,
): ImageItem {
  return { kind: "image", id: newItemId(), name, assetId, width, height };
}

export function createNode(
  kind: NodeKind,
  name: string,
  opts: { itemId?: ItemId; parentId?: NodeId | null; x?: number; y?: number;
          pivotX?: number; pivotY?: number } = {},
): Node {
  const node: Node = {
    id: newNodeId(),
    name,
    kind,
    parentId: opts.parentId ?? null,
    bind: tf(opts.x ?? 0, opts.y ?? 0),
    pivot: { x: opts.pivotX ?? 0, y: opts.pivotY ?? 0 },
  };
  if (opts.itemId) node.itemId = opts.itemId;
  if (kind === "bone") node.boneLength = 40;
  return node;
}

export function createLayer(nodeId: NodeId, name: string, colorIndex: number, depth = 0): Layer {
  return {
    id: newLayerId(),
    nodeId,
    name,
    color: pickLayerColor(colorIndex),
    visible: true,
    locked: false,
    outline: false,
    depth,
  };
}

/**
 * A keyframe capturing a node's bind pose — what F6 writes on a fresh track.
 * It holds, as a new keyframe does in Flash: a tween is something asked for.
 * With `linear` here, the key a fresh track starts with tweened into the
 * first F6 after it, a motion nobody had created.
 */
export function createKeyframe(frame: number, node: Node): Keyframe {
  return {
    frame,
    transform: cloneTf(node.bind),
    displayIndex: 0,
    tween: TWEEN_NONE,
  };
}

export function createTrack(node: Node, endFrame: number): Track {
  return { nodeId: node.id, keys: [createKeyframe(0, node)], endFrame };
}

export function defaultColor() {
  return { ...DEFAULT_COLOR };
}

/** Stage size, frame rate and background for a new document. The editor
 *  passes what the preferences say; the defaults here are what it used to
 *  hardcode, so every other caller — the tests included — is unaffected. */
export interface NewProjectDefaults {
  width: number;
  height: number;
  frameRate: number;
  background: string;
}

export function createProject(
  name = "Untitled",
  defaults: NewProjectDefaults = { width: 800, height: 600, frameRate: 24, background: "#ffffff" },
): Project {
  const root = createSymbol("Scene 1");
  return {
    version: DOC_VERSION,
    name,
    frameRate: defaults.frameRate,
    stage: { width: defaults.width, height: defaults.height, background: defaults.background },
    items: { [root.id]: root },
    folders: {},
    itemOrder: [root.id],
    rootSymbolId: root.id,
  };
}
