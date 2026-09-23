/**
 * The artwork for the stickman test rig, drawn without a canvas.
 *
 * Node has no 2D context and the editor's own rasteriser is DOM-bound, so the
 * parts are rendered here into an RGBA buffer from signed distance fields and
 * encoded as PNG with `node:zlib`. Analytic coverage (`0.5 - d`) gives the
 * same one-pixel antialiased edge a canvas would, which matters: the atlas
 * packer trims on alpha, so a hard-edged part would pack differently from the
 * art an artist would actually import.
 *
 * Every part is drawn along +x with its joint at the PIVOT, because an image
 * node hangs off its bone with an identity transform — so image +x is the
 * bone's own axis and the art follows the bone with no correction anywhere.
 */
import { deflateSync } from "node:zlib";

export interface Part {
  name: string;
  png: Uint8Array;
  width: number;
  height: number;
  /** The joint, in image pixels: what `Node.pivot` gets. */
  pivot: { x: number; y: number };
  /** How long the bone carrying this part is. */
  boneLength: number;
}

/* ── Palette ──────────────────────────────────────────────────────────────*/

const BODY = "#3d5a80";
const BODY_EDGE = "#22334d";
const LIMB = "#41618a";
const SKIN = "#e8b48a";
const SKIN_EDGE = "#a8734b";
const SHOE = "#2b3a4f";

/* ── Raster ───────────────────────────────────────────────────────────────*/

type Sdf = (x: number, y: number) => number;

class Raster {
  readonly data: Uint8ClampedArray;

  constructor(readonly w: number, readonly h: number) {
    this.data = new Uint8ClampedArray(w * h * 4);
  }

  /**
   * Source-over composite of `color` wherever `sdf` is inside, with the edge
   * antialiased over one pixel.
   */
  fill(sdf: Sdf, color: string): void {
    const [r, g, b] = parseHex(color);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const cov = clamp01(0.5 - sdf(x + 0.5, y + 0.5));
        if (cov <= 0) continue;
        const i = (y * this.w + x) * 4;
        const da = this.data[i + 3]! / 255;
        const a = cov + da * (1 - cov);
        if (a <= 0) continue;
        for (let c = 0; c < 3; c++) {
          const src = [r, g, b][c]!;
          const dst = this.data[i + c]!;
          this.data[i + c] = (src * cov + dst * da * (1 - cov)) / a;
        }
        this.data[i + 3] = a * 255;
      }
    }
  }

  /** Solid shape with a darker rim, which is how every part here is drawn. */
  fillOutlined(shape: (r: number) => Sdf, radius: number, fill: string, edge: string): void {
    this.fill(shape(radius), edge);
    this.fill(shape(Math.max(0.5, radius - 2.2)), fill);
  }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

function parseHex(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Distance to a segment, minus a radius that lerps from `r0` to `r1`. */
function capsule(
  ax: number, ay: number, bx: number, by: number, r0: number, r1 = r0,
): Sdf {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  return (x, y) => {
    const t = lenSq > 0
      ? clamp01(((x - ax) * dx + (y - ay) * dy) / lenSq)
      : 0;
    const px = ax + dx * t, py = ay + dy * t;
    return Math.hypot(x - px, y - py) - (r0 + (r1 - r0) * t);
  };
}

function circle(cx: number, cy: number): (r: number) => Sdf {
  return (r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
}

/* ── PNG ──────────────────────────────────────────────────────────────────*/

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
  return out;
}

/** 8-bit RGBA, no interlacing, one filter-0 scanline per row. */
export function encodePng(raster: Raster): Uint8Array {
  const { w, h, data } = raster;
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(data.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { png.set(p, at); at += p.length; }
  return png;
}

/* ── The parts ────────────────────────────────────────────────────────────*/

function part(
  name: string, w: number, h: number, pivot: { x: number; y: number },
  boneLength: number, draw: (r: Raster) => void,
): Part {
  const raster = new Raster(w, h);
  draw(raster);
  return { name, png: encodePng(raster), width: w, height: h, pivot, boneLength };
}

/**
 * All seven images. Limb art is shared between the left and right sides — one
 * `ImageItem`, several instances — so the atlas carries each shape once.
 */
export function buildParts(): Part[] {
  return [
    // Hips -> waist. Wider at the pivot (the hips) than at the tip.
    part("pelvis", 97, 42, { x: 21, y: 21 }, 58, (r) => {
      r.fillOutlined((rad) => capsule(21, 21, 79, 21, rad, rad - 3), 19, BODY, BODY_EDGE);
    }),

    // Waist -> neck, flaring into the shoulders.
    part("torso", 98, 46, { x: 23, y: 23 }, 52, (r) => {
      r.fillOutlined((rad) => capsule(23, 23, 75, 23, rad - 4, rad), 21, BODY, BODY_EDGE);
    }),

    // Neck stub plus the head, whose centre sits 30px along the bone.
    part("head", 61, 58, { x: 2, y: 29 }, 46, (r) => {
      r.fillOutlined((rad) => capsule(2, 29, 16, 29, rad), 10, BODY, BODY_EDGE);
      r.fillOutlined(circle(32, 29), 27, SKIN, SKIN_EDGE);
    }),

    part("upper_arm", 78, 22, { x: 11, y: 11 }, 56, (r) => {
      r.fillOutlined((rad) => capsule(11, 11, 67, 11, rad), 9, LIMB, BODY_EDGE);
    }),

    // Forearm with the hand on the end, so the wrist needs no bone of its own.
    part("forearm", 78, 26, { x: 13, y: 13 }, 52, (r) => {
      r.fillOutlined((rad) => capsule(13, 13, 65, 13, rad), 8, LIMB, BODY_EDGE);
      r.fillOutlined(circle(66, 13), 11, SKIN, SKIN_EDGE);
    }),

    part("thigh", 100, 28, { x: 14, y: 14 }, 72, (r) => {
      r.fillOutlined((rad) => capsule(14, 14, 86, 14, rad, rad - 2), 12, LIMB, BODY_EDGE);
    }),

    // The foot points along image -y, which is the direction the character
    // faces once the shin bone is pointing down: image +x is the bone.
    part("shin", 89, 44, { x: 11, y: 30 }, 68, (r) => {
      r.fillOutlined((rad) => capsule(11, 30, 79, 30, rad, rad - 1), 9, LIMB, BODY_EDGE);
      r.fillOutlined((rad) => capsule(79, 31, 77, 11, rad, rad - 2), 8, SHOE, BODY_EDGE);
    }),
  ];
}
