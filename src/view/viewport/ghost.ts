/**
 * One onion-skin frame, coloured and faded, composited onto the stage.
 *
 * Canvas2D can fade a draw (`globalAlpha`) but cannot colour one, so a ghost
 * is drawn into a scratch canvas the size of the stage first and treated
 * there: `source-atop` lays the past/future colour over what was drawn, and
 * the outline mode keeps only a one-pixel ring around the silhouette (the
 * silhouette stamped at eight one-pixel offsets, minus itself). The result is
 * then drawn onto the stage in one `drawImage`, at the ghost's opacity — so
 * overlapping parts of one frame do not darken each other, which a faded
 * draw straight onto the stage would do.
 */
export interface GhostStyle {
  alpha: number;
  /** Colour laid over the frame; null keeps its own colours. */
  tint: string | null;
  outline: boolean;
}

/** How strongly the tint covers the artwork; the rest keeps its shading. */
const TINT_STRENGTH = 0.75;
/** Outline colour when the ghosts are not colour-coded. */
const OUTLINE_NEUTRAL = "#6b6b6b";

export class GhostPainter {
  private art = document.createElement("canvas");
  private ring = document.createElement("canvas");

  /**
   * `draw` paints the frame into the context it is given, in the same device
   * space as `target` (the renderer sets its own transform). `dpr` sizes the
   * outline to one CSS pixel.
   */
  paint(
    target: CanvasRenderingContext2D, dpr: number, style: GhostStyle,
    draw: (ctx: CanvasRenderingContext2D) => void,
  ): void {
    const w = target.canvas.width, h = target.canvas.height;
    const art = this.prepare(this.art, w, h);
    draw(art);
    art.setTransform(1, 0, 0, 1, 0, 0);

    let source: HTMLCanvasElement = this.art;
    if (style.outline) {
      const ring = this.prepare(this.ring, w, h);
      const d = Math.max(1, Math.round(dpr));
      for (const [ox, oy] of [[-d, 0], [d, 0], [0, -d], [0, d], [-d, -d], [d, -d], [-d, d], [d, d]] as const) {
        ring.drawImage(this.art, ox, oy);
      }
      ring.globalCompositeOperation = "destination-out";
      ring.drawImage(this.art, 0, 0);
      ring.globalCompositeOperation = "source-atop";
      ring.fillStyle = style.tint ?? OUTLINE_NEUTRAL;
      ring.fillRect(0, 0, w, h);
      ring.globalCompositeOperation = "source-over";
      source = this.ring;
    } else if (style.tint) {
      art.globalCompositeOperation = "source-atop";
      art.globalAlpha = TINT_STRENGTH;
      art.fillStyle = style.tint;
      art.fillRect(0, 0, w, h);
      art.globalAlpha = 1;
      art.globalCompositeOperation = "source-over";
    }

    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = style.alpha;
    target.drawImage(source, 0, 0);
    target.restore();
  }

  private prepare(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }
}
