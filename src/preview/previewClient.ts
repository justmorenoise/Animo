/// <reference path="../vendor/dragonBones.d.ts" />
import { displayRunStart, type FrameToHost, type HostToFrame, type PreviewTexture, tickFrame } from "./protocol";
import { type ExtensionHandle, installExtensions } from "@/runtime/animo-pixi.js";

/**
 * Runs inside the preview iframe. Drives the OFFICIAL DragonBones runtime on
 * PixiJS 8, fed the exact bytes the editor would write to disk.
 *
 * That is the whole point of this file: it is not a second renderer, it IS
 * the runtime. If what plays here matches the stage, the export is right.
 */

const errEl = document.getElementById("err")!;

/**
 * Drive the DragonBones clock ourselves.
 *
 * PixiFactory registers itself on `PIXI.Ticker.shared`, but a Pixi 8
 * Application creates its OWN ticker unless told otherwise, so the shared one
 * never runs: armatures pose once at build time and then sit frozen, with
 * their sprites still hidden and untextured. This must be set BEFORE the
 * factory singleton is first touched, since that is when it wires the ticker.
 * Owning the clock also gives the parity harness a deterministic step.
 */
dragonBones.PixiFactory.useSharedTicker = false;

/**
 * The editor, which embeds this page in an iframe. `window.opener` is still
 * accepted so the page also works when opened by hand in a second window.
 */
function host(): Window | null {
  return (parent !== window ? parent : null) ?? window.opener;
}

function post(msg: FrameToHost): void {
  host()?.postMessage(msg, "*");
}

function fail(err: unknown): void {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  errEl.style.display = "block";
  errEl.textContent = message;
  post({ type: "error", message });
}

window.addEventListener("error", (e) => fail(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => fail(e.reason));

let app: PIXI.Application | null = null;
let display: dragonBones.PixiArmatureDisplay | null = null;
let factory: dragonBones.PixiFactory | null = null;
let textures: PIXI.Texture[] = [];
let currentAnimation = "";
/** The last `setLoop`: every later play has to honour it, or switching the
 *  animation with Loop off played the new one forever. */
let loop = true;
const playTimes = () => (loop ? 0 : 1);
let fitBox: { x: number; y: number; w: number; h: number } | null = null;
let stageBox: { width: number; height: number; background: string } | null = null;
let stageGfx: PIXI.Graphics | null = null;
let showStage = true;
let frameRate = 24;
let lastReportedFrame = -1;
let extensions: ExtensionHandle | null = null;
/** The skeleton as loaded, for the display timelines `seekChildren` reads. */
let skeleton: RawSkeleton | null = null;
/** Bumped by every `load`; a load that a newer one overtook while it was
 *  decoding gives up instead of replacing the newer armature. */
let loadSeq = 0;

async function ensureApp(): Promise<PIXI.Application> {
  if (app) return app;
  const a = new PIXI.Application();
  await a.init({
    background: 0x353535,
    resizeTo: document.body,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  document.body.appendChild(a.canvas);

  // The static `advanceTime` reads the singleton's clock, which only exists
  // once the factory has been touched; `load` decodes its textures before it
  // gets there, so the first ticks would find it null.
  factory = dragonBones.PixiFactory.factory;
  a.ticker.add((ticker) => {
    // An exception here ends Pixi's ticker loop — no more frames, drawn or
    // posed — so it is reported and the loop kept alive.
    try {
      dragonBones.PixiFactory.advanceTime(ticker.deltaMS / 1000);
      // Exactly where a game that owns its clock must call it: right after
      // the armature is posed.
      extensions?.update(ticker.deltaMS / 1000);
      reportTick();
    } catch (err) {
      fail(err);
    }
  });

  app = a;
  return a;
}

function reportTick(): void {
  if (!display) return;
  const state = display.animation as unknown as { isPlaying: boolean };
  const time = (display.animation.play as unknown) && currentAnimation
    ? currentTimeOf()
    : 0;
  const count = display.armature.armatureData.animations[currentAnimation]?.frameCount ?? 0;
  const frame = tickFrame(time, frameRate, count);
  if (frame !== lastReportedFrame) {
    lastReportedFrame = frame;
    post({ type: "tick", frame, playing: state.isPlaying });
  }
}

function currentTimeOf(): number {
  const anim = display?.animation as unknown as { lastAnimationState?: { currentTime: number } };
  return anim?.lastAnimationState?.currentTime ?? 0;
}

function disposeCurrent(): void {
  extensions?.destroy();
  extensions = null;
  if (display) {
    display.dispose(true);
    display = null;
  }
  factory?.clear(true);
  for (const t of textures) t.destroy(true);
  textures = [];
  app?.stage.removeChildren();
}

async function load(msg: Extract<HostToFrame, { type: "load" }>): Promise<void> {
  const seq = ++loadSeq;
  const a = await ensureApp();
  // Decode while the old armature is still on screen. Every await between
  // disposing it and adding the new one was a frame Pixi drew with nothing
  // in it — the flash on every rebuild while playing.
  const pages = msg.textures as PreviewTexture[];
  const bitmaps = await Promise.all(pages.map((tex) => createImageBitmap(tex.png)));
  if (seq !== loadSeq) {
    for (const b of bitmaps) b.close();
    return;
  }

  // Nothing below awaits: the old armature goes and the new one arrives,
  // posed and fitted, between two frames.
  errEl.style.display = "none";
  disposeCurrent();
  factory = dragonBones.PixiFactory.factory;
  factory.parseDragonBonesData(msg.skeleton);
  skeleton = msg.skeleton as RawSkeleton;

  pages.forEach((tex, i) => {
    // Build the texture straight from the decoded bitmap. PIXI.Assets cannot
    // resolve a blob URL — it has no file extension to pick a parser from —
    // and hands back an EMPTY texture without raising anything, which shows
    // up much later as an armature that poses correctly but draws nothing.
    const texture = PIXI.Texture.from(bitmaps[i]!);
    textures.push(texture);
    factory!.parseTextureAtlasData(tex.json, texture);
  });

  fitBox = msg.fit ?? null;
  stageBox = msg.stage ?? null;
  const ske = msg.skeleton as { frameRate?: number; armature: Array<{ name: string }> };
  frameRate = ske.frameRate ?? 24;
  const armatureName = msg.armature ?? ske.armature[0]?.name;
  if (!armatureName) throw new Error("The skeleton contains no armature.");

  const built = factory.buildArmatureDisplay(armatureName);
  if (!built) {
    throw new Error(
      `Could not build armature "${armatureName}". ` +
      `Usually the atlas name does not match the skeleton name.`,
    );
  }
  display = built;
  display.debugDraw = msg.debugDraw ?? false;

  // Same call, same file, same moment as in a game: right after
  // buildArmatureDisplay.
  if (msg.extensions) {
    extensions = installExtensions(display, msg.extensions, { PIXI });
    if (extensions.missing.length) console.warn("[preview] unknown extensions:", extensions.missing);
  }

  const names = display.animation.animationNames;
  currentAnimation = msg.animation && names.includes(msg.animation)
    ? msg.animation
    : names[0] ?? "";

  const data = display.armature.armatureData.animations[currentAnimation];
  const duration = data ? Math.round(data.duration * frameRate) : 0;

  // Fitted before it is added: the fit reads the editor's box and the canvas
  // size, not the pose, and waiting for the next frame showed the armature
  // at its origin and full size for one frame first.
  fitToFrame();
  drawStage(a);
  a.stage.addChild(display);
  if (currentAnimation) {
    if (msg.play) {
      display.animation.play(currentAnimation, playTimes());
      playChildren(display.armature, currentAnimation);
    } else {
      seekTo(display.armature, currentAnimation, msg.frame ?? 0);
      seekChildren(display.armature, currentAnimation, msg.frame ?? 0);
    }
  }

  post({ type: "loaded", armature: armatureName, animations: names, duration });
}

/**
 * Put every nested armature at the frame the parent is showing.
 *
 * A symbol instance is a child armature with its OWN looping timeline, and
 * the runtime advances it from its own clock — seeking the root does not
 * reach it. Scrubbing therefore froze every nested symbol at
 * whatever phase its free-running clock happened to be in, which is what
 * made an eyelid animated inside `eye_left` (mask and all) look like it was
 * simply not there while the stage showed it closed.
 *
 * The wrap is `core/doc/pose.ts`'s `childFrame` and `displayContext`,
 * deliberately: a child shown since the parent's frame 0 matches the name
 * (else its first animation) and takes the parent's frame; one swapped in
 * later was restarted there on its default animation. Either way the frame
 * wraps, because the child loops (playTimes 0). The caller has already
 * posed `armature` with `seekTo`, so a display switch at `frame` has
 * happened and `childArmature` is the one showing there.
 */
function seekChildren(armature: dragonBones.Armature, name: string, frame: number): void {
  for (const slot of armature.getSlots()) {
    const child = slot.childArmature;
    if (!child) continue;
    const since = displayRunStart(displayFramesOf(armature.name, name, slot.name), frame);
    const anims = child.armatureData.animations;
    const childName = since > 0
      ? child.armatureData.defaultAnimation?.name ?? Object.keys(anims)[0]
      : anims[name] ? name : Object.keys(anims)[0];
    if (!childName) continue;
    const count = anims[childName]?.frameCount ?? 0;
    const local = frame - since;
    const at = count > 0 ? ((local % count) + count) % count : 0;
    seekTo(child, childName, at);
    seekChildren(child, childName, at);
  }
}

/**
 * Pose an armature on a frame and leave it stopped there.
 *
 * `gotoAndStopByFrame` alone is not enough: the state it makes is never
 * "playing", its timelines keep `playState` -1, and
 * `SlotDisplayTimelineState._onArriveAtFrame` applies nothing until that is
 * 0 — so a blank key, a track that starts late or a display switch did not
 * show while scrubbing, and the slot kept whatever it showed before. One
 * zero-length tick of playing sets it; the pose is the same frame either way.
 */
function seekTo(armature: dragonBones.Armature, name: string, frame: number): void {
  armature.animation.gotoAndPlayByFrame(name, frame);
  armature.advanceTime(0);
  armature.animation.stop(name);
}

interface RawSkeleton {
  armature?: Array<{
    name: string;
    animation?: Array<{
      name: string;
      slot?: Array<{ name: string; displayFrame?: Array<{ duration?: number; value?: number }> }>;
    }>;
  }>;
}

function displayFramesOf(armature: string, animation: string, slot: string) {
  return skeleton?.armature?.find((a) => a.name === armature)
    ?.animation?.find((a) => a.name === animation)
    ?.slot?.find((s) => s.name === slot)?.displayFrame;
}

/**
 * Restart every nested timeline in phase with the root's.
 *
 * `play` on the root leaves the children mid-loop, so pressing play twice
 * gave two different-looking animations. Both ends of the parity check —
 * the editor's `childFrame` and this — assume the children start at 0.
 */
function playChildren(armature: dragonBones.Armature, name: string): void {
  for (const slot of armature.getSlots()) {
    const child = slot.childArmature;
    if (!child) continue;
    const anims = child.armatureData.animations;
    const childName = anims[name] ? name : Object.keys(anims)[0];
    if (!childName) continue;
    child.animation.play(childName, 0);
    playChildren(child, childName);
  }
}

/** Carry every nested timeline on from where it stopped. */
function resumeChildren(armature: dragonBones.Armature): void {
  for (const slot of armature.getSlots()) {
    const child = slot.childArmature;
    if (!child) continue;
    for (const name of child.animation.animationNames) {
      child.animation.getState(name)?.play();
    }
    resumeChildren(child);
  }
}

/** Pause every nested timeline, for the same reason `seekChildren` exists. */
function stopChildren(armature: dragonBones.Armature): void {
  for (const slot of armature.getSlots()) {
    const child = slot.childArmature;
    if (!child) continue;
    child.animation.stop();
    stopChildren(child);
  }
}

/**
 * Outline the scene bounds.
 *
 * Without it a detached preview is just a figure floating in grey, with no
 * way to tell how it sits in the scene — which is most of the point of
 * opening it in its own window.
 */
function drawStage(a: PIXI.Application): void {
  stageGfx?.destroy();
  stageGfx = null;
  if (!stageBox || !showStage) return;

  const g = new PIXI.Graphics();
  g.rect(0, 0, stageBox.width, stageBox.height);
  g.fill({ color: colorOf(stageBox.background), alpha: 1 });
  g.rect(0, 0, stageBox.width, stageBox.height);
  g.stroke({ color: 0x000000, alpha: 0.35, width: 1 });
  a.stage.addChild(g);
  stageGfx = g;
  positionStage();
}

function positionStage(): void {
  if (!stageGfx || !display) return;
  stageGfx.x = display.x;
  stageGfx.y = display.y;
  stageGfx.scale.set(display.scale.x, display.scale.y);
}

function colorOf(css: string): number {
  const hex = css.replace("#", "");
  const n = parseInt(hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex, 16);
  return Number.isFinite(n) ? n : 0xffffff;
}

/**
 * Fit the armature's contents into the frame.
 *
 * The box comes from the editor rather than from `display.getBounds()`,
 * because Pixi reports a degenerate 1x1 for a DragonBones display container
 * — its slots are driven by the runtime, not by Pixi's own transform tree.
 * Falling back to centring the origin would push a rig authored around, say,
 * (400, 300) entirely off screen.
 */
function fitToFrame(): void {
  if (!app || !display) return;
  const w = app.canvas.clientWidth || app.canvas.width || 320;
  const h = app.canvas.clientHeight || app.canvas.height || 240;

  // Frame the stage when we know it, so the rig is shown in context rather
  // than blown up to fill the panel.
  const box = showStage && stageBox
    ? { x: 0, y: 0, w: stageBox.width, h: stageBox.height }
    : fitBox && fitBox.w > 0 && fitBox.h > 0 ? fitBox : null;

  if (!box) {
    display.scale.set(1, 1);
    display.x = w / 2;
    display.y = h / 2;
    positionStage();
    return;
  }

  const margin = 0.92;
  const scale = Math.min((w * margin) / box.w, (h * margin) / box.h);
  display.scale.set(scale, scale);
  display.x = w / 2 - (box.x + box.w / 2) * scale;
  display.y = h / 2 - (box.y + box.h / 2) * scale;
  positionStage();
}

window.addEventListener("resize", () => fitToFrame());
new ResizeObserver(() => fitToFrame()).observe(document.body);

window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data as HostToFrame;
  if (!msg || typeof msg !== "object" || !("type" in msg)) return;

  (async () => {
    switch (msg.type) {
      case "load":
        await load(msg);
        break;

      case "clear":
        loadSeq++;
        errEl.style.display = "none";
        disposeCurrent();
        skeleton = null;
        currentAnimation = "";
        fitBox = null;
        stageBox = null;
        stageGfx?.destroy();
        stageGfx = null;
        lastReportedFrame = -1;
        break;

      case "play":
        if (display && currentAnimation) {
          display.animation.play(currentAnimation, playTimes());
          playChildren(display.armature, currentAnimation);
        }
        break;

      case "resume":
        // `Animation.play` clears the state and restarts at 0. The STATE's own
        // `play` just lifts the playhead flag, which is what "carry on" means.
        if (display && currentAnimation) {
          const state = display.animation.getState(currentAnimation);
          if (state) { state.play(); resumeChildren(display.armature); }
          else { display.animation.play(currentAnimation, playTimes()); playChildren(display.armature, currentAnimation); }
        }
        break;

      case "pause":
        // `stop` reaches only the root; a child armature runs off its own
        // clock and would keep blinking under a paused rig.
        display?.animation.stop();
        if (display) stopChildren(display.armature);
        break;

      case "setLoop":
        // 0 is "forever", exactly as `playTimes` means everywhere else. A
        // nested symbol always loops: it is scenery under the parent's clock.
        loop = msg.on;
        if (display && currentAnimation) {
          const state = display.animation.getState(currentAnimation);
          if (state) state.playTimes = playTimes();
        }
        break;

      case "seek":
        if (display && currentAnimation) {
          // Deterministic, unlike play()-then-wait, and the parity harness
          // depends on landing exactly on a frame.
          seekTo(display.armature, currentAnimation, msg.frame);
          seekChildren(display.armature, currentAnimation, msg.frame);
        }
        break;

      case "setAnimation":
        if (display && display.animation.animationNames.includes(msg.name)) {
          currentAnimation = msg.name;
          display.animation.play(currentAnimation, playTimes());
          playChildren(display.armature, currentAnimation);
        }
        break;

      case "setDebug":
        if (display) display.debugDraw = msg.on;
        break;

      case "setBackground":
        if (app) app.renderer.background.color = colorOf(msg.color);
        break;

      case "showStage":
        showStage = msg.on;
        if (app) { drawStage(app); fitToFrame(); }
        break;

      case "getMatrices": {
        const bones: Record<string, number[]> = {};
        const slots: Record<string, number[]> = {};
        if (display) {
          for (const b of display.armature.getBones()) {
            const m = b.globalTransformMatrix;
            bones[b.name] = [m.a, m.b, m.c, m.d, m.tx, m.ty];
          }
          for (const s of display.armature.getSlots()) {
            const m = s.globalTransformMatrix;
            slots[s.name] = [m.a, m.b, m.c, m.d, m.tx, m.ty];
          }
        }
        post({ type: "matrices", bones, slots });
        break;
      }
    }
  })().catch(fail);
});

/**
 * The vendored build reports "5.7.000" in `DragonBones.VERSION`; the "6.0.2"
 * on the npm package is the Pixi-8 wrapper's own version, not the runtime's.
 * Both refer to the same build, so this is informational only.
 */
const version = dragonBones.DragonBones.VERSION;

// Exposed for debugging and for the parity harness, which needs the runtime's
// own matrices to compare against the editor's.
(window as unknown as Record<string, unknown>).__preview = {
  get app() { return app; },
  get display() { return display; },
  get factory() { return factory; },
  fitToFrame,
};

post({ type: "ready", version });
