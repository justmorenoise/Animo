import type { Project } from "./types";

/**
 * A guard for the rule every command relies on: the document's VALUES are
 * replaced, never modified. A value is a track with everything under it
 * (keys, transforms, colours, eases) and a node's `bind`, `pivot`, `color`
 * and `extraDisplays`. An undo step keeps the old object, and the frame
 * algebra shares objects between the old track and the new one, so a write
 * into one of them changes history behind every command holding it —
 * `SetPivot` shifted the keys of an earlier F5 that way, and nothing showed
 * until an undo.
 *
 * Frozen, that write throws where it happens. Entities stay writable:
 * commands change the project, symbols, nodes, layers, animations and IK
 * constraints by design.
 *
 * On in the tests (`tests/setup.ts`); in the app only in a dev build with
 * `localStorage["animo.freezeValues"] = "1"`, since a throw halfway through a
 * command leaves that edit half done.
 */
export const valueFreeze = { enabled: false };

export function freezeValues(project: Project): void {
  for (const item of Object.values(project.items)) {
    if (item.kind !== "symbol") continue;
    for (const node of Object.values(item.nodes)) {
      deepFreeze(node.bind);
      deepFreeze(node.pivot);
      if (node.color) deepFreeze(node.color);
      if (node.extraDisplays) deepFreeze(node.extraDisplays);
    }
    for (const anim of item.animations) {
      for (const track of Object.values(anim.tracks)) deepFreeze(track);
    }
  }
}

/** Stops at anything already frozen: a new track shares most of its keys
 *  with the old one, so each command only pays for what it created. */
function deepFreeze(o: object): void {
  if (Object.isFrozen(o)) return;
  Object.freeze(o);
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") deepFreeze(v);
  }
}
