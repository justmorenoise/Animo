import { Modal } from "@/view/widgets/Modal";
import { h, on } from "@/view/widgets/dom";
import { icon } from "@/view/icons";
import { EXT_MASKS, EXTENSION_DOCS, extensionSnippet, RUNTIME_FILE, } from "@/core/export/extensions";

/**
 * "What is this badge telling me?"
 *
 * The Preview panel marks the extensions a rig needs, and until now said so
 * only in a tooltip ending in "see README.md", a file that exists in the
 * exported zip and nowhere a user of the app can read it. This is that
 * README's content, in the app, per extension: what the feature is, why a
 * stock DragonBones player ignores it, and the code that wires it into a
 * game.
 */
export function openExtensionHelp(name: string): void {
  const doc = EXTENSION_DOCS[name];
  const modal = new Modal({
    title: doc ? `${doc.title} (runtime extension)` : name,
    width: 620, height: 560,
  });

  const body = h("div", { class: "exthelp" });
  modal.body.appendChild(body);

  if (!doc) {
    body.appendChild(h("p", null, `No description for "${name}".`));
    return;
  }

  body.appendChild(h("div", { class: "exthelp-head" },
    icon(name === EXT_MASKS ? "mask" : "motionBlur", 14),
    h("span", { class: "exthelp-id" }, name),
    h("span", { class: `exthelp-tag ${doc.required ? "req" : "opt"}` },
      doc.required ? "Required for playback" : "Optional for playback"),
  ));

  for (const para of doc.what) body.appendChild(h("p", null, para));

  body.appendChild(h("h4", null, "Without the extension"));
  body.appendChild(h("p", null, doc.without));

  body.appendChild(h("h4", null, "What the export contains"));
  body.appendChild(h("p", null,
    "The skeleton and the atlas are standard DragonBones 5.5 files and load in any " +
    "DragonBones runtime. The export adds two files: <name>_ext.json, which " +
    `describes this feature, and ${RUNTIME_FILE}, a small ES module with no ` +
    "dependencies that applies it in PixiJS 8. Both are in the zip and in Export " +
    "to Folder.",
  ));

  body.appendChild(h("h4", null, "Using it in a game"));
  const snippet = extensionSnippet();
  body.appendChild(h("pre", { class: "exthelp-code" }, snippet));
  body.appendChild(h("p", { class: "exthelp-note" },
    "Pass as ticker the one that advances DragonBones (PIXI.Ticker.shared by " +
    "default). If your game advances DragonBones itself " +
    "(PixiFactory.useSharedTicker = false), leave ticker out and call " +
    "extensions.update(dt) right after PixiFactory.advanceTime(dt). " +
    "extensions.missing lists the extensions in the file that this runtime does not know.",
  ));

  const copy = h("button", { class: "btn" }, "Copy code");
  on(copy, "pointerup", () => {
    void navigator.clipboard?.writeText(snippet).then(
      () => { copy.textContent = "Copied"; },
      () => { copy.textContent = "Copy failed"; },
    );
  });
  modal.footer.appendChild(copy);
  modal.footer.appendChild(h("div", { class: "spacer" }));
  const close = h("button", { class: "btn primary" }, "Close");
  on(close, "pointerup", () => modal.close());
  modal.footer.appendChild(close);
}

/** The Help ▸ Runtime Extensions rows, one per documented extension. */
export function extensionHelpEntries(): Array<{ label: string; run(): void }> {
  return Object.entries(EXTENSION_DOCS).map(([name, doc]) => ({
    label: `${doc.title}…`,
    run: () => openExtensionHelp(name),
  }));
}
