import type { BlendMode } from "@/core/doc/types";
import type { Layer as PsdLayer, Psd } from "ag-psd";

/**
 * Photoshop files, read with `ag-psd`.
 *
 * `psd.js` was the obvious candidate and is the wrong one here: it is
 * CoffeeScript with Node-only dependencies (`fs`, `pngjs`, `iconv-lite`, a
 * CoffeeScript compiler at runtime) and no `browser` entry, so a Vite build
 * would need polyfills for all of it. `ag-psd` is TypeScript, ships types,
 * depends only on `pako`, and reads layers straight into `ImageData`.
 * It is loaded on demand (in `workers/psd.worker.ts`, or by `readPsdFile`
 * when no worker can run), so a project that never touches a PSD never pays
 * for the parser. No DOM here: the same code runs in the worker.
 *
 * What comes out is a plain tree of blobs and boxes — no ag-psd types beyond
 * this file, and nothing for `core/` to know about.
 */

export interface PsdRawImage {
  kind: "image";
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  blob: Blob;
  visible: boolean;
  blendMode?: BlendMode;
}

export interface PsdRawGroup {
  kind: "group";
  name: string;
  visible: boolean;
  /** Bottom-to-top, as stored in the file. */
  children: PsdRaw[];
}

export type PsdRaw = PsdRawImage | PsdRawGroup;

export interface PsdDocument {
  name: string;
  width: number;
  height: number;
  children: PsdRaw[];
  /** Things the import could not carry across, worth telling the user about. */
  warnings: string[];
}

/** Photoshop blend modes we can represent; everything else imports as normal. */
const BLEND: Record<string, BlendMode> = {
  normal: "normal",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  difference: "difference",
  "linear dodge": "add",
  "hard light": "hardlight",
};

/** Encodes a layer's final pixels; the worker and the page each bring theirs. */
export type EncodePng = (data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number) => Promise<Blob>;

/**
 * The PSD as a tree of encoded layers. No DOM: `readPsd` comes from ag-psd
 * (whose canvas hooks the caller has set up) and `encode` does the PNG.
 */
export async function parsePsd(
  buffer: ArrayBuffer, readPsd: typeof import("ag-psd").readPsd, encode: EncodePng,
  /** 0..1: decoding the file is the first fifth, encoding the layers the rest. */
  onProgress: (fraction: number) => void = () => {},
): Promise<Omit<PsdDocument, "name">> {
  const psd: Psd = readPsd(buffer, {
    skipCompositeImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
    useImageData: true,
  });

  onProgress(0.2);
  const countLayers = (layers: PsdLayer[]): number =>
    layers.reduce((n, l) => n + (l.children ? countLayers(l.children) : 1), 0);
  const total = Math.max(1, countLayers(psd.children ?? []));
  let encoded = 0;

  const warnings: string[] = [];
  const seen = { clipping: false, feather: false, groupOpacity: false };

  const convert = async (layers: PsdLayer[], inheritedAlpha: number): Promise<PsdRaw[]> => {
    const out: PsdRaw[] = [];
    for (const layer of layers) {
      const name = (layer.name ?? "").trim();
      const alpha = inheritedAlpha * (layer.opacity ?? 1);

      if (layer.children) {
        if ((layer.opacity ?? 1) < 1) seen.groupOpacity = true;
        out.push({
          kind: "group",
          name,
          visible: !layer.hidden,
          children: await convert(layer.children, alpha),
        });
        continue;
      }

      onProgress(0.2 + (0.8 * encoded++) / total);
      const w = (layer.right ?? 0) - (layer.left ?? 0);
      const h = (layer.bottom ?? 0) - (layer.top ?? 0);
      if (!layer.imageData || w <= 0 || h <= 0) {
        // Adjustment layers and empty layers have no pixels of their own.
        warnings.push(`"${name || "unnamed layer"}" has no pixels and was skipped.`);
        continue;
      }
      if (layer.clipping) seen.clipping = true;
      if (layer.mask?.userMaskFeather || layer.mask?.vectorMaskFeather) seen.feather = true;
      if (layer.blendMode && !BLEND[layer.blendMode]) {
        warnings.push(`"${name}" uses blend mode "${layer.blendMode}", imported as normal.`);
      }

      out.push({
        kind: "image",
        name,
        x: layer.left ?? 0,
        y: layer.top ?? 0,
        width: w,
        height: h,
        blob: await encode(
          layerPixels(layer.imageData as ImageData, alpha, layer.left ?? 0, layer.top ?? 0, maskOf(layer)),
          w, h,
        ),
        visible: !layer.hidden,
        blendMode: layer.blendMode ? BLEND[layer.blendMode] : undefined,
      });
    }
    return out;
  };

  const children = await convert(psd.children ?? [], 1);

  if (seen.clipping) {
    warnings.push("Clipping masks are not supported: the clipped layers were imported without them.");
  }
  if (seen.feather) {
    warnings.push("Feathered masks were imported with a hard edge.");
  }
  if (seen.groupOpacity) {
    warnings.push(
      "Group opacity was applied to each layer in the group, so layers that overlap " +
      "inside it may look slightly different than in Photoshop.",
    );
  }

  return {
    width: psd.width,
    height: psd.height,
    children,
    warnings,
  };
}

export interface Mask {
  data: ImageData;
  /** Canvas-space top-left of the mask. */
  x: number;
  y: number;
  /** What the mask reads as outside its own rectangle: 0 hides, 255 shows. */
  outside: number;
  /** Photoshop's Density, as a 0..1 strength for the whole mask. */
  density: number;
}

/**
 * A layer's mask, resolved into canvas space.
 *
 * Applied rather than reported, because a masked layer imported unmasked is
 * not "slightly different" — it is the wrong shape, and shaping art with a
 * mask is ordinary practice rather than an edge case.
 */
function maskOf(layer: PsdLayer): Mask | undefined {
  const mask = layer.mask;
  if (!mask || mask.disabled || !mask.imageData) return undefined;
  // A VECTOR mask is already baked into the layer's pixels — measured on the
  // fixture, where the mask channel equals the layer's alpha to the value,
  // anti-aliased edges included. Applying it again squares those edges and
  // eats a pixel off every outline.
  if (mask.fromVectorData) return undefined;
  const relative = mask.positionRelativeToLayer ? 1 : 0;
  return {
    data: mask.imageData as ImageData,
    x: (mask.left ?? 0) + relative * (layer.left ?? 0),
    y: (mask.top ?? 0) + relative * (layer.top ?? 0),
    outside: mask.defaultColor ?? 0,
    density: mask.userMaskDensity ?? 1,
  };
}

/**
 * One layer's final pixels. Opacity is multiplied into alpha here because a
 * node has no colour transform of its own in the bind pose — only keyframes
 * do — so a 40% layer would otherwise import at full strength.
 */
function layerPixels(
  image: ImageData, alpha: number, layerX: number, layerY: number, mask?: Mask,
): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(image.data);
  if (alpha < 1 || mask) resolveAlpha(data, image.width, image.height, alpha, layerX, layerY, mask);
  return data;
}

/**
 * Fold layer opacity and the mask into the alpha channel, in place.
 *
 * Pure and exported so the arithmetic can be tested without a canvas — the
 * rest of this file cannot run outside a browser.
 */
export function resolveAlpha(
  data: Uint8ClampedArray, width: number, height: number,
  alpha: number, layerX: number, layerY: number, mask?: Mask,
): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4 + 3;
      let a = data[i]! * alpha;
      if (mask) a *= maskAt(mask, layerX + x, layerY + y) / 255;
      data[i] = Math.round(a);
    }
  }
}

/** The mask's value at a canvas pixel, 0 (hidden) to 255 (shown). */
function maskAt(mask: Mask, cx: number, cy: number): number {
  const mx = cx - mask.x;
  const my = cy - mask.y;
  const inside = mx >= 0 && my >= 0 && mx < mask.data.width && my < mask.data.height;
  // Masks are greyscale; ag-psd hands them over as RGBA, so any channel does.
  const value = inside ? mask.data.data[(my * mask.data.width + mx) * 4]! : mask.outside;
  // Density fades the mask itself out, rather than the pixels it hides.
  return mask.density >= 1 ? value : 255 - (255 - value) * mask.density;
}
