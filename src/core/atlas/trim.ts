export interface TrimResult {
  /** Trimmed region within the source image. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** True when the image had no transparent border to remove. */
  untrimmed: boolean;
}

/**
 * Tight alpha bounding box.
 *
 * Pure so it can be unit-tested in Node: it takes the raw RGBA bytes rather
 * than a canvas.
 */
export function alphaBounds(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  threshold = 0,
): TrimResult {
  let minX = width, minY = height, maxX = -1, maxY = -1;

  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if ((data[row + x * 4 + 3] ?? 0) > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Fully transparent: keep a 1x1 region so the packer has something real.
  if (maxX < 0) {
    return { x: 0, y: 0, width: 1, height: 1, untrimmed: false };
  }

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  return {
    x: minX, y: minY, width: w, height: h,
    untrimmed: minX === 0 && minY === 0 && w === width && h === height,
  };
}
