import { mat, matOf, type Matrix2D, mul } from "@/core/math/Matrix2D";
import type { Animation, SymbolItem } from "@/core/doc/types";
import { type BlendMode, type ColorTransform, isImage, isSymbol, type Project } from "@/core/doc/types";
import {
    childFrame,
    displayContext,
    evaluateSymbol,
    type FrameContext,
    innerContext,
    type Pose,
    type PoseEntry,
    SETUP_CONTEXT,
} from "@/core/doc/pose";
import { maskGroups } from "@/core/doc/layerTree";
import type { AssetStore } from "@/app/AssetStore";

/**
 * Draws an evaluated pose with Canvas2D.
 *
 * `drawEntry` is deliberately the smallest possible unit — matrix, pivot,
 * image, colour in, pixels out — because the parity harness calls it
 * directly to compare against the DragonBones runtime.
 */
/**
 * Where a symbol instance's CONTENTS sit in the parent's space: its world
 * matrix, shifted by -pivot the way `drawEntry` shifts them. Edit-in-place
 * uses the same matrix, which is what makes descending into an instance leave
 * the artwork exactly where it was drawn.
 */
export function contentMatrixOf(
  world: Matrix2D, pivot: { x: number; y: number },
): Matrix2D {
  return mul(mat(), world, matOf(1, 0, 0, 1, -pivot.x, -pivot.y));
}

export class SceneRenderer {
  constructor(
    private readonly project: () => Project,
    private readonly assets: AssetStore,
  ) {}

  /**
   * Tinted copies, per decoded bitmap and then per colour transform. Keyed by
   * the bitmap object, not by `AssetId`: ids restart with every new or opened
   * project, and the library's renderer — thumbnails, Export as .png — is
   * never told the project changed, so an id key served the previous
   * project's pixels.
   */
  private tintCache = new WeakMap<object, Map<string, HTMLCanvasElement>>();

  clearCaches(): void { this.tintCache = new WeakMap(); }

  /**
   * `view` maps WORLD to DEVICE pixels — it must already fold in the device
   * pixel ratio and the ruler gutter, because drawEntry uses
   * `ctx.setTransform`, which replaces the context transform outright rather
   * than composing with it.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    symbol: SymbolItem,
    animation: Animation | null,
    frame: number,
    mode: "setup" | "animate",
    view: Matrix2D,
    opts: { alpha?: number; hiddenLayers?: Set<string> } = {},
  ): Pose {
    const pose = evaluateSymbol(symbol, animation, frame, mode);
    const when: FrameContext = { animationName: animation?.name ?? null, frame, mode };

    ctx.save();
    if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
    this.drawEntries(ctx, symbol, pose.entries, view, 0, when, opts.hiddenLayers);
    ctx.restore();
    return pose;
  }

  /**
   * One symbol's entries in paint order, honouring its mask layers.
   *
   * Shared by the top level and by every nested instance, because a mask
   * inside a symbol is the ordinary case — an eye whose circular mask clips a
   * moving eyelid keeps working when the whole eye moves, and drawing the
   * inner entries flat would show the eyelid outside the eye.
   */
  private drawEntries(
    ctx: CanvasRenderingContext2D,
    symbol: SymbolItem,
    entries: PoseEntry[],
    base: Matrix2D,
    depth: number,
    when: FrameContext,
    hiddenLayers?: Set<string>,
  ): void {
    const world = mat();
    const groups = maskGroups(symbol);

    if (groups.size === 0) {
      for (const e of entries) {
        if (!e.visible || hiddenLayers?.has(e.nodeId)) continue;
        mul(world, base, e.world);
        this.drawEntry(ctx, e, world, depth, when);
      }
      return;
    }

    // Layer id -> node id, so a pose entry can be matched to a mask link.
    const nodeOfLayer = new Map<string, string>();
    for (const l of symbol.layers) nodeOfLayer.set(l.id, l.nodeId);
    const maskNodeOf = new Map<string, string>();   // masked node -> mask node
    const maskNodes = new Set<string>();
    for (const [maskLayerId, masked] of groups) {
      const maskNode = nodeOfLayer.get(maskLayerId);
      if (!maskNode) continue;
      maskNodes.add(maskNode);
      for (const l of masked) maskNodeOf.set(l.nodeId, maskNode);
    }

    const byNode = new Map(entries.map((e) => [e.nodeId as string, e]));
    const done = new Set<string>();

    for (const e of entries) {
      // A mask's own artwork is never drawn — it only clips, as in Flash.
      if (maskNodes.has(e.nodeId) || done.has(e.nodeId)) continue;

      const maskNode = maskNodeOf.get(e.nodeId);
      if (!maskNode) {
        if (!e.visible || hiddenLayers?.has(e.nodeId)) continue;
        mul(world, base, e.world);
        this.drawEntry(ctx, e, world, depth, when);
        continue;
      }

      // The whole group is contiguous in paint order, so it is gathered once
      // and drawn into a scratch layer that the mask then punches out of.
      const group = entries.filter((g) => maskNodeOf.get(g.nodeId) === maskNode);
      group.forEach((g) => done.add(g.nodeId));
      const maskEntry = byNode.get(maskNode);
      const visible = group.filter((g) => g.visible && !hiddenLayers?.has(g.nodeId));
      if (visible.length === 0) continue;

      // Hiding the mask layer reveals the group unmasked, which is both what
      // Flash does while authoring and, as it happens, what Pixi does when a
      // mask display has `visible = false`. `hiddenLayers` is not that: it
      // leaves a layer's ARTWORK out (a locked layer from the onion skin), and
      // a mask's artwork is never drawn anyway — it still clips.
      if (!maskEntry || !maskEntry.visible) {
        for (const g of visible) {
          mul(world, base, g.world);
          this.drawEntry(ctx, g, world, depth, when);
        }
        continue;
      }

      const scratch = this.scratchFor(depth, ctx.canvas.width, ctx.canvas.height);
      if (!scratch) continue;
      const sctx = scratch.getContext("2d")!;
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, scratch.width, scratch.height);

      for (const g of visible) {
        mul(world, base, g.world);
        this.drawEntry(sctx, g, world, depth, when);
      }

      // Keep only what the mask's own alpha covers.
      sctx.save();
      sctx.globalCompositeOperation = "destination-in";
      mul(world, base, maskEntry.world);
      this.drawEntry(sctx, maskEntry, world, depth, when);
      sctx.restore();

      // Composited under the caller's globalAlpha, so a group's alpha is
      // applied once to the flattened result rather than per layer.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(scratch, 0, 0);
      ctx.restore();
    }
  }

  /**
   * One scratch canvas per nesting depth, reused across frames.
   *
   * Masks compose through nested symbols, so depth 0's layer must survive
   * while depth 1 is being built — a single shared canvas would be cleared
   * out from under it.
   */
  private scratch: HTMLCanvasElement[] = [];

  private scratchFor(depth: number, w: number, h: number): HTMLCanvasElement | null {
    if (w === 0 || h === 0) return null;
    let c = this.scratch[depth];
    if (!c) { c = document.createElement("canvas"); this.scratch[depth] = c; }
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c;
  }

  /** One display, already composed to screen space. */
  drawEntry(
    ctx: CanvasRenderingContext2D, e: PoseEntry, screen: Matrix2D, depth: number,
    when: FrameContext = SETUP_CONTEXT,
  ): void {
    const display = e.display;
    if (!display) return;
    const item = this.project().items[display.itemId];

    if (isImage(item)) {
      const asset = this.assets.get(item.assetId);
      if (!asset) return;
      const source = this.sourceFor(asset.bitmap as CanvasImageSource, item.width, item.height, e.color);
      ctx.save();
      ctx.setTransform(screen.a, screen.b, screen.c, screen.d, screen.tx, screen.ty);
      ctx.globalAlpha *= Math.max(0, Math.min(1, e.color.aM / 100));
      // Blend applies to the FINAL draw, not to the tint bake in `sourceFor`.
      // Symbol instances deliberately get none: the runtime's
      // `_updateBlendMode` is guarded by `instanceof PIXI.Sprite`, so a child
      // armature's Container never receives one and the stage must not either.
      if (e.node.blendMode) ctx.globalCompositeOperation = COMPOSITE[e.node.blendMode];
      ctx.imageSmoothingQuality = "high";
      // The pivot is the transform origin, so the artwork is offset by -pivot.
      ctx.drawImage(source, -display.pivot.x, -display.pivot.y, item.width, item.height);
      ctx.restore();
      return;
    }

    if (isSymbol(item) && depth < 10) {
      // A nested symbol instance draws its own contents under this transform,
      // at ITS OWN frame: a child armature has its own looping timeline, and
      // the runtime plays it whatever the parent is doing.
      const at = displayContext(when, e.displaySince);
      const here = childFrame(item, at);
      const inner = evaluateSymbol(item, here.animation, here.frame, when.mode);

      // The transform point sits on the bone origin, so the contents hang off
      // it by -pivot — the same offset an image display gets, expressed for a
      // child armature as the display's own transform on export.
      const base = mul(mat(), screen, matOf(1, 0, 0, 1, -display.pivot.x, -display.pivot.y));
      ctx.save();
      ctx.globalAlpha *= Math.max(0, Math.min(1, e.color.aM / 100));
      this.drawEntries(ctx, item, inner.entries, base, depth + 1, innerContext(item, at));
      ctx.restore();
    }
  }

  /**
   * Returns either the raw bitmap or a cached tinted copy. Canvas2D has no
   * multiply-tint primitive, so a non-default colour transform is baked into
   * an offscreen canvas once and reused.
   */
  /**
   * Note only the RGB channels are baked, never `aO`. Alpha is applied as
   * `globalAlpha` from `aM` alone, because `PixiSlot._updateColor` reads
   * `alphaMultiplier` into `display.alpha` and ignores every offset — baking
   * `aO` here would draw something the runtime cannot reproduce. The exporter
   * warns when a document carries offsets at all.
   */
  private sourceFor(
    bitmap: CanvasImageSource, w: number, h: number, color: ColorTransform,
  ): CanvasImageSource {
    const needsTint =
      color.rM !== 100 || color.gM !== 100 || color.bM !== 100 ||
      color.rO !== 0 || color.gO !== 0 || color.bO !== 0;
    if (!needsTint) return bitmap;

    const key = `${color.rM},${color.gM},${color.bM},${color.rO},${color.gO},${color.bO}`;
    let tints = this.tintCache.get(bitmap);
    if (!tints) { tints = new Map(); this.tintCache.set(bitmap, tints); }
    const hit = tints.get(key);
    if (hit) return hit;

    const c = document.createElement("canvas");
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    const cx = c.getContext("2d", { willReadFrequently: true });
    if (!cx) return bitmap;
    cx.drawImage(bitmap, 0, 0, w, h);
    const img = cx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      d[i]     = clamp255(d[i]!     * (color.rM / 100) + color.rO);
      d[i + 1] = clamp255(d[i + 1]! * (color.gM / 100) + color.gO);
      d[i + 2] = clamp255(d[i + 2]! * (color.bM / 100) + color.bO);
    }
    cx.putImageData(img, 0, 0);

    // Bound the cache; tints churn while a colour slider is being dragged.
    if (tints.size > 64) tints.clear();
    tints.set(key, c);
    return c;
  }
}

/** Our BlendMode -> Canvas2D, matching what `PixiSlot._updateBlendMode` applies. */
const COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  add: "lighter",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  difference: "difference",
  hardlight: "hard-light",
};

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
