/**
 * Colour arithmetic for the preferences and the theme.
 *
 * Pure and DOM-free so it can be tested in Node, and in `core/` because both
 * ends need it: the Preferences dialog derives one colour from another, and
 * `view/prefs/theme.ts` turns a preference into the CSS tokens the stylesheets
 * read. It is also the ONE parser — `colorField.ts` and `overlayColors.ts`
 * used to carry their own, and the second of the two silently ignored every
 * `rgba()` input.
 */

export interface Rgba { r: number; g: number; b: number; a: number }

/**
 * Parse the two colour notations the defaults are written in: `#rgb` /
 * `#rrggbb` and `rgb()` / `rgba()`.
 *
 * Half the stage palette is translucent by design — the grid is white at 5%,
 * a bone is yellow at 90% — so a plain `<input type="color">` would flatten
 * exactly the values that matter most. Anything unparseable comes back opaque
 * black rather than throwing; the swatch is then simply wrong for one field
 * instead of the dialog failing to open.
 */
export function parseColor(input: string): Rgba {
  const s = input.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const v = hex[1]!.length === 3 ? hex[1]!.split("").map((c) => c + c).join("") : hex[1]!;
    const n = parseInt(v, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (fn) {
    const parts = fn[1]!.split(/[,/]/).map((p) => Number(p.trim()));
    const [r, g, b, a] = parts;
    if ([r, g, b].every((n) => Number.isFinite(n))) {
      return {
        r: clamp255(r!), g: clamp255(g!), b: clamp255(b!),
        a: Number.isFinite(a) ? Math.max(0, Math.min(1, a!)) : 1,
      };
    }
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

export function formatColor(c: Rgba): string {
  if (c.a >= 0.999) {
    const hx = (n: number) => n.toString(16).padStart(2, "0");
    return `#${hx(c.r)}${hx(c.g)}${hx(c.b)}`;
  }
  return `rgba(${c.r},${c.g},${c.b},${Math.round(c.a * 1000) / 1000})`;
}

/** The same colour at a different opacity, whatever notation it arrives in. */
export function withAlpha(color: string, alpha: number): string {
  return formatColor({ ...parseColor(color), a: Math.max(0, Math.min(1, alpha)) });
}

/** `"0, 188, 217"` — what `rgba(var(--accent-rgb), 0.35)` needs. */
export function rgbTriplet(color: string): string {
  const c = parseColor(color);
  return `${c.r}, ${c.g}, ${c.b}`;
}

/**
 * A lighter or darker version of a colour: mixed towards black for a negative
 * amount, towards white for a positive one, keeping the alpha. Mixing rather
 * than moving the HSL lightness is what a tint actually looks like — a fully
 * saturated accent lightened in HSL stays fully saturated and turns garish.
 *
 * `shade(accent, -0.38)` and `shade(accent, 0.18)` are the two derived
 * accents; on the default teal they land close to the hand-picked
 * `#006b86` and `#2ccde6`, which stay the defaults.
 */
export function shade(color: string, amount: number): string {
  const c = parseColor(color);
  const t = Math.max(-1, Math.min(1, amount));
  const target = t < 0 ? 0 : 255;
  const f = Math.abs(t);
  const mix = (v: number) => clamp255(v + (target - v) * f);
  return formatColor({ r: mix(c.r), g: mix(c.g), b: mix(c.b), a: c.a });
}

const INK_DARK = "#1c1c1c";
const INK_LIGHT = "#ffffff";

/**
 * Which of the two text colours reads on this background: whichever has the
 * higher WCAG contrast ratio. Text on the accent used to be `#1c1c1c`
 * hardcoded in seven rules, which a dark accent made unreadable.
 */
export function inkOn(background: string): string {
  const bg = relativeLuminance(parseColor(background));
  const dark = relativeLuminance(parseColor(INK_DARK));
  const light = relativeLuminance(parseColor(INK_LIGHT));
  return contrast(bg, dark) >= contrast(bg, light) ? INK_DARK : INK_LIGHT;
}

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function relativeLuminance(c: Rgba): number {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

function clamp255(n: number): number { return Math.max(0, Math.min(255, Math.round(n))); }
