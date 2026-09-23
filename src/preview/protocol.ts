/** postMessage contract between the editor and the preview iframe. */

import type { ExtensionManifest } from "@/runtime/animo-pixi";

export interface PreviewTexture {
  json: unknown;
  png: Blob;
}

export type HostToFrame =
  | { type: "load"; skeleton: unknown; textures: PreviewTexture[];
      armature?: string; animation?: string; debugDraw?: boolean;
      /** Start playing straight away. Off by default: an animation looping in
       *  the corner while you work is a distraction, not information. */
      play?: boolean;
      /** Frame to rest on when not playing. */
      frame?: number;
      /** Scene bounds, drawn as an outline so the framing is legible. */
      stage?: { width: number; height: number; background: string };
      /** Content bounds in armature space, so the frame can fit the rig.
       *  Supplied by the editor because Pixi cannot measure a DragonBones
       *  display container without a render pass. */
      fit?: { x: number; y: number; w: number; h: number };
      /** What the skeleton cannot carry (masks, motion blur). The preview
       *  installs it exactly the way a game would — otherwise it would stop
       *  being ground truth the moment an extension is in use. */
      extensions?: ExtensionManifest | null }
  /** Take whatever is loaded off the screen: the document has nothing to
   *  show (a new project), and leaving the previous rig up says the editor
   *  and the runtime disagree when they do not. */
  | { type: "clear" }
  | { type: "play" }
  /** Carry on from where `pause` left off. `play` always restarts at frame 0
   *  (`Animation.play` resets the state), which reads as a bug the moment
   *  there is a pause button next to it. */
  | { type: "resume" }
  | { type: "pause" }
  | { type: "setLoop"; on: boolean }
  | { type: "seek"; frame: number }
  | { type: "setAnimation"; name: string }
  | { type: "setDebug"; on: boolean }
  | { type: "setBackground"; color: string }
  | { type: "showStage"; on: boolean }
  /** Used by the parity harness: the runtime's own world matrices. */
  | { type: "getMatrices" };

export type FrameToHost =
  | { type: "ready"; version: string }
  | { type: "loaded"; armature: string; animations: string[]; duration: number }
  | { type: "tick"; frame: number; playing: boolean }
  | { type: "matrices"; bones: Record<string, number[]>; slots: Record<string, number[]> }
  | { type: "error"; message: string };

export const PREVIEW_ORIGIN_SAME = true;

/**
 * Where the run a slot's display timeline is in at `frame` began: the frame
 * the display showing there was last swapped in, which is where the runtime
 * reset and restarted a child armature shown there. The same rule as
 * `displaySince` in `core/doc/pose.ts`, read off the exported frames; 0 for
 * a slot with no display timeline.
 */
export function displayRunStart(
  frames: ReadonlyArray<{ duration?: number; value?: number }> | undefined, frame: number,
): number {
  if (!frames?.length) return 0;
  const starts: number[] = [];
  let t = 0;
  for (const f of frames) { starts.push(t); t += f.duration ?? 1; }
  let i = 0;
  while (i + 1 < frames.length && starts[i + 1]! <= frame && (frames[i + 1]!.duration ?? 1) > 0) i++;
  const value = frames[i]!.value ?? 0;
  while (i > 0 && (frames[i - 1]!.value ?? 0) === value) i--;
  return starts[i]!;
}

/**
 * The frame a `tick` reports: the one on screen, which is the frame the
 * animation time has reached, never the next one. Rounding reported the next
 * frame for the second half of every frame and, at the end of each loop, one
 * past the last — so a one-frame animation sent the editor's playhead back
 * and forth between frames 1 and 2 a hundred times a second.
 */
export function tickFrame(time: number, frameRate: number, frameCount: number): number {
  const frame = Math.floor(time * frameRate + 1e-6);
  return Math.max(0, Math.min(Math.max(0, frameCount - 1), frame));
}
