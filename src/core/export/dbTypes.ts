/**
 * The DragonBones 5.5 skeleton and texture-atlas JSON shapes.
 *
 * This file is the CONTRACT. Every field name, unit and default here was
 * read out of the runtime's own parser (ObjectDataParser / Slot / Bone in
 * DragonBonesJS v6.0.2), not from documentation, and the notes record the
 * things that are easy to get wrong.
 */

export const DB_VERSION = "5.5";
export const DB_COMPATIBLE_VERSION = "5.5";

/** `{x, y, skX, skY, scX, scY}` — angles in DEGREES. Omit defaults. */
export interface DbTransform {
  x?: number;
  y?: number;
  /** Skew X. A pure rotation has skX === skY. */
  skX?: number;
  /** Skew Y. The parser reads this as the bone's rotation. */
  skY?: number;
  scX?: number;
  scY?: number;
}

/** Multipliers are PERCENTAGES 0..100; offsets are -255..255. */
export interface DbColor {
  aM?: number; rM?: number; gM?: number; bM?: number;
  aO?: number; rO?: number; gO?: number; bO?: number;
}

export interface DbBone {
  name: string;
  parent?: string;
  length?: number;
  transform?: DbTransform;
  inheritTranslation?: boolean;
  inheritRotation?: boolean;
  inheritScale?: boolean;
  inheritReflection?: boolean;
}

export interface DbSlot {
  name: string;
  /** The bone this slot hangs from. */
  parent: string;
  displayIndex?: number;
  blendMode?: string;
  color?: DbColor;
}

export interface DbDisplay {
  name: string;
  /** "image" | "armature" | "mesh" | "boundingBox". */
  type?: string;
  path?: string;
  transform?: DbTransform;
  /**
   * NORMALISED 0..1, against the UNTRIMMED frame — the runtime multiplies it
   * by `frame` when the SubTexture has one, and only by `region` when it
   * does not. Normalising against the packed region instead is the classic
   * "everything is a few pixels off in the runtime" bug.
   * Values outside 0..1 are legal; nothing clamps them.
   */
  pivot?: { x: number; y: number };
}

export interface DbSkinSlot {
  name: string;
  display: DbDisplay[];
}

export interface DbSkin {
  name: string;
  slot: DbSkinSlot[];
}

export interface DbIk {
  name: string;
  bone: string;
  target: string;
  /** 0 solves one bone; 1 solves two (the runtime takes the parent as root). */
  chain?: number;
  bendPositive?: boolean;
  weight?: number;
}

/** Durations are in FRAMES and accumulate; the terminal frame has duration 0. */
export interface DbFrameBase {
  duration?: number;
  /**
   * ABSENT means no tween — a hold. `0` means linear. Emitting 0 where you
   * meant absent turns every hold into a slide.
   */
  tweenEasing?: number;
  /** `[x1, y1, x2, y2]`; takes precedence over tweenEasing. */
  curve?: number[];
}

export interface DbTranslateFrame extends DbFrameBase { x?: number; y?: number; }

export interface DbRotateFrame extends DbFrameBase {
  /** Whole extra turns — Flash's "Rotate CW/CCW × N". */
  clockwise?: number;
  /** Delta in skY, degrees. */
  rotate?: number;
  /** Delta in (skX − skY), degrees. NOT a delta in skX. */
  skew?: number;
}

export interface DbScaleFrame extends DbFrameBase { x?: number; y?: number; }

export interface DbDisplayFrame {
  duration?: number;
  /** Display index; -1 hides the slot (a blank keyframe). */
  value?: number;
}

export interface DbColorFrame extends DbFrameBase { color?: DbColor; }

export interface DbBoneTimeline {
  name: string;
  translateFrame?: DbTranslateFrame[];
  rotateFrame?: DbRotateFrame[];
  scaleFrame?: DbScaleFrame[];
}

export interface DbSlotTimeline {
  name: string;
  displayFrame?: DbDisplayFrame[];
  colorFrame?: DbColorFrame[];
}

export interface DbAnimation {
  name: string;
  duration: number;
  /** 0 loops forever. */
  playTimes?: number;
  bone?: DbBoneTimeline[];
  slot?: DbSlotTimeline[];
}

export interface DbArmature {
  name: string;
  type?: string;
  frameRate?: number;
  bone: DbBone[];
  slot: DbSlot[];
  skin: DbSkin[];
  ik?: DbIk[];
  animation: DbAnimation[];
  defaultActions?: Array<{ gotoAndPlay: string }>;
}

export interface DbSkeleton {
  name: string;
  version: string;
  compatibleVersion: string;
  frameRate: number;
  armature: DbArmature[];
}

export interface DbSubTexture {
  name: string;
  x: number;
  y: number;
  /** The TRIMMED region size. */
  width: number;
  height: number;
  /** Present only when trimmed: the NEGATIVE of the trim offset. */
  frameX?: number;
  frameY?: number;
  /** The UNTRIMMED size. */
  frameWidth?: number;
  frameHeight?: number;
  rotated?: boolean;
}

export interface DbAtlas {
  /** Must equal the skeleton's `name`, or the factory will not pair them. */
  name: string;
  imagePath: string;
  width: number;
  height: number;
  /** Texture resolution below 1; absent = 1. The parser keeps `1 / scale`
   *  and multiplies every sprite by it (`PixiSlot._textureScale`). */
  scale?: number;
  SubTexture: DbSubTexture[];
}
