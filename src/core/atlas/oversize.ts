import { EXPORT_LIMITS, type ExportSettings, pageLimit } from "@/core/export/settings";

/**
 * Images too big for an atlas page, and what to tell the user about them.
 *
 * The packer used to find this out on its own and throw with its internal
 * region key ("s2t|8885x2871|0,0,8885,2871") and a size that included the
 * edge extrusion. The atlas builder now checks every region first
 * (`regionFits`) and throws `AtlasTooSmall` with the images by name; the
 * advice is worked out here, from the settings, so the numbers it suggests
 * are ones that fit.
 */

export interface Oversized {
  name: string;
  /** The image's own size, as imported. */
  width: number;
  height: number;
}

/** Whether a region fits a page: one padding before it and one after. */
export function regionFits(
  w: number, h: number, page: { maxWidth: number; maxHeight: number; padding: number },
): boolean {
  return w + 2 * page.padding <= page.maxWidth && h + 2 * page.padding <= page.maxHeight;
}

export class AtlasTooSmall extends Error {
  constructor(readonly offenders: Oversized[], readonly page: { w: number; h: number }) {
    super(`${offenders.length === 1 ? `"${offenders[0]!.name}" is` : `${offenders.length} images are`} ` +
      `larger than an atlas page (${page.w} × ${page.h} px).`);
    this.name = "AtlasTooSmall";
  }
}

export interface OversizeAdvice {
  title: string;
  message: string;
  /** The largest texture scale at which everything fits, or null below 5%. */
  fitScale: number | null;
  /** A page size that holds everything at the current scale, or null past 8192. */
  fitPage: { w: number; h: number } | null;
}

export function oversizeAdvice(offenders: readonly Oversized[], s: ExportSettings): OversizeAdvice {
  const limit = pageLimit(s);
  const margin = 2 * s.padding + 2 * s.extrude;

  let scale = Infinity;
  for (const o of offenders) {
    scale = Math.min(scale, (limit.w - margin) / o.width, (limit.h - margin) / o.height);
  }
  // Whole percent, rounded down so the suggestion really fits.
  const pct = Math.floor(Math.min(scale, s.scale) * 100) / 100;
  const fitScale = pct >= EXPORT_LIMITS.scale.min ? pct : null;

  let w = limit.w, h = limit.h;
  for (const o of offenders) {
    w = Math.max(w, Math.ceil(o.width * s.scale) + margin);
    h = Math.max(h, Math.ceil(o.height * s.scale) + margin);
  }
  if (s.powerOfTwo) { w = ceilPow2(w); h = ceilPow2(h); }
  if (s.square) w = h = Math.max(w, h);
  const max = EXPORT_LIMITS.maxWidth.max;
  const fitPage = w <= max && h <= max ? { w, h } : null;

  const one = offenders.length === 1;
  const fixes: string[] = [];
  if (fitScale !== null) {
    fixes.push(`• set Texture scale to ${Math.round(fitScale * 100)}% or less in File ▸ Export Settings;`);
  }
  if (fitPage) fixes.push(`• raise the maximum page size there to ${fitPage.w} × ${fitPage.h} px;`);
  fixes.push(`• make the image${one ? "" : "s"} smaller in an image editor, then use Replace Image in the Library.`);

  const size = (o: Oversized) => s.scale < 1
    ? `${o.width} × ${o.height} px (${Math.ceil(o.width * s.scale)} × ${Math.ceil(o.height * s.scale)} ` +
      `at the ${Math.round(s.scale * 100)}% texture scale)`
    : `${o.width} × ${o.height} px`;
  const shown = offenders.slice(0, 5)
    .map((o) => `• ${o.name}, ${size(o)}`);
  if (offenders.length > 5) shown.push(`• and ${offenders.length - 5} more`);
  const message = [
    one
      ? `"${offenders[0]!.name}" is ${size(offenders[0]!)}. That is larger than an atlas page, ` +
        `which Export Settings limits to ${limit.w} × ${limit.h} px.`
      : `These images are larger than an atlas page, which Export Settings limits to ` +
        `${limit.w} × ${limit.h} px:\n${shown.join("\n")}`,
    "Every image has to fit on a page, so the preview and the export cannot be built.",
    `To fix it:\n${fixes.join("\n")}`,
  ].join("\n\n");

  return { title: one ? "Image too large for the atlas" : "Images too large for the atlas", message, fitScale, fitPage };
}

function ceilPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
