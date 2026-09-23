/**
 * Animo runtime extensions for PixiJS 8.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Moreno Tomasella / Morenoise
 *
 * MIT, deliberately, while the rest of Animo is AGPL-3.0-or-later: the export
 * copies this file byte for byte into the zip, and it then ships inside the
 * games people make. A copyleft licence here would reach their code. See
 * LICENSE-EXCEPTION.md.
 *
 * DragonBones 5.5 cannot express everything the editor authors. What it
 * cannot carry travels beside the skeleton in `<name>_ext.json`, a manifest
 * modelled on glTF's extensions, and this file applies it to a display built
 * by the stock `PixiFactory`:
 *
 *   import { installExtensions } from "./animo-pixi.js";
 *   const display = factory.buildArmatureDisplay("scene");
 *   const ext = installExtensions(display, manifest, { PIXI, ticker: app.ticker });
 *   // later: ext.destroy();
 *
 * The manifest separates `extensionsUsed` from `extensionsRequired`. A
 * required extension changes what the animation IS (masks: without them
 * artwork that should be hidden is drawn); an optional one only enriches it
 * (motion blur). An unknown required extension is reported loudly.
 *
 * This file is the only implementation: the editor's preview imports it and
 * the export ships it byte for byte, so the preview shows what a game shows.
 */

export const MANIFEST_FORMAT = "animo-extensions";

/** name -> (display, data, PIXI) => { update?(dtSeconds), destroy?() } */
const registry = new Map();

export function registerExtension(name, install) {
  registry.set(name, install);
}

/**
 * Apply every known extension in `manifest` to `display`.
 *
 * @param {object} display   PixiArmatureDisplay from buildArmatureDisplay.
 * @param {object} manifest  The parsed `<name>_ext.json`.
 * @param {object} [options]
 * @param {object} [options.PIXI]    Defaults to the global PIXI, which the
 *                                   DragonBones Pixi build needs anyway.
 * @param {object} [options.ticker]  A PIXI.Ticker. When given, `update` runs
 *                                   on it at LOW priority, AFTER the
 *                                   DragonBones factory (NORMAL) has advanced
 *                                   the armature. Without it, call
 *                                   `update(dtSeconds)` yourself right after
 *                                   advancing the clock.
 * @returns {{ installed: string[], missing: string[], update(dt?: number): void, destroy(): void }}
 */
export function installExtensions(display, manifest, options = {}) {
  const handle = { installed: [], missing: [], update() {}, destroy() {} };
  if (!display || !manifest || manifest.format !== MANIFEST_FORMAT) return handle;

  const PIXI = options.PIXI || (typeof globalThis !== "undefined" ? globalThis.PIXI : null);
  if (!PIXI || !PIXI.Texture) {
    console.warn("[animo] PIXI not found; pass it as options.PIXI.");
    return handle;
  }

  const required = new Set(manifest.extensionsRequired || []);
  const extensions = manifest.extensions || {};
  const parts = [];

  for (const name of manifest.extensionsUsed || []) {
    const install = registry.get(name);
    if (!install) {
      handle.missing.push(name);
      if (required.has(name)) {
        console.warn(
          `[animo] required extension "${name}" is not supported by this ` +
          `runtime; the animation will not play as authored.`,
        );
      }
      continue;
    }
    const data = extensions[name];
    if (!data) continue;
    parts.push(install(display, data, PIXI) || {});
    handle.installed.push(name);
  }

  handle.update = (dt) => {
    for (const part of parts) if (part.update) part.update(dt);
  };

  let tickerFn = null;
  if (options.ticker) {
    tickerFn = (ticker) => handle.update(ticker.deltaMS / 1000);
    const low = PIXI.UPDATE_PRIORITY ? PIXI.UPDATE_PRIORITY.LOW : -25;
    options.ticker.add(tickerFn, null, low);
  }

  handle.destroy = () => {
    if (tickerFn) options.ticker.remove(tickerFn);
    for (const part of parts) if (part.destroy) part.destroy();
    parts.length = 0;
  };
  return handle;
}

/**
 * Every armature in the display tree, root first, each once — including the
 * child armatures of displays a slot is not showing yet: the factory builds
 * them all up front, and a slot that switches artwork shows them later.
 */
function armaturesOf(root) {
  const out = [];
  const seen = new Set();
  const walk = (arm) => {
    if (!arm || seen.has(arm)) return;
    seen.add(arm);
    out.push(arm);
    for (const slot of arm.getSlots()) {
      if (slot.childArmature) walk(slot.childArmature);
      for (const d of slot.displayList || []) {
        if (d && typeof d.getSlots === "function") walk(d);
      }
    }
  };
  walk(root);
  return out;
}

/* ── ANIMO_masks ──────────────────────────────────────────────────────────────
 *
 * DragonBones 5.x has NO mask concept: the format cannot express one, the
 * parser has no key for it, and `PixiSlot` never touches `display.mask` —
 * every "Mask" in the runtime is `boneMask`, the per-bone filter used when
 * blending animation states.
 *
 * `.mask` is a property of the display object, and the runtime neither
 * reads nor writes it — it survives z-order changes (`_updateZOrder` only
 * calls `addChildAt`) and animation changes. Two things do NOT survive, so
 * `update` re-checks both every frame (reference compares, nothing more):
 *
 *  - the white texture. `_updateFrame` puts the atlas texture back whenever
 *    the slot's display data changes — a mask layer switching artwork, or
 *    simply coming back from a blank key or a late start — and a black
 *    mask then clips everything away;
 *  - which object a target shows. A target that switches between an image
 *    and a nested symbol swaps its display object, and the new one has no
 *    `.mask`.
 *
 * Why the mask texture is repainted white: Pixi's mask shader is
 * `a = masky.a * masky.r`. Flash — and the editor's stage, which clips with
 * `destination-in` — uses alpha alone, so a mask drawn as a BLACK silhouette,
 * the natural way to author one, has red = 0 and clips its targets away
 * entirely, without a warning. Each mask slot's texture is therefore replaced
 * by a copy with RGB forced to white and alpha untouched. The mask's own
 * artwork is never drawn, so the repaint is invisible. The copy is made once
 * per atlas page and shares the page's frame, orig, trim and rotation.
 *
 * Do NOT reach for a Container wrapper instead: it takes Pixi's other mask
 * path (render-to-texture), where a Sprite child comes out as a flat opaque
 * rectangle and every mask ends up square. Measured against Pixi 8.9.2, as is
 * everything here. Also measured:
 *
 *  - One mask display can clip SEVERAL targets. Sharing is safe.
 *  - `maskDisplay.visible = false` DISABLES the clip, revealing the whole
 *    target rather than hiding it. Never hide a mask slot; hide the slots it
 *    clips.
 */
export function applyMasks(display, data, PIXI) {
  return maskBinder(display, data, PIXI)();
}

/** Resolve the links once; the returned function applies them, and returns
 *  how many targets are clipped. Cheap enough to run every frame. */
function maskBinder(display, data, PIXI) {
  if (!display || !data || !Array.isArray(data.masks)) return () => 0;
  PIXI = PIXI || (typeof globalThis !== "undefined" ? globalThis.PIXI : null);
  if (!PIXI || !display.armature) return () => 0;

  const whiteSourceOf = (source) => {
    if (source.__dbsWhiteSource) return source.__dbsWhiteSource;
    const resource = source.resource;
    if (!resource || typeof document === "undefined") return null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = source.width;
      canvas.height = source.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(resource, 0, 0);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const white = PIXI.Texture.from(canvas).source;
      source.__dbsWhiteSource = white;
      return white;
    } catch (err) {
      console.warn("[ANIMO_masks] could not repaint the mask texture:", err);
      return null;
    }
  };

  const whiten = (maskDisplay) => {
    const texture = maskDisplay.texture;
    if (!texture || maskDisplay.__dbsWhitened === texture) return;
    const source = whiteSourceOf(texture.source);
    if (!source) return;
    maskDisplay.texture = new PIXI.Texture({
      source,
      frame: texture.frame,
      orig: texture.orig,
      trim: texture.trim,
      rotate: texture.rotate,
    });
    maskDisplay.__dbsWhitened = maskDisplay.texture;
  };

  // A symbol instance is a CHILD ARMATURE with its own slots, and a mask
  // inside a symbol that moves with its parent is the ordinary case.
  const bound = [];
  for (const arm of armaturesOf(display.armature)) {
    for (const link of data.masks) {
      if (link.armature !== arm.name) continue;
      const maskSlot = arm.getSlot(link.mask);
      if (!maskSlot) continue;
      const targets = link.targets.map((name) => arm.getSlot(name)).filter(Boolean);
      bound.push({ maskSlot, targets });
    }
  }

  return () => {
    let applied = 0;
    for (const { maskSlot, targets } of bound) {
      const maskDisplay = maskSlot.display;
      if (!maskDisplay) continue;
      whiten(maskDisplay);
      for (const slot of targets) {
        const target = slot.display;
        if (!target || target === maskDisplay) continue;
        if (target.mask !== maskDisplay) target.mask = maskDisplay;
        applied++;
      }
    }
    return applied;
  };
}

registerExtension("ANIMO_masks", (display, data, PIXI) => {
  const apply = maskBinder(display, data, PIXI);
  apply();
  return { update: () => { apply(); } };
});

/* ── ANIMO_motion_blur ────────────────────────────────────────────────────────
 *
 * Per-sprite motion blur driven by how each sprite's PIXELS moved, not by a
 * bone origin: a foot rotating about the ankle has a nearly still origin and
 * a fast toe. From the sprite's world matrix now (W) and one update ago (P),
 * the map A = W·P⁻¹ carries where the artwork was onto where it is, and a
 * point g on screen was swept by the artwork that now lies at A·g. The filter
 * averages the rendered sprite along g + f·δ(g), f ∈ [−½, ½], with
 * δ(g) = k·(A − I)·g — an affine field, so a rotation blurs nothing at the
 * pivot and most at the tip.
 *
 * k turns one update's motion into the motion during the SHUTTER:
 * k = (shutter/360) / frameRate / Δt, with Δt measured on the animation's own
 * clock (the state's `currentTime`). Rendering at 120 Hz therefore gives the
 * same trail as 60 Hz, a paused or timeScale-0 animation gives none, and a
 * loop wrap (time going backwards) repeats the previous trail for one update
 * instead of drawing a streak across the whole jump.
 *
 * Sizes (`maxLength`, `threshold`) are in ARMATURE pixels, so zooming the
 * display scales the blur with the artwork instead of changing its amount.
 *
 * WebGL only. On a WebGPU renderer Pixi skips the filter and the animation
 * plays unblurred, which is why this extension is never required.
 */

/** Affine matrices as {a, b, c, d, tx, ty}, Pixi's convention. */
export function invertAffine(m) {
  const det = m.a * m.d - m.b * m.c;
  if (!det) return null;
  return {
    a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det,
    tx: (m.c * m.ty - m.d * m.tx) / det,
    ty: (m.b * m.tx - m.a * m.ty) / det,
  };
}

/** m1 · m2: apply m2 first. */
export function multiplyAffine(m1, m2) {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    tx: m1.a * m2.tx + m1.c * m2.ty + m1.tx,
    ty: m1.b * m2.tx + m1.d * m2.ty + m1.ty,
  };
}

/** Shutter time over elapsed animation time; 0 when the clock did not move forward. */
export function shutterScale(shutterDeg, frameRate, dtAnim) {
  if (!(dtAnim > 0) || !(frameRate > 0)) return 0;
  return (Math.max(0, shutterDeg) / 360) / frameRate / dtAnim;
}

/** δ = k·(W·P⁻¹ − I), the displacement field over the shutter, in world space. */
export function blurDisplacement(prev, curr, k) {
  const inv = invertAffine(prev);
  if (!inv) return null;
  const A = multiplyAffine(curr, inv);
  return {
    a: k * (A.a - 1), b: k * A.b, c: k * A.c, d: k * (A.d - 1),
    tx: k * A.tx, ty: k * A.ty,
  };
}

/** Longest displacement over a set of world points. */
export function trailLength(disp, points) {
  let best = 0;
  for (const p of points) {
    const dx = disp.a * p.x + disp.c * p.y + disp.tx;
    const dy = disp.b * p.x + disp.d * p.y + disp.ty;
    best = Math.max(best, Math.hypot(dx, dy));
  }
  return best;
}

export function scaleAffine(m, s) {
  return { a: m.a * s, b: m.b * s, c: m.c * s, d: m.d * s, tx: m.tx * s, ty: m.ty * s };
}

/**
 * Re-express a world-space displacement field in filter UV space, where the
 * input texture maps as g = (u·width + minX, v·height + minY).
 */
export function displacementToUv(disp, width, height, minX, minY) {
  return {
    a: disp.a,
    b: disp.b * width / height,
    c: disp.c * height / width,
    d: disp.d,
    tx: (disp.a * minX + disp.c * minY + disp.tx) / width,
    ty: (disp.b * minX + disp.d * minY + disp.ty) / height,
  };
}

/**
 * On above `threshold`, off below half of it: a single cut-off makes a
 * decelerating foot switch the filter on and off on alternate frames.
 */
export function nextBlurState(wasOn, length, threshold) {
  return wasOn ? length >= threshold * 0.5 : length > threshold;
}

const MAX_SAMPLES = 24;

const BLUR_VERTEX = `in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void)
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}
`;

const BLUR_FRAGMENT = `in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputClamp;
uniform mat3 uDisplace;
uniform float uSamples;

void main(void)
{
    vec2 d = (uDisplace * vec3(vTextureCoord, 1.0)).xy;
    vec4 sum = vec4(0.0);
    for (int i = 0; i < ${MAX_SAMPLES}; i++) {
        if (float(i) >= uSamples) break;
        float f = (float(i) + 0.5) / uSamples - 0.5;
        sum += texture(uTexture, clamp(vTextureCoord + f * d, uInputClamp.xy, uInputClamp.zw));
    }
    finalColor = sum / uSamples;
}
`;

function createBlurFilter(PIXI) {
  const filter = PIXI.Filter.from({
    gl: { vertex: BLUR_VERTEX, fragment: BLUR_FRAGMENT, name: "animo-motion-blur" },
    resources: {
      blurUniforms: {
        uDisplace: { value: new PIXI.Matrix(), type: "mat3x3<f32>" },
        uSamples: { value: 8, type: "f32" },
      },
    },
    resolution: "inherit",
  });
  filter.displacement = null;

  // The filter bounds are only known while rendering. `calculateSpriteMatrix`
  // with an identity "sprite" of unit size returns exactly the input-UV to
  // world map, using public API only.
  const unitSprite = {
    worldTransform: new PIXI.Matrix(),
    texture: { frame: { width: 1, height: 1 } },
    anchor: { x: 0, y: 0 },
  };
  const uvToWorld = new PIXI.Matrix();
  filter.apply = function apply(filterManager, input, output, clearMode) {
    const disp = this.displacement;
    const uniforms = this.resources.blurUniforms.uniforms;
    if (disp) {
      filterManager.calculateSpriteMatrix(uvToWorld, unitSprite);
      const uv = displacementToUv(disp, uvToWorld.a, uvToWorld.d, uvToWorld.tx, uvToWorld.ty);
      uniforms.uDisplace.set(uv.a, uv.b, uv.c, uv.d, uv.tx, uv.ty);
    } else {
      uniforms.uDisplace.set(0, 0, 0, 0, 0, 0);
    }
    filterManager.applyFilter(this, input, output, clearMode);
  };
  return filter;
}

function toAffine(m) {
  return { a: m.a, b: m.b, c: m.c, d: m.d, tx: m.tx, ty: m.ty };
}

registerExtension("ANIMO_motion_blur", (display, data, PIXI) => {
  if (!PIXI.Filter || !PIXI.Matrix) return {};
  const shutter = Number(data.shutter) || 0;
  const maxLength = Number(data.maxLength) > 0 ? Number(data.maxLength) : Infinity;
  const threshold = Number(data.threshold) >= 0 ? Number(data.threshold) : 0.5;
  const slotScale = data.slots || {};

  /** display object -> { prev, texture, filter, on, disp } */
  const sprites = new Map();
  /** armature -> { state, time, k } */
  const clocks = new Map();
  const scratch = new PIXI.Matrix();

  const clockOf = (arm) => {
    let c = clocks.get(arm);
    if (!c) { c = { state: null, time: 0, k: 0 }; clocks.set(arm, c); }
    const state = arm.animation.lastAnimationState;
    const time = state ? state.currentTime : 0;
    const frameRate = (arm.armatureData && arm.armatureData.frameRate) || 24;
    if (!state || state !== c.state) {
      c.k = 0;
    } else if (time < c.time) {
      // Loop wrap or seek backwards: keep the last scale for this one update.
    } else {
      c.k = shutterScale(shutter, frameRate, time - c.time);
    }
    c.state = state;
    c.time = time;
    return c;
  };

  const detach = (entry, sprite) => {
    if (entry.filter && sprite.filters) {
      const rest = sprite.filters.filter((f) => f !== entry.filter);
      sprite.filters = rest.length ? rest : null;
    }
    entry.on = false;
  };

  const attach = (entry, sprite) => {
    if (!entry.filter) entry.filter = createBlurFilter(PIXI);
    const current = sprite.filters ? [...sprite.filters] : [];
    if (!current.includes(entry.filter)) sprite.filters = [...current, entry.filter];
    entry.on = true;
  };

  const update = () => {
    const root = display.armature;
    if (!root) return;
    const rootWorld = display.getGlobalTransform(scratch);
    const armatureScale = Math.sqrt(Math.abs(rootWorld.a * rootWorld.d - rootWorld.b * rootWorld.c)) || 1;

    // A mask display clips others and must stay sharp.
    const masks = new Set();
    const visits = [];
    const walk = (arm, gain, seen) => {
      if (!arm || seen.has(arm)) return;
      seen.add(arm);
      const clock = clockOf(arm);
      const perSlot = slotScale[arm.name] || {};
      for (const slot of arm.getSlots()) {
        const g = gain * (perSlot[slot.name] ?? 1);
        if (slot.childArmature) { walk(slot.childArmature, g, seen); continue; }
        const sprite = slot.display;
        if (!sprite) continue;
        if (sprite.mask) masks.add(sprite.mask);
        visits.push({ sprite, gain: g, k: clock.k });
      }
    };
    walk(root, 1, new Set());

    const alive = new Set();
    for (const { sprite, gain, k } of visits) {
      if (!(sprite instanceof PIXI.Sprite)) continue;
      alive.add(sprite);
      let entry = sprites.get(sprite);
      if (!entry) {
        entry = { prev: null, texture: null, filter: null, on: false };
        sprites.set(sprite, entry);
      }
      const world = toAffine(sprite.getGlobalTransform(scratch));
      const prev = entry.prev;
      const textureChanged = entry.texture !== sprite.texture;
      entry.prev = world;
      entry.texture = sprite.texture;

      const scale = k * gain;
      const disp = !prev || textureChanged || masks.has(sprite) || !sprite.visible || scale <= 0
        ? null
        : blurDisplacement(prev, world, scale);
      if (!disp) { detach(entry, sprite); continue; }

      const b = sprite.bounds;
      const corners = [
        { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY },
        { x: b.minX, y: b.maxY }, { x: b.maxX, y: b.maxY },
      ].map((p) => ({
        x: world.a * p.x + world.c * p.y + world.tx,
        y: world.b * p.x + world.d * p.y + world.ty,
      }));
      let length = trailLength(disp, corners) / armatureScale;
      let field = disp;
      if (length > maxLength) {
        field = scaleAffine(disp, maxLength / length);
        length = maxLength;
      }

      if (!nextBlurState(entry.on, length, threshold)) { detach(entry, sprite); continue; }
      attach(entry, sprite);
      const worldLength = length * armatureScale;
      entry.filter.displacement = field;
      entry.filter.padding = Math.ceil(worldLength / 2) + 2;
      entry.filter.resources.blurUniforms.uniforms.uSamples =
        Math.max(4, Math.min(MAX_SAMPLES, Math.ceil(worldLength)));
    }

    for (const [sprite, entry] of sprites) {
      if (alive.has(sprite)) continue;
      detach(entry, sprite);
      if (entry.filter) entry.filter.destroy();
      sprites.delete(sprite);
    }
  };

  return {
    update,
    destroy() {
      for (const [sprite, entry] of sprites) {
        detach(entry, sprite);
        if (entry.filter) entry.filter.destroy();
      }
      sprites.clear();
      clocks.clear();
    },
  };
});
