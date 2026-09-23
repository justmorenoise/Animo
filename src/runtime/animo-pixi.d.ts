/** See `animo-pixi.js`. Declared by hand because the
 *  implementation ships verbatim in the export bundle and so is authored as
 *  plain JavaScript. */

export const MANIFEST_FORMAT: "animo-extensions";

export interface MaskLink {
  /** Armature (symbol) the link belongs to. */
  armature: string;
  /** Slot whose display does the clipping. Never hide it — see the .js. */
  mask: string;
  /** Slots clipped by it. */
  targets: string[];
}

export interface MasksExtension {
  version: 1;
  masks: MaskLink[];
}

export interface MotionBlurExtension {
  version: 1;
  /** Degrees, 0–360: the fraction of a frame the shutter stays open. */
  shutter: number;
  /** Longest trail, in armature pixels. */
  maxLength: number;
  /** Trails shorter than this, in armature pixels, are not drawn. */
  threshold: number;
  /** armature name -> slot name -> multiplier. Absent means 1. A multiplier
   *  on a symbol-instance slot applies to everything inside it. */
  slots: Record<string, Record<string, number>>;
}

export interface ExtensionManifest {
  format: typeof MANIFEST_FORMAT;
  version: 1;
  extensionsUsed: string[];
  extensionsRequired: string[];
  extensions: {
    ANIMO_masks?: MasksExtension;
    ANIMO_motion_blur?: MotionBlurExtension;
  };
}

export interface ExtensionHandle {
  installed: string[];
  missing: string[];
  update(dtSeconds?: number): void;
  destroy(): void;
}

export function installExtensions(
  display: unknown, manifest: ExtensionManifest | null | undefined,
  options?: { PIXI?: unknown; ticker?: unknown },
): ExtensionHandle;

export function registerExtension(
  name: string,
  install: (display: unknown, data: unknown, pixi: unknown) =>
    { update?(dt?: number): void; destroy?(): void } | void,
): void;

export function applyMasks(display: unknown, data: MasksExtension, pixi?: unknown): number;

export interface Affine { a: number; b: number; c: number; d: number; tx: number; ty: number }

export function invertAffine(m: Affine): Affine | null;
export function multiplyAffine(m1: Affine, m2: Affine): Affine;
export function scaleAffine(m: Affine, s: number): Affine;
export function shutterScale(shutterDeg: number, frameRate: number, dtAnim: number): number;
export function blurDisplacement(prev: Affine, curr: Affine, k: number): Affine | null;
export function trailLength(disp: Affine, points: Array<{ x: number; y: number }>): number;
export function displacementToUv(
  disp: Affine, width: number, height: number, minX: number, minY: number,
): Affine;
export function nextBlurState(wasOn: boolean, length: number, threshold: number): boolean;
