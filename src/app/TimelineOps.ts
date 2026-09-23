import type { Store } from "./Store";
import type {
    BlendMode,
    ColorTransform,
    DisplayRef,
    Keyframe,
    Node,
    NodeKind,
    RotateDir,
    Track,
} from "@/core/doc/types";
import { DEFAULT_COLOR } from "@/core/doc/types";
import type { ItemId, NodeId } from "@/core/doc/ids";
import type { Transform } from "@/core/math/Transform";
import { cloneTf } from "@/core/math/Transform";
import type { ChannelEases, TweenSpec } from "@/core/math/easing";
import { TWEEN_LINEAR } from "@/core/math/easing";
import { createKeyframe } from "@/core/doc/defaults";
import { localAt } from "@/core/doc/pose";
import { displayAt } from "@/core/doc/displays";
import {
    clearKeyframe,
    editableSpan,
    insertBlankKeyframe,
    insertFrame,
    insertKeyframe,
    isolateRange,
    keyIndexAt,
    mapKeyTransforms,
    moveRange,
    removeFrame,
    resizedEmptyLength,
    sampleColorRaw,
    sampleTransformRaw,
    setEndFrame,
    spanIndexAt,
} from "@/core/doc/timeline";
import { applyFrameEdit, deriveEdit } from "@/core/math/multiEdit";
import { EditTracks, SetAnimationDuration, withEases, withKeyframe, withTween, } from "@/core/history/timelineCommands";
import {
    SetBindColor,
    SetBindTransform,
    SetNodeBlendMode,
    SetNodeItem,
    SetNodeMotionBlur,
    SetPivot,
} from "@/core/history/commands";

/**
 * The bridge between the UI and the pure frame algebra.
 *
 * Everything here funnels through one command (`EditTracks`), so undo works
 * identically whether the user pressed F6, dragged a keyframe, or nudged an
 * object on the stage.
 */

type TrackMap = Map<NodeId, Track | undefined>;

/**
 * A group that was never keyed has no frames of its own — its row only
 * draws the span of what it holds — so frame operations pass over it rather
 * than materialising a track (Insert Frames — All Layers used to give every
 * group a static keyframe). A single F6 aimed at the group itself still keys
 * it: that is how a group gets animated.
 */
function framesOf(store: Store, node: Node, many: boolean): boolean {
  return node.kind !== "group" || !!store.currentAnimation?.tracks[node.id] || !many;
}

function currentIds(store: Store, ids?: NodeId[]): NodeId[] {
  if (ids?.length) return ids;
  if (store.selection.nodes.length) return [...store.selection.nodes];
  return [];
}

/** A track for a node that has none yet: a single keyframe holding its bind pose. */
export function ensureTrack(store: Store, node: Node): Track {
  const anim = store.currentAnimation;
  const existing = anim?.tracks[node.id];
  if (existing) return existing;
  return {
    nodeId: node.id,
    keys: [createKeyframe(0, node)],
    endFrame: Math.max(0, (anim?.duration ?? 1) - 1),
  };
}

function commit(store: Store, label: string, tracks: TrackMap, kind?: string): void {
  const anim = store.currentAnimation;
  if (!anim || tracks.size === 0) return;
  store.apply(new EditTracks(label, store.currentSymbolId, anim.id, tracks, kind));
  store.emit("timeline");
  store.emit("stage");
}

/* ── The F-keys ──────────────────────────────────────────────────────────*/

export function doInsertFrame(store: Store, frame: number, ids?: NodeId[]): void {
  doInsertFrames(store, currentIds(store, ids), frame, 1);
}

export function doInsertKeyframe(store: Store, frame: number, ids?: NodeId[]): void {
  const sym = store.currentSymbol;
  const tracks: TrackMap = new Map();
  const targets = currentIds(store, ids);
  for (const id of targets) {
    const node = sym.nodes[id];
    if (!node || !framesOf(store, node, targets.length > 1)) continue;
    const base = ensureTrack(store, node);
    const next = insertKeyframe(base, frame, node);
    if (next) tracks.set(id, next);
    else if (!store.currentAnimation?.tracks[id]) tracks.set(id, base);
  }
  commit(store, "Insert Keyframe", tracks);
}

export function doInsertBlankKeyframe(store: Store, frame: number, ids?: NodeId[]): void {
  const sym = store.currentSymbol;
  const tracks: TrackMap = new Map();
  for (const id of currentIds(store, ids)) {
    const node = sym.nodes[id];
    // A group shows no artwork, so there is nothing for a blank key to hide.
    if (!node || !framesOf(store, node, true)) continue;
    const next = insertBlankKeyframe(ensureTrack(store, node), frame, node);
    if (next) tracks.set(id, next);
  }
  commit(store, "Insert Blank Keyframe", tracks);
}

export function doRemoveFrame(store: Store, frame: number, ids?: NodeId[]): void {
  doRemoveFrames(store, currentIds(store, ids), frame, 1);
}

export function doClearKeyframe(store: Store, frame: number, ids?: NodeId[]): void {
  const anim = store.currentAnimation;
  if (!anim) return;
  const tracks: TrackMap = new Map();
  for (const id of currentIds(store, ids)) {
    const track = anim.tracks[id];
    if (!track) continue;
    const next = clearKeyframe(track, frame);
    if (next) tracks.set(id, next);
  }
  commit(store, "Clear Keyframe", tracks);
}

/* ── Ranges: a frame selection, or every layer at the playhead ───────────*/

/**
 * When nothing is keyed anywhere, the animation's length is the stored
 * `duration` and nothing else (see `durationFor`). Adding or removing frames
 * then means changing that number — creating a track per layer just to say
 * "still static" would put a pointless timeline into the export for every one
 * of them.
 */
function stretchEmptyAnimation(store: Store, delta: number, from: number): boolean {
  const anim = store.currentAnimation;
  if (!anim) return false;
  if (Object.values(anim.tracks).some((t) => !!t)) return false;
  const next = resizedEmptyLength(anim.duration, from, delta);
  if (next !== anim.duration) {
    store.apply(new SetAnimationDuration(store.currentSymbolId, anim.id, next));
    store.emit("timeline");
    store.emit("stage");
  }
  return true;
}

/**
 * Insert `count` frames at `from` on each of `ids`.
 *
 * One `EditTracks` for the whole thing, so a five-frame insert across four
 * layers is a single undo — the way Flash behaves.
 */
export function doInsertFrames(
  store: Store, ids: NodeId[], from: number, count: number,
): void {
  if (count <= 0) return;
  if (stretchEmptyAnimation(store, count, from)) return;
  const sym = store.currentSymbol;
  const tracks: TrackMap = new Map();
  for (const id of ids) {
    const node = sym.nodes[id];
    if (!node || !framesOf(store, node, true)) continue;
    let track = ensureTrack(store, node);
    for (let i = 0; i < count; i++) track = insertFrame(track, from);
    tracks.set(id, track);
  }
  commit(store, count > 1 ? `Insert ${count} Frames` : "Insert Frame", tracks);
}

/** Remove `count` frames starting at `from` on each of `ids`. */
export function doRemoveFrames(
  store: Store, ids: NodeId[], from: number, count: number,
): void {
  const anim = store.currentAnimation;
  if (!anim || count <= 0) return;
  if (stretchEmptyAnimation(store, -count, from)) return;
  const sym = store.currentSymbol;
  const tracks: TrackMap = new Map();
  for (const id of ids) {
    const node = sym.nodes[id];
    if (!node || !framesOf(store, node, true)) continue;
    // A layer with no track still occupies the whole animation — that is what
    // the grid draws and what dragging its end edits — so removing frames
    // from it has to shorten it, which means materialising the track first.
    // Skipping it (what this did) made Remove silently do nothing on every
    // layer that had never been keyed.
    const base = anim.tracks[id] ?? ensureTrack(store, node);
    let track = base;
    // Always at `from`: each removal pulls the rest of the track left, so the
    // same index eats the next frame of the run. A removal that has nothing
    // left to take ends the run but keeps what the earlier ones did.
    for (let i = 0; i < count; i++) {
      const next = removeFrame(track, from);
      if (!next) break;
      track = next;
    }
    if (track !== base) tracks.set(id, track);
  }
  commit(store, count > 1 ? `Remove ${count} Frames` : "Remove Frame", tracks);
}

/** Make every frame in `from..to` an explicit keyframe on each of `ids`. */
export function doConvertToKeyframes(
  store: Store, ids: NodeId[], from: number, to: number,
): void {
  const sym = store.currentSymbol;
  const tracks: TrackMap = new Map();
  for (const id of ids) {
    const node = sym.nodes[id];
    if (!node || !framesOf(store, node, ids.length > 1)) continue;
    const base = ensureTrack(store, node);
    let track = base;
    for (let f = Math.max(0, from); f <= to; f++) {
      // `insertKeyframe` samples what is showing at that frame, so converting
      // a tween to keyframes leaves the motion exactly as it was.
      const next = insertKeyframe(track, f, node);
      if (next) track = next;
    }
    if (track !== base || !store.currentAnimation?.tracks[id]) tracks.set(id, track);
  }
  commit(store, "Convert to Keyframes", tracks);
}

/** Clear every keyframe in `from..to` on each of `ids`. */
export function doClearKeyframes(
  store: Store, ids: NodeId[], from: number, to: number,
): void {
  const anim = store.currentAnimation;
  if (!anim) return;
  const tracks: TrackMap = new Map();
  for (const id of ids) {
    const existing = anim.tracks[id];
    if (!existing) continue;
    let track = existing;
    // Descending: clearing does not shift frames, but going backwards keeps
    // the indices we still have to visit valid whatever the implementation.
    for (let f = to; f >= Math.max(1, from); f--) {
      const next = clearKeyframe(track, f);
      if (next) track = next;
    }
    if (track !== existing) tracks.set(id, track);
  }
  commit(store, "Clear Keyframes", tracks);
}

/* ── Span and keyframe manipulation ──────────────────────────────────────*/

export function doSetEndFrame(store: Store, nodeId: NodeId, endFrame: number): void {
  const anim = store.currentAnimation;
  const sym = store.currentSymbol;
  const node = sym.nodes[nodeId];
  if (!anim || !node) return;
  const track = anim.tracks[nodeId] ?? ensureTrack(store, node);
  commit(store, "Extend Frames", new Map([[nodeId, setEndFrame(track, endFrame)]]), "timeline.span");
}

/**
 * Move keyframes by `delta`. A drag passes `base`, the track as it was when
 * the drag started, and the TOTAL delta: moving the live track step by step
 * overwrote every key the dragged one passed over, even when it was released
 * somewhere else. Only where it lands replaces anything.
 */
export function doMoveKeyframes(
  store: Store, nodeId: NodeId, from: number, to: number, delta: number, base?: Track,
): void {
  const anim = store.currentAnimation;
  const track = base ?? anim?.tracks[nodeId];
  if (!track) return;
  const next = moveRange(track, from, to, delta) ?? (base && delta === 0 ? base : null);
  if (!next) return;
  commit(store, "Move Keyframes", new Map([[nodeId, next]]), "timeline.move");
}

export function doSetTween(store: Store, nodeId: NodeId, frame: number, tween: TweenSpec): void {
  const anim = store.currentAnimation;
  const track = anim?.tracks[nodeId];
  if (!track || keyIndexAt(track, frame) < 0) return;
  commit(store, "Change Tween", new Map([[nodeId, withTween(track, frame, tween)]]));
}

/** A keyframe whose outgoing interval an ease applies to. */
export interface EaseTarget {
  nodeId: NodeId;
  frame: number;
  /** Frames to the next key: the span a preset's curve is built for. */
  span: number;
}

/**
 * The intervals the Ease panel acts on: every span a selected frame cell
 * lies in, or, with no cells, the span under the playhead on each selected
 * layer. Only spans that end in another key can tween.
 */
export function easeTargets(store: Store): EaseTarget[] {
  const anim = store.currentAnimation;
  if (!anim) return [];
  const cells: Array<[NodeId, number]> = store.selection.frames.length
    ? store.selection.frames.map((c) => {
      const cut = c.lastIndexOf(":");
      return [c.slice(0, cut) as NodeId, Number(c.slice(cut + 1))];
    })
    : store.selection.nodes.map((id) => [id, store.ui.frame]);

  const out: EaseTarget[] = [];
  const seen = new Set<string>();
  for (const [nodeId, f] of cells) {
    const track = anim.tracks[nodeId];
    if (!track || !Number.isFinite(f)) continue;
    const i = spanIndexAt(track, f);
    const key = track.keys[i];
    const next = track.keys[i + 1];
    if (!key || !next) continue;
    const tag = `${nodeId}:${key.frame}`;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push({ nodeId, frame: key.frame, span: next.frame - key.frame });
  }
  return out;
}

/** One undo step for every interval the Ease panel was opened on. */
export function doSetEases(
  store: Store, targets: readonly EaseTarget[], tween: TweenSpec, eases: ChannelEases | undefined,
): void {
  const anim = store.currentAnimation;
  if (!anim) return;
  const tracks: TrackMap = new Map();
  for (const t of targets) {
    const track = tracks.get(t.nodeId) ?? anim.tracks[t.nodeId];
    if (!track || keyIndexAt(track, t.frame) < 0) continue;
    tracks.set(t.nodeId, withEases(track, t.frame, tween, eases));
  }
  commit(store, "Change Ease", tracks);
}

/**
 * Rotate CW / CCW ×N on the tween leaving a keyframe. `dir` null means "as
 * keyed". Turns are a count in the chosen direction; asking for turns with no
 * direction picks the one the keyed angles already travel, so the spin does
 * not reverse under the user.
 */
export function doSetRotation(
  store: Store, nodeId: NodeId, frame: number, dir: RotateDir | null, turns: number,
): void {
  const anim = store.currentAnimation;
  const track = anim?.tracks[nodeId];
  const index = track ? keyIndexAt(track, frame) : -1;
  if (!track || index < 0) return;

  const key = track.keys[index]!;
  const count = Math.max(0, Math.round(turns));
  let direction = dir;
  if (!direction && count > 0) {
    const next = track.keys[index + 1];
    direction = next && next.transform.skewY < key.transform.skewY ? "ccw" : "cw";
  }

  const updated: Keyframe = { ...key };
  delete updated.rotateDir;
  delete updated.rotateTurns;
  if (direction) updated.rotateDir = direction;
  if (count) updated.rotateTurns = count;
  const next: Track = { ...track, keys: track.keys.map((k, i) => (i === index ? updated : k)) };
  commit(store, "Change Rotation", new Map([[nodeId, next]]));
}

/* ── Writing transforms from the stage ───────────────────────────────────*/

export interface WriteOptions {
  /** Create a keyframe at the playhead if there is not one already.
   *  On by default, matching DragonBones Pro and Spine rather than Flash —
   *  when you are posing a skeleton, silently editing an earlier keyframe is
   *  almost never what you meant. */
  autoKey: boolean;
  /** Merge with the previous write, so a drag is one undo entry. */
  interactive: boolean;
}

/**
 * Apply transforms at the current frame.
 *
 * In Setup mode this is the caller's problem — it writes the bind pose
 * directly. Here we are in Animate mode, so the value lands on a keyframe.
 */
export function writeTransformsAtFrame(
  store: Store,
  next: Map<NodeId, Transform>,
  opts: WriteOptions = { autoKey: true, interactive: false },
): void {
  const anim = store.currentAnimation;
  const sym = store.currentSymbol;
  if (!anim) return;
  const frame = store.ui.frame;

  const tracks: TrackMap = new Map();
  for (const [id, transform] of next) {
    const node = sym.nodes[id];
    if (!node) continue;
    let track = anim.tracks[id] ?? ensureTrack(store, node);

    if (keyIndexAt(track, frame) < 0) {
      if (opts.autoKey) {
        const inserted = insertKeyframe(track, frame, node);
        if (inserted) track = inserted;
      } else {
        // Edit the keyframe that governs this frame, as Flash does.
        const i = spanIndexAt(track, frame);
        const governing = track.keys[i];
        if (governing) {
          tracks.set(id, withKeyframe(track, governing.frame, { transform: cloneTf(transform) }));
          continue;
        }
      }
    }
    tracks.set(id, withKeyframe(track, frame, { transform: cloneTf(transform) }));
  }

  commit(store, "Transform", tracks, opts.interactive ? "timeline.transform" : undefined);
}

/**
 * Apply transforms in whichever mode the editor is in.
 *
 * Setup mode edits the bind pose (the bone's exported origin); Animate mode
 * writes a keyframe. Every tool and every numeric field goes through here, so
 * the two modes cannot drift apart in behaviour.
 */
export function applyTransforms(
  store: Store,
  next: Map<NodeId, Transform>,
  interactive = false,
): void {
  if (store.ui.mode === "setup" || !store.currentAnimation) {
    store.apply(new SetBindTransform(store.currentSymbolId, next));
    store.emit("stage");
    return;
  }
  writeTransformsAtFrame(store, next, { autoKey: store.ui.autoKey, interactive });
}

/* ── Edit Multiple Frames ────────────────────────────────────────────────*/

/** Is a stage edit going to every keyframe between the onion markers? */
export function editsMultipleFrames(store: Store): boolean {
  return store.ui.editMultipleFrames && store.ui.mode === "animate" && !!store.currentAnimation;
}

/**
 * The tracks as they were when the current drag began. A drag computes each
 * step from its pointer-down snapshot, so the keys it re-edits must be the
 * pointer-down ones too — applying the edit to the live, already edited keys
 * would compound it on every pointermove. Same rule as `doMoveKeyframes`.
 */
let dragBase: { serial: number; animId: string; tracks: Record<string, Track | undefined> } | null = null;

function baseTracks(store: Store, interactive: boolean): Record<string, Track | undefined> {
  const anim = store.currentAnimation!;
  const serial = store.history.interactionSerial;
  if (!interactive || !store.history.inInteraction) {
    dragBase = null;
    return anim.tracks;
  }
  if (!dragBase || dragBase.serial !== serial || dragBase.animId !== anim.id) {
    dragBase = { serial, animId: anim.id, tracks: { ...anim.tracks } };
  }
  return dragBase.tracks;
}

/**
 * Apply what the tool says the node at the playhead should become to every
 * keyframe between the onion markers, as ONE change: the move, rotation or
 * scale the user made at the playhead, re-applied in the parent's space
 * (`core/math/multiEdit.ts`). Keys are cut at the edges of the range first
 * (`isolateRange`) so nothing outside it moves. One `EditTracks`, so the
 * whole range is one undo step.
 */
function writeMultipleFrames(store: Store, next: Map<NodeId, Transform>, interactive: boolean): void {
  const sym = store.currentSymbol;
  const frame = store.ui.frame;
  const span = store.onionSpan;
  const base = baseTracks(store, interactive);

  const tracks: TrackMap = new Map();
  for (const [id, after] of next) {
    const node = sym.nodes[id];
    if (!node) continue;
    const track = base[id] ?? ensureTrack(store, node);
    const before = sampleTransformRaw(track, frame) ?? node.bind;
    const edit = deriveEdit(before, after);
    const range = editableSpan(track, span.start, span.end);
    if (!range) continue;
    const isolated = isolateRange(track, range.from, range.to, node);
    tracks.set(id, mapKeyTransforms(isolated, range.from, range.to, (t) => applyFrameEdit(t, edit)));
  }
  commit(store, "Transform Frames", tracks, interactive ? "timeline.transform" : undefined);
}

/**
 * What every stage edit goes through — tools, the arrow-key nudge, the
 * Properties panel: `applyTransforms`, or with Edit Multiple Frames on, the
 * same change on every keyframe between the markers. Paste, placing an item,
 * the Bone and IK tools stay on `applyTransforms`: they set a pose rather than
 * edit one, and the IK solver's bones must never be keyed.
 */
export function applyEdit(store: Store, next: Map<NodeId, Transform>, interactive = false): void {
  if (editsMultipleFrames(store)) writeMultipleFrames(store, next, interactive);
  else applyTransforms(store, next, interactive);
}

/* ── Writing colour ──────────────────────────────────────────────────────
   Colour follows the transform path exactly: Setup mode edits the bind
   colour (the exported `slot.color`), Animate mode writes the keyframe at
   the playhead. Going straight to the node in Animate mode would leave the
   object looking frozen while the setup colour silently changed, which is
   the same trap `applyTransforms` exists to close.                        */

export function applyColors(
  store: Store,
  next: Map<NodeId, ColorTransform>,
  interactive = false,
): void {
  if (store.ui.mode === "setup" || !store.currentAnimation) {
    store.apply(new SetBindColor(store.currentSymbolId, next));
    store.emit("stage");
    return;
  }

  const anim = store.currentAnimation;
  const sym = store.currentSymbol;
  const frame = store.ui.frame;
  const tracks: TrackMap = new Map();

  for (const [id, color] of next) {
    const node = sym.nodes[id];
    if (!node) continue;
    let track = anim.tracks[id] ?? ensureTrack(store, node);

    if (keyIndexAt(track, frame) < 0) {
      if (store.ui.autoKey) {
        const inserted = insertKeyframe(track, frame, node);
        if (inserted) track = inserted;
      } else {
        const governing = track.keys[spanIndexAt(track, frame)];
        if (governing) {
          tracks.set(id, withKeyframe(track, governing.frame, { color: { ...color } }));
          continue;
        }
      }
    }
    tracks.set(id, withKeyframe(track, frame, { color: { ...color } }));
  }

  commit(store, "Colour", tracks, interactive ? "timeline.color" : undefined);
}

/** The colour showing at the playhead — what the properties panel should show. */
export function colorAtFrame(store: Store, node: Node): ColorTransform {
  const bind = node.color ? { ...node.color } : { ...DEFAULT_COLOR };
  if (store.ui.mode === "setup") return bind;
  const track = store.currentAnimation?.tracks[node.id];
  if (!track) return bind;
  return sampleColorRaw(track, store.ui.frame) ?? bind;
}

/** The transform showing at the playhead — what a gizmo should start from. */
export function transformAtFrame(store: Store, node: Node): Transform {
  if (store.ui.mode === "setup") return cloneTf(node.bind);
  const track = store.currentAnimation?.tracks[node.id];
  if (!track) return cloneTf(node.bind);
  const sampled = sampleTransformRaw(track, store.ui.frame);
  return sampled ? { ...sampled } : cloneTf(node.bind);
}

/**
 * Fill an empty layer in place: it becomes an instance of `fill.itemId`
 * while keeping its id, name, z-order and mask links. An untracked layer gets
 * the pose as its BIND pose, exactly as a fresh instance would; only one that
 * someone already keyed goes through the track. Run it inside a transaction.
 */
export function fillEmptyNode(
  store: Store, id: NodeId,
  fill: {
    itemId: ItemId; kind: NodeKind; pivot: { x: number; y: number }; transform: Transform;
    color?: ColorTransform; blendMode?: BlendMode; motionBlur?: number;
  },
): void {
  const sym = store.currentSymbolId;
  const keyed = !!store.currentAnimation?.tracks[id];
  store.apply(new SetNodeItem(sym, new Map([[id, { itemId: fill.itemId, kind: fill.kind }]])));
  store.apply(new SetPivot(sym, new Map([[id, fill.pivot]]), { keepArtwork: false }));
  if (keyed) applyTransforms(store, new Map([[id, fill.transform]]));
  else store.apply(new SetBindTransform(sym, new Map([[id, fill.transform]])));
  if (fill.color) store.apply(new SetBindColor(sym, new Map([[id, fill.color]])));
  if (fill.blendMode && fill.blendMode !== "normal") store.apply(new SetNodeBlendMode(sym, [id], fill.blendMode));
  if (fill.motionBlur !== undefined) store.apply(new SetNodeMotionBlur(sym, [id], fill.motionBlur));
}

/**
 * The display a node shows at the playhead, with its index: display 0 in
 * Setup mode, and for a node showing nothing there, since that is the one
 * the bind pose — and a fresh key — stands for.
 */
export function displayAtFrame(store: Store, node: Node): { index: number; display: DisplayRef | null } {
  const anim = store.ui.mode === "setup" ? null : store.currentAnimation;
  const { displayIndex } = localAt(node, anim, store.ui.frame, store.ui.mode);
  const shown = displayAt(node, displayIndex);
  return shown ? { index: displayIndex, display: shown } : { index: 0, display: displayAt(node, 0) };
}

/* ── Queries for the frame grid ──────────────────────────────────────────*/

export interface FrameCell {
  hasKey: boolean;
  blank: boolean;
  occupied: boolean;
  tweening: boolean;
  spanStart: boolean;
  spanEnd: boolean;
}

export function describeFrame(track: Track | undefined, frame: number): FrameCell {
  if (!track) {
    return { hasKey: false, blank: false, occupied: false, tweening: false, spanStart: false, spanEnd: false };
  }
  const keyIndex = keyIndexAt(track, frame);
  const spanIndex = spanIndexAt(track, frame);
  const key: Keyframe | undefined = keyIndex >= 0 ? track.keys[keyIndex] : undefined;
  const governing = spanIndex >= 0 ? track.keys[spanIndex] : undefined;
  const occupied = spanIndex >= 0 && frame <= track.endFrame;
  const nextKey = spanIndex >= 0 ? track.keys[spanIndex + 1] : undefined;

  return {
    hasKey: keyIndex >= 0,
    blank: (key ?? governing)?.displayIndex === -1,
    occupied,
    tweening: occupied && !!governing && !!nextKey && governing.tween.kind !== "none",
    spanStart: keyIndex >= 0,
    spanEnd: occupied && frame === track.endFrame,
  };
}

export { TWEEN_LINEAR };
