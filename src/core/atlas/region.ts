/**
 * One image packed on an atlas page, in the terms every atlas format can be
 * brought to, and how to cut it back out. The format readers (DragonBones'
 * `_tex.json` here, the others in the desktop edition) only translate their
 * fields into an `AtlasRegion`; the corners, the trim and the turn are worked
 * out once, in `regionCut`.
 */

export interface AtlasRegion {
  /** The image's name, as the format gives it. */
  name: string;
  /** The page's file name, as the format gives it. */
  page: string;
  /** The rectangle on the page, as stored: a turned region is as high as the image is wide. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** How the image is turned on the page: 90 clockwise, -90 counter-clockwise. */
  rotation: 0 | 90 | -90;
  /** Where the trimmed image's top-left corner sits in the untrimmed one. */
  offsetX: number;
  offsetY: number;
  /** The untrimmed image. */
  width: number;
  height: number;
  /** The image's transform point, 0–1 of the untrimmed image, when the format has one. */
  pivot?: { x: number; y: number };
}

/** Where a region's pixels go in the image it was packed from. */
export interface Cut {
  /** The image: the untrimmed frame at full size. */
  width: number;
  height: number;
  /** The region on the page. */
  src: { x: number; y: number; w: number; h: number };
  /** `setTransform` for drawing the region at (0, 0, w, h). */
  m: [number, number, number, number, number, number];
}

/**
 * `scale`: the size the page stores its images at (0.5: half size), cut back
 * to full size.
 */
export function regionCut(r: AtlasRegion, scale = 1): Cut {
  const k = scale > 0 ? 1 / scale : 1;
  const ox = r.offsetX, oy = r.offsetY;
  // A point (u, v) of the stored region, back in the untrimmed image.
  // Turned clockwise, the image's top-left corner is the region's top-right.
  const m: Cut["m"] = r.rotation === 90 ? [0, -k, k, 0, ox * k, (r.w + oy) * k]
    : r.rotation === -90 ? [0, k, -k, 0, (r.h + ox) * k, oy * k]
      : [k, 0, 0, k, ox * k, oy * k];
  return {
    width: Math.max(1, Math.round(r.width * k)),
    height: Math.max(1, Math.round(r.height * k)),
    src: { x: r.x, y: r.y, w: r.w, h: r.h },
    m,
  };
}

/**
 * A region whose untrimmed size the format leaves out (0 or absent) is its
 * trimmed one, turned back.
 */
export function shownSize(r: Pick<AtlasRegion, "w" | "h" | "rotation">): { w: number; h: number } {
  return r.rotation ? { w: r.h, h: r.w } : { w: r.w, h: r.h };
}
