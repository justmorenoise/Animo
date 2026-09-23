/**
 * MaxRects bin packing, Best-Short-Side-Fit heuristic.
 *
 * Chosen over shelf/skyline because character art has a very heterogeneous
 * size distribution — dozens of tiny hands and eyes alongside a few large
 * torsos — which is exactly where MaxRects wins. We own it rather than take
 * a dependency because the packing must be DETERMINISTIC: non-deterministic
 * output would make exporter golden tests useless.
 */

export interface PackInput {
  id: string;
  width: number;
  height: number;
}

export interface PackedRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotated: boolean;
}

export interface PackOptions {
  maxWidth: number;
  maxHeight: number;
  /** Gap between rects, and around the page edge. */
  padding: number;
  allowRotation: boolean;
  powerOfTwo: boolean;
  square: boolean;
}

export interface PackPage {
  width: number;
  height: number;
  rects: PackedRect[];
}

export const DEFAULT_PACK: PackOptions = {
  maxWidth: 2048,
  maxHeight: 2048,
  padding: 2,
  // Off by default: rotation buys ~5% occupancy and costs a whole bug class,
  // because tools disagree on what width/height mean for a rotated region.
  allowRotation: false,
  powerOfTwo: false,
  square: false,
};

interface FreeRect { x: number; y: number; width: number; height: number; }

export function packRects(inputs: PackInput[], opts: PackOptions): PackPage[] {
  // A TOTAL order — size, then area, then id — so ties never resolve
  // differently between runs.
  const sorted = [...inputs].sort((a, b) => {
    const am = Math.max(a.width, a.height), bm = Math.max(b.width, b.height);
    if (am !== bm) return bm - am;
    const aa = a.width * a.height, ba = b.width * b.height;
    if (aa !== ba) return ba - aa;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const pages: PackPage[] = [];
  let remaining = sorted;

  while (remaining.length > 0) {
    const { bin, leftover } = packOnePage(remaining, opts);

    if (bin.rects.length === 0) {
      const worst = leftover[0]!;
      throw new Error(
        `"${worst.id}" is ${worst.width}×${worst.height}px and does not fit a ` +
        `${opts.maxWidth}×${opts.maxHeight} atlas page even on its own. ` +
        `Raise the page size or scale the image down.`,
      );
    }

    pages.push(bin.finish());
    remaining = leftover;
  }

  return pages;
}

/**
 * Pack as much as possible onto one page.
 *
 * Packing straight into a full-size page and cropping afterwards gives legal
 * but ugly results — MaxRects happily lays everything out in a single column
 * across a 2048px canvas, and the crop leaves a tall thin strip. Instead,
 * start from a page barely larger than the total area and grow only when
 * something does not fit. The first size that holds everything is compact by
 * construction.
 */
function packOnePage(
  items: PackInput[], opts: PackOptions,
): { bin: MaxRectsBin; leftover: PackInput[] } {
  const pad = opts.padding;
  const area = items.reduce((n, i) => n + (i.width + pad) * (i.height + pad), 0);
  const widest = items.reduce((n, i) => Math.max(n, i.width + pad * 2), 1);
  const tallest = items.reduce((n, i) => Math.max(n, i.height + pad * 2), 1);

  // ~5% slack for packing waste, and never smaller than the biggest item.
  let side = Math.max(Math.ceil(Math.sqrt(area * 1.05)) + pad * 2, widest, tallest);

  let best: { bin: MaxRectsBin; leftover: PackInput[] } | null = null;

  while (true) {
    const width = Math.min(side, opts.maxWidth);
    const height = Math.min(side, opts.maxHeight);
    const bin = new MaxRectsBin(
      { ...opts, maxWidth: width, maxHeight: height },
      { w: opts.maxWidth, h: opts.maxHeight },
    );
    const leftover: PackInput[] = [];
    for (const item of items) {
      if (!bin.insert(item)) leftover.push(item);
    }

    if (leftover.length === 0) return { bin, leftover };
    // Keep the best attempt in case we hit the page-size ceiling.
    if (!best || bin.rects.length > best.bin.rects.length) best = { bin, leftover };
    if (width >= opts.maxWidth && height >= opts.maxHeight) return best;

    side = Math.ceil(side * 1.25);
  }
}

class MaxRectsBin {
  readonly rects: PackedRect[] = [];
  private free: FreeRect[];
  private used = { w: 0, h: 0 };

  /**
   * `opts.maxWidth/maxHeight` are the TRIAL page size for this attempt;
   * `hardMax` is the real ceiling. Rounding up to a power of two must be
   * clamped against the ceiling, never against the trial size.
   */
  constructor(
    private readonly opts: PackOptions,
    private readonly hardMax = { w: opts.maxWidth, h: opts.maxHeight },
  ) {
    // Every item claims its size plus ONE padding (after it), so the free
    // area starts after the leading padding and runs to the page edge.
    // Subtracting the padding at both ends as well refused an image that
    // fits with its padding on each side.
    const p = opts.padding;
    this.free = [{
      x: p, y: p,
      width: opts.maxWidth - p,
      height: opts.maxHeight - p,
    }];
  }

  insert(item: PackInput): boolean {
    const pad = this.opts.padding;
    const spot = this.findBest(item.width + pad, item.height + pad);
    if (!spot) return false;

    this.rects.push({
      id: item.id,
      x: spot.x, y: spot.y,
      width: item.width, height: item.height,
      rotated: spot.rotated,
    });

    const occupied: FreeRect = {
      x: spot.x, y: spot.y,
      width: (spot.rotated ? item.height : item.width) + pad,
      height: (spot.rotated ? item.width : item.height) + pad,
    };
    this.split(occupied);
    this.prune();

    this.used.w = Math.max(this.used.w, spot.x + occupied.width);
    this.used.h = Math.max(this.used.h, spot.y + occupied.height);
    return true;
  }

  /** Best Short Side Fit: minimise the smaller leftover edge. */
  private findBest(w: number, h: number): { x: number; y: number; rotated: boolean } | null {
    let best: { x: number; y: number; rotated: boolean } | null = null;
    let bestShort = Infinity;
    let bestLong = Infinity;

    const consider = (f: FreeRect, fw: number, fh: number, rotated: boolean) => {
      if (f.width < fw || f.height < fh) return;
      const leftH = f.width - fw;
      const leftV = f.height - fh;
      const shortSide = Math.min(leftH, leftV);
      const longSide = Math.max(leftH, leftV);
      if (shortSide < bestShort || (shortSide === bestShort && longSide < bestLong)) {
        best = { x: f.x, y: f.y, rotated };
        bestShort = shortSide;
        bestLong = longSide;
      }
    };

    for (const f of this.free) {
      consider(f, w, h, false);
      if (this.opts.allowRotation) consider(f, h, w, true);
    }
    return best;
  }

  /** Carve `used` out of every overlapping free rect. */
  private split(used: FreeRect): void {
    const next: FreeRect[] = [];
    for (const f of this.free) {
      if (!overlaps(f, used)) { next.push(f); continue; }

      if (used.y > f.y && used.y < f.y + f.height) {
        next.push({ x: f.x, y: f.y, width: f.width, height: used.y - f.y });
      }
      const usedBottom = used.y + used.height;
      if (usedBottom < f.y + f.height && usedBottom > f.y) {
        next.push({ x: f.x, y: usedBottom, width: f.width, height: f.y + f.height - usedBottom });
      }
      if (used.x > f.x && used.x < f.x + f.width) {
        next.push({ x: f.x, y: f.y, width: used.x - f.x, height: f.height });
      }
      const usedRight = used.x + used.width;
      if (usedRight < f.x + f.width && usedRight > f.x) {
        next.push({ x: usedRight, y: f.y, width: f.x + f.width - usedRight, height: f.height });
      }
    }
    this.free = next;
  }

  /** Drop free rects fully contained in another — the "max" in MaxRects. */
  private prune(): void {
    for (let i = 0; i < this.free.length; i++) {
      for (let j = i + 1; j < this.free.length; j++) {
        if (contains(this.free[j]!, this.free[i]!)) { this.free.splice(i, 1); i--; break; }
        if (contains(this.free[i]!, this.free[j]!)) { this.free.splice(j, 1); j--; }
      }
    }
  }

  finish(): PackPage {
    const pad = this.opts.padding;
    let w = this.used.w + pad;
    let h = this.used.h + pad;
    if (this.opts.powerOfTwo) { w = nextPow2(w); h = nextPow2(h); }
    if (this.opts.square) { w = h = Math.max(w, h); }
    return {
      width: Math.min(w, this.hardMax.w),
      height: Math.min(h, this.hardMax.h),
      rects: this.rects,
    };
  }
}

function overlaps(a: FreeRect, b: FreeRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width
      && a.y < b.y + b.height && b.y < a.y + a.height;
}

function contains(outer: FreeRect, inner: FreeRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
      && inner.x + inner.width <= outer.x + outer.width
      && inner.y + inner.height <= outer.y + outer.height;
}

function nextPow2(v: number): number {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}
