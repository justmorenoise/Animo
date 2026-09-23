/**
 * How the view layer asks "which key runs this command?" without holding the
 * keymap. `App` installs the resolver; menus, tooltips and the tool rail read
 * through it and re-read on `onAccelChange`, so a rebinding shows everywhere at
 * once.
 */

let resolver: (id: string) => string | undefined = () => undefined;
const listeners = new Set<() => void>();

export function setAccelResolver(fn: (id: string) => string | undefined): void {
  resolver = fn;
  notifyAccelChange();
}

export function accelOf(id: string | undefined): string | undefined {
  return id ? resolver(id) : undefined;
}

/** `Play (⌘P)`, or just `Play` when the command has no key. */
export function withAccel(text: string, id: string): string {
  const a = resolver(id);
  return a ? `${text} (${a})` : text;
}

export function onAccelChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifyAccelChange(): void {
  for (const fn of listeners) fn();
}
