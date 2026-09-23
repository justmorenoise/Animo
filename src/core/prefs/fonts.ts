/**
 * The UI text scale — Photoshop's four steps, under Interface ▸ Text.
 *
 * This sizes TEXT, not the whole interface: the measures that grow are the
 * font sizes and the heights of the rows built to hold them. Icons, the tool
 * rail and hairlines keep their pixel sizes, because scaling those means
 * redrawing every SVG. Unlike Photoshop the change is immediate — every
 * consumer already listens to `prefs`.
 *
 * Pure and DOM-free: `view/prefs/theme.ts` turns these numbers into CSS
 * tokens and the canvases build their `ctx.font` from them.
 */

export type UiFontSize = "tiny" | "small" | "medium" | "large";

export const UI_FONT_SIZES: readonly UiFontSize[] = ["tiny", "small", "medium", "large"];

/** `small` is exactly 1, so the default moves nothing by a single pixel. */
export const UI_FONT_SCALES: Record<UiFontSize, number> = {
  tiny: 0.85,
  small: 1,
  medium: 1.15,
  large: 1.3,
};

/** Rounded to the pixel — at 11px a fraction is visible — and never illegible. */
export function uiPx(base: number, size: UiFontSize): number {
  return Math.max(6, Math.round(base * UI_FONT_SCALES[size]));
}

/** The `ctx.font` string for a canvas that cannot inherit anything. */
export function uiFont(base: number, size: UiFontSize, weight?: number): string {
  const px = `${uiPx(base, size)}px -apple-system, 'Helvetica Neue', sans-serif`;
  return weight ? `${weight} ${px}` : px;
}
