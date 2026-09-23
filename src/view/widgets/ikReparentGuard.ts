import type { Store } from "@/app/Store";
import type { NodeId } from "@/core/doc/ids";
import { ikDrivenAmong } from "@/core/doc/ikGraph";
import { Modal } from "./Modal";
import { h, on } from "./dom";

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
  const modal = new Modal({ title: "Re-parent refused", width: 440, height: 230 });
  const box = h("input", { type: "checkbox" }) as HTMLInputElement;
  modal.body.appendChild(h("div", { class: "modal-form" },
    h("p", null,
      `${names} ${driven.length === 1 ? "is" : "are"} solved by IK. Re-parenting keeps a bone ` +
      "where it looks, so the IK bend would become its rest pose, and the exported IK " +
      "would bend it again on top of that."),
    h("label", { class: "modal-check" }, box,
      "Don't refuse this again (Preferences ▸ General ▸ Bones and IK turns it back on)")));
  modal.footer.appendChild(h("div", { class: "spacer" }));
  const ok = h("button", { class: "btn primary" }, "OK");
  on(ok, "pointerup", () => {
    if (box.checked) store.prefs.set("general", { guardIkReparent: false });
    modal.close();
  });
  modal.footer.appendChild(ok);
  return false;
}
