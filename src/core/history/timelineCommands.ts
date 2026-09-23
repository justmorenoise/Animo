import type { Command, TouchSet } from "./Command";
import type { Animation, Keyframe, Project, SymbolItem, Track } from "@/core/doc/types";
import { isSymbol } from "@/core/doc/types";
import type { AnimId, ItemId, NodeId } from "@/core/doc/ids";
import type { ChannelEases, TweenSpec } from "@/core/math/easing";
import { createAnimation } from "@/core/doc/defaults";
import { endAfterResize } from "@/core/doc/timeline";
import { invalidateBounds } from "@/core/doc/pose";

function symbolOf(p: Project, id: ItemId): SymbolItem {
  const s = p.items[id];
  if (!isSymbol(s)) throw new Error(`Not a symbol: ${id}`);
  return s;
}

function animOf(sym: SymbolItem, id: AnimId): Animation | undefined {
  return sym.animations.find((a) => a.id === id);
}

/**
 * One primitive for every timeline edit.
 *
 * All the Flash frame operations in `core/doc/timeline.ts` are pure functions
 * that take a Track and return a new one, so the command layer does not need
 * to know what any of them mean: it snapshots the tracks it is about to
 * replace and swaps them back on undo. That keeps the undo path identical —
 * and identically correct — for inserting a frame, dragging a keyframe, or
 * writing a transform from the stage.
 *
 * `undefined` on either side means "no track", which is how track creation
 * and deletion fall out for free.
 */
export class EditTracks implements Command {
  readonly kind: string;
  readonly touches: TouchSet;
  private before = new Map<NodeId, Track | undefined>();
  private after: Map<NodeId, Track | undefined>;
  private captured = false;
  private beforeDuration = 0;

  constructor(
    readonly label: string,
    private readonly symbolId: ItemId,
    private readonly animId: AnimId,
    tracks: Map<NodeId, Track | undefined>,
    /** Same-kind commands merge during an interaction, so a drag is one undo. */
    kind = "timeline.edit",
  ) {
    this.after = new Map(tracks);
    this.kind = kind;
    this.touches = {
      symbols: [symbolId],
      nodes: [...tracks.keys()],
      timeline: true,
      stage: true,
    };
  }

  apply(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    if (!this.captured) {
      for (const id of this.after.keys()) this.before.set(id, anim.tracks[id]);
      this.captured = true;
    }
    this.beforeDuration = anim.duration;
    for (const [id, track] of this.after) {
      if (track) anim.tracks[id] = track;
      else delete anim.tracks[id];
    }
    anim.duration = durationFor(anim);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    for (const [id, track] of this.before) {
      if (track) anim.tracks[id] = track;
      else delete anim.tracks[id];
    }
    anim.duration = this.beforeDuration;
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof EditTracks)) return false;
    if (next.symbolId !== this.symbolId || next.animId !== this.animId) return false;
    if (next.kind !== this.kind) return false;
    for (const [id, track] of next.after) {
      // A track only a later step touched: that step saw it untouched, so
      // its `before` is the original, and undo has to put it back too.
      if (!this.before.has(id)) {
        this.before.set(id, next.before.get(id));
        this.touches.nodes?.push(id);
      }
      this.after.set(id, track);
    }
    return true;
  }

  estimateSize(): number {
    let n = 0;
    for (const t of this.before.values()) n += (t?.keys.length ?? 0) * 160;
    return n + 128;
  }
}

/**
 * An animation is as long as its longest layer, the way a Flash timeline is.
 *
 * Dragging a span or a keyframe past the end therefore lengthens the
 * animation, and pulling the last one back shortens it, with no separate
 * "duration" setting to keep in sync. When nothing is keyed there is nothing
 * to measure, so the stored value stands — that is what `Set Duration…` sets.
 */
export function durationFor(anim: Animation): number {
  let end = -1;
  for (const track of Object.values(anim.tracks)) {
    if (track) end = Math.max(end, track.endFrame);
  }
  return end < 0 ? Math.max(1, anim.duration) : Math.max(1, end + 1);
}

/* ── Animation-level edits ───────────────────────────────────────────────*/

export class SetAnimationDuration implements Command {
  readonly kind = "anim.duration";
  readonly touches: TouchSet;
  readonly label = "Change Duration";
  /** The duration before the first step; a redo starts from it again. */
  private before: number | null = null;

  constructor(
    private readonly symbolId: ItemId,
    private readonly animId: AnimId,
    private duration: number,
  ) {
    this.touches = { symbols: [symbolId], timeline: true, stage: true };
  }

  /** Every track as it was before the first step, stretched or not: a later
   *  step of a scrub may move one this step left alone. */
  private beforeTracks = new Map<NodeId, Track>();

  apply(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    this.before ??= anim.duration;
    const next = Math.max(1, Math.round(this.duration));
    anim.duration = next;
    // Duration is derived from the spans, so setting it explicitly has to
    // move the ones that reach the end; otherwise the next track edit would
    // snap it straight back. New tracks: the old ones belong to earlier undo
    // steps too.
    for (const [id, track] of Object.entries(anim.tracks) as Array<[NodeId, Track | undefined]>) {
      if (!track) continue;
      if (!this.beforeTracks.has(id)) this.beforeTracks.set(id, track);
      const endFrame = endAfterResize(track, this.before, next);
      if (endFrame !== track.endFrame) anim.tracks[id] = { ...track, endFrame };
    }
    anim.duration = durationFor(anim);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    for (const [id, track] of this.beforeTracks) anim.tracks[id] = track;
    if (this.before !== null) anim.duration = this.before;
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetAnimationDuration) || next.animId !== this.animId) return false;
    if (next.symbolId !== this.symbolId) return false;
    this.duration = next.duration;
    for (const [id, track] of next.beforeTracks) {
      if (!this.beforeTracks.has(id)) this.beforeTracks.set(id, track);
    }
    return true;
  }
}

export class SetAnimationLoop implements Command {
  readonly kind = "anim.loop";
  readonly touches: TouchSet;
  readonly label = "Change Loop";
  private before = 0;

  constructor(
    private readonly symbolId: ItemId,
    private readonly animId: AnimId,
    private readonly playTimes: number,
  ) {
    this.touches = { symbols: [symbolId], timeline: true };
  }
  apply(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    this.before = anim.playTimes;
    anim.playTimes = Math.max(0, Math.round(this.playTimes));
  }
  revert(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (anim) anim.playTimes = this.before;
  }
}

export class AddAnimation implements Command {
  readonly kind = "anim.add";
  readonly touches: TouchSet;
  readonly label = "New Animation";
  readonly animation: Animation;

  constructor(private readonly symbolId: ItemId, name: string, duration = 1) {
    this.animation = createAnimation(name, duration);
    this.touches = { symbols: [symbolId], timeline: true };
  }
  apply(p: Project): void {
    symbolOf(p, this.symbolId).animations.push(this.animation);
    invalidateBounds([this.symbolId]);
  }
  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    sym.animations = sym.animations.filter((a) => a.id !== this.animation.id);
    invalidateBounds([this.symbolId]);
  }
}

export class RemoveAnimation implements Command {
  readonly kind = "anim.remove";
  readonly touches: TouchSet;
  readonly label = "Delete Animation";
  private removed: Animation | null = null;
  private index = -1;

  constructor(private readonly symbolId: ItemId, private readonly animId: AnimId) {
    this.touches = { symbols: [symbolId], timeline: true };
  }
  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    // An armature with no animation cannot be played at all; keep the last one.
    if (sym.animations.length <= 1) return;
    this.index = sym.animations.findIndex((a) => a.id === this.animId);
    if (this.index < 0) return;
    this.removed = sym.animations[this.index]!;
    sym.animations.splice(this.index, 1);
    invalidateBounds([this.symbolId]);
  }
  revert(p: Project): void {
    if (!this.removed) return;
    symbolOf(p, this.symbolId).animations.splice(this.index, 0, this.removed);
    invalidateBounds([this.symbolId]);
  }
  estimateSize(): number { return JSON.stringify(this.removed ?? {}).length * 2; }
}

export class RenameAnimation implements Command {
  readonly kind = "anim.rename";
  readonly touches: TouchSet;
  readonly label = "Rename Animation";
  private before = "";

  constructor(
    private readonly symbolId: ItemId,
    private readonly animId: AnimId,
    private readonly name: string,
  ) {
    this.touches = { symbols: [symbolId], timeline: true };
  }
  apply(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    this.before = anim.name;
    anim.name = this.name;
    invalidateBounds([this.symbolId]);
  }
  revert(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (anim) anim.name = this.before;
    invalidateBounds([this.symbolId]);
  }
}

/* ── Helpers used by the panel and the stage ─────────────────────────────*/

/** Replace one keyframe within a track, returning a NEW track. */
export function withKeyframe(track: Track, frame: number, patch: Partial<Keyframe>): Track {
  return {
    ...track,
    keys: track.keys.map((k) => (k.frame === frame ? { ...k, ...patch } : k)),
  };
}

export function withTween(track: Track, frame: number, tween: TweenSpec): Track {
  return withKeyframe(track, frame, { tween });
}

/** The whole ease of the interval leaving `frame`: default plus overrides. */
export function withEases(track: Track, frame: number, tween: TweenSpec, eases: ChannelEases | undefined): Track {
  return {
    ...track,
    keys: track.keys.map((k) => {
      if (k.frame !== frame) return k;
      const next = { ...k, tween };
      if (eases && Object.keys(eases).length) next.eases = eases;
      else delete next.eases;
      return next;
    }),
  };
}
