import type { Resample } from "@/core/export/settings";

/**
 * Resize RGBA pixels, for an atlas exported below full resolution.
 *
 * Done here rather than with a canvas: `imageSmoothingQuality` differs from
 * browser to browser, and an export has to come out the same wherever it is
 * made. Pure, so it is tested in Node.
 *
 * Separable (rows, then columns) and on PREMULTIPLIED colour: averaging a
 * transparent pixel's colour into an opaque neighbour darkens every
 * anti-aliased edge otherwise. When shrinking, the kernel widens by the
 * shrink factor so every source pixel contributes (an area filter); Lanczos'
 * negative lobes can overshoot, which the final clamp absorbs.
 */
export function resampleRgba(
  src: Uint8ClampedArray | Uint8Array, sw: number, sh: number, dw: number, dh: number, filter: Resample,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(dw * dh * 4);
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return out;

  if (filter === "nearest") {
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
        const s = (sy * sw + sx) * 4, d = (y * dw + x) * 4;
        out[d] = src[s]!; out[d + 1] = src[s + 1]!; out[d + 2] = src[s + 2]!; out[d + 3] = src[s + 3]!;
      }
    }
    return out;
  }

  // Premultiplied floats.
  const pre = new Float32Array(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) {
    const a = src[i * 4 + 3]! / 255;
    pre[i * 4] = src[i * 4]! * a;
    pre[i * 4 + 1] = src[i * 4 + 1]! * a;
    pre[i * 4 + 2] = src[i * 4 + 2]! * a;
    pre[i * 4 + 3] = src[i * 4 + 3]!;
  }

  const kernel = filter === "lanczos" ? lanczos3 : triangle;
  const support = filter === "lanczos" ? 3 : 1;

  // Rows: sw -> dw.
  const wx = weights(sw, dw, kernel, support);
  const mid = new Float32Array(dw * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      const { first, w } = wx[x]!;
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < w.length; k++) {
        const s = (y * sw + clampIndex(first + k, sw)) * 4, f = w[k]!;
        r += pre[s]! * f; g += pre[s + 1]! * f; b += pre[s + 2]! * f; a += pre[s + 3]! * f;
      }
      const d = (y * dw + x) * 4;
      mid[d] = r; mid[d + 1] = g; mid[d + 2] = b; mid[d + 3] = a;
    }
  }

  // Columns: sh -> dh, then back to straight alpha.
  const wy = weights(sh, dh, kernel, support);
  for (let y = 0; y < dh; y++) {
    const { first, w } = wy[y]!;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < w.length; k++) {
        const s = (clampIndex(first + k, sh) * dw + x) * 4, f = w[k]!;
        r += mid[s]! * f; g += mid[s + 1]! * f; b += mid[s + 2]! * f; a += mid[s + 3]! * f;
      }
      const d = (y * dw + x) * 4;
      const alpha = Math.max(0, Math.min(255, a));
      if (alpha < 0.5) continue;                       // stays transparent black
      const k = 255 / alpha;
      out[d] = Math.round(Math.max(0, Math.min(255, r * k)));
      out[d + 1] = Math.round(Math.max(0, Math.min(255, g * k)));
      out[d + 2] = Math.round(Math.max(0, Math.min(255, b * k)));
      out[d + 3] = Math.round(alpha);
    }
  }
  return out;
}

/** The size an image of `w`×`h` becomes at `scale`: never below one pixel. */
export function scaledSize(w: number, h: number, scale: number): { w: number; h: number } {
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

function clampIndex(i: number, n: number): number {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

/** Per destination pixel: the first source index and the normalised weights. */
function weights(
  srcSize: number, dstSize: number, kernel: (x: number) => number, support: number,
): { first: number; w: Float32Array }[] {
  const ratio = srcSize / dstSize;
  const stretch = Math.max(1, ratio);             // widen the kernel when shrinking
  const reach = support * stretch;
  const out: { first: number; w: Float32Array }[] = [];
  for (let i = 0; i < dstSize; i++) {
    const centre = (i + 0.5) * ratio - 0.5;
    const first = Math.ceil(centre - reach);
    const last = Math.floor(centre + reach);
    const w = new Float32Array(last - first + 1);
    let sum = 0;
    for (let j = first; j <= last; j++) {
      const v = kernel((j - centre) / stretch);
      w[j - first] = v;
      sum += v;
    }
    if (sum !== 0) for (let k = 0; k < w.length; k++) w[k]! /= sum;
    out.push({ first, w });
  }
  return out;
}

function triangle(x: number): number {
  const a = Math.abs(x);
  return a < 1 ? 1 - a : 0;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const p = Math.PI * x;
  return Math.sin(p) / p;
}

function lanczos3(x: number): number {
  return Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0;
}
