import { h, on } from "@/view/widgets/dom";
import { formatColor, parseColor, type Rgba } from "@/core/prefs/color";

/**
 * The colour widget of the Preferences dialog.
 *
 * Half the stage palette is translucent by design — the grid is white at 5%,
 * a bone is yellow at 90% — so a plain `<input type="color">` would flatten
 * exactly the values that matter most. Hence the separate opacity box, and
 * the parser in `core/prefs/color.ts` that reads both notations.
 */

function toHex(c: Rgba): string { return formatColor({ ...c, a: 1 }); }

/** A swatch plus an opacity box, writing back the notation it was given. */
export class ColorField {
  readonly el: HTMLElement;
  private value: Rgba;

  constructor(initial: string, private readonly onChange: (css: string) => void) {
    this.value = parseColor(initial);

    const swatch = h("input", { type: "color", class: "swatch", value: toHex(this.value) });
    const alpha = h("input", {
      type: "number", class: "alpha", min: "0", max: "100", step: "1",
      value: String(Math.round(this.value.a * 100)),
      title: "Opacity %",
    });

    on(swatch, "input", () => {
      const next = parseColor(swatch.value);
      this.value = { ...next, a: this.value.a };
      this.emit();
    });
    on(alpha, "input", () => {
      const pct = Number(alpha.value);
      if (!Number.isFinite(pct)) return;
      this.value = { ...this.value, a: Math.max(0, Math.min(100, pct)) / 100 };
      this.emit();
    });
    on(alpha, "keydown", (ev) => ev.stopPropagation());

    this.el = h("div", { class: "colorfield" }, swatch, alpha, h("span", { class: "glyph" }, "%"));
  }

  private emit(): void { this.onChange(formatColor(this.value)); }
}
