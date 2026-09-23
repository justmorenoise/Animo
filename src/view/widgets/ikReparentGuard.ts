import type { Store } from "@/app/Store";
import type { NodeId } from "@/core/doc/ids";
import { ikDrivenAmong } from "@/core/doc/ikGraph";
import { alertDialog } from "./dialogs";

/**
 * Whether re-parenting `ids` may go ahead. A bone the IK solves is refused,
 * with a dialog that says why and offers to stop refusing; Preferences ▸
 * General ▸ Bones and IK turns the refusal back on.
 */
export function mayReparent(store: Store, ids: readonly NodeId[]): boolean {
  if (!store.prefs.value.general.guardIkReparent) return true;
  const sym = store.currentSymbol;
  const driven = ikDrivenAmong(sym, ids);
  if (driven.length === 0) return true;

  const names = driven.map((id) => `"${sym.nodes[id]?.name ?? id}"`).join(", ");
  void alertDialog({
    title: "Re-parent refused", width: 440,
    message: `${names} ${driven.length === 1 ? "is" : "are"} solved by IK. Re-parenting keeps a bone ` +
      "where it looks, so the IK bend would become its rest pose, and the exported IK " +
      "would bend it again on top of that.",
    dontAskAgain: {
      label: "Don't refuse this again (Preferences ▸ General ▸ Bones and IK turns it back on)",
      remember: () => store.prefs.set("general", { guardIkReparent: false }),
    },
  });
  return false;
}
