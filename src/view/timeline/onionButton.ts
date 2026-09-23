import { on } from "@/view/widgets/dom";

const HOLD_MS = 400;

/**
 * Animate's onion button: a click toggles, pressing and holding — or a
 * right-click — opens the options. A hold that opened the menu must not also
 * toggle on release, so the click that follows it is swallowed in the
 * capture phase, ahead of the button's own handler.
 */
export function attachOptionsMenu(btn: HTMLElement, openMenu: () => void): void {
  let timer = 0;
  let held = false;
  const open = () => { held = true; openMenu(); };
  const cancel = () => { window.clearTimeout(timer); timer = 0; };

  on(btn, "pointerdown", (ev) => {
    if ((ev as PointerEvent).button !== 0) return;
    held = false;
    cancel();
    timer = window.setTimeout(open, HOLD_MS);
  });
  on(btn, "pointerup", cancel);
  on(btn, "pointerleave", cancel);
  on(btn, "pointercancel", cancel);
  btn.addEventListener("click", (e) => {
    if (!held) return;
    held = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
  on(btn, "contextmenu", (e) => {
    e.preventDefault();
    cancel();
    openMenu();
  });
}
