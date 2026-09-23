/**
 * Ambient declarations for the two vendored global scripts, covering only
 * the API surface the preview actually calls. Far lighter than pulling full
 * typings for a prebuilt UMD bundle.
 */

declare namespace PIXI {
  class Application {
    init(options: Record<string, unknown>): Promise<void>;
    canvas: HTMLCanvasElement;
    stage: Container & { setChildIndex(child: unknown, index: number): void };
    renderer: { resize(w: number, h: number): void; background: { color: number } };
    ticker: {
      add(fn: (ticker: { deltaMS: number }) => void): void;
      remove(fn: (ticker: { deltaMS: number }) => void): void;
      deltaMS: number;
    };
    destroy(removeView?: boolean, options?: Record<string, unknown>): void;
  }
  class Container {
    addChild<T>(child: T): T;
    removeChildren(): void;
    x: number; y: number;
    scale: { set(x: number, y?: number): void; x: number; y: number };
    getBounds(skipUpdate?: boolean): { x: number; y: number; width: number; height: number };
  }
  class Graphics extends Container {
    rect(x: number, y: number, w: number, h: number): Graphics;
    fill(style: { color: number; alpha?: number }): Graphics;
    stroke(style: { color: number; alpha?: number; width?: number }): Graphics;
    destroy(): void;
  }
  class Texture {
    static from(source: ImageBitmap | HTMLCanvasElement | HTMLImageElement): Texture;
    destroy(destroySource?: boolean): void;
  }
}

declare namespace dragonBones {
  const DragonBones: { VERSION: string };

  interface AnimationState {
    currentTime: number;
    timeScale: number;
    /** 0 loops forever, as `playTimes` does everywhere else in the format. */
    playTimes: number;
    /** Resume where it stopped — `Animation.play` always restarts at 0. */
    play(): void;
    stop(): void;
  }

  interface Animation {
    play(name?: string, playTimes?: number): AnimationState | null;
    gotoAndStopByFrame(name: string, frame?: number): AnimationState | null;
    gotoAndPlayByFrame(name: string, frame?: number, playTimes?: number): AnimationState | null;
    stop(name?: string): void;
    getState(name: string, layer?: number): AnimationState | null;
    readonly animationNames: string[];
    readonly isPlaying: boolean;
    reset(): void;
  }

  interface Bone { name: string; readonly globalTransformMatrix: Matrix; }
  interface Slot {
    name: string;
    readonly globalTransformMatrix: Matrix;
    /** Non-null for a symbol instance: the nested armature and its own clock. */
    readonly childArmature: Armature | null;
    readonly displayIndex: number;
    /** Every display the slot can switch to: a Pixi display object, or an
     *  Armature for an armature display. */
    readonly displayList: unknown[];
  }
  interface Matrix { a: number; b: number; c: number; d: number; tx: number; ty: number; }

  interface ArmatureData {
    readonly name: string;
    readonly animations: Record<string, { duration: number; frameCount: number }>;
    /** What `Animation.play()` with no name plays: the `defaultActions` one. */
    readonly defaultAnimation: { name: string } | null;
  }

  interface Armature {
    readonly name: string;
    readonly animation: Animation;
    readonly armatureData: ArmatureData;
    getBones(): Bone[];
    getSlots(): Slot[];
    advanceTime(seconds: number): void;
    dispose(): void;
  }

  interface PixiArmatureDisplay extends PIXI.Container {
    readonly animation: Animation;
    readonly armature: Armature;
    debugDraw: boolean;
    dispose(disposeProxy?: boolean): void;
  }

  interface PixiFactory {
    parseDragonBonesData(raw: unknown, name?: string, scale?: number): unknown;
    parseTextureAtlasData(raw: unknown, texture: PIXI.Texture, name?: string, scale?: number): unknown;
    buildArmatureDisplay(
      armatureName: string, dragonBonesName?: string, skinName?: string, textureAtlasName?: string,
    ): PixiArmatureDisplay | null;
    clear(disposeData?: boolean): void;
  }

  const PixiFactory: {
    readonly factory: PixiFactory;
    newInstance(useSharedTicker?: boolean): PixiFactory;
    useSharedTicker: boolean;
    /** Advance the singleton's clock by `seconds`. */
    advanceTime(seconds: number): void;
  };
}
