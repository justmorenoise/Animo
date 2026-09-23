import { clear, cls, h, on } from "@/view/widgets/dom";
import { icon } from "@/view/icons";
import type { Panel } from "@/view/widgets/Dock";
import { PreviewHost } from "@/preview/previewHost";
import type { PreviewSession, PreviewView } from "@/preview/PreviewSession";
import type { ExtensionManifest } from "@/runtime/animo-pixi";
import { EXT_MASKS, EXTENSION_DOCS } from "@/core/export/extensions";
import { openExtensionHelp } from "@/view/help/ExtensionHelp";

/**
 * Runs the project through the ACTUAL DragonBones runtime.
 *
 * The panel exports the project in memory and feeds the runtime the exact
 * bytes that would go to disk, so this is not a second opinion about how the
 * animation looks — it is the answer. If the stage and this disagree, the
 * export is wrong, and that is worth finding out while authoring rather than
 * after shipping.
 *
 * The export itself belongs to `PreviewSession`, which the stage's Play mode
 * shares: this panel is one VIEW of that runtime, with its own iframe and its
 * own toggles.
 */
export class PreviewPanel implements Panel, PreviewView {
  readonly id = "preview";
  readonly title = "Preview";
  readonly icon = "preview" as const;
  readonly el: HTMLElement;
  readonly footer: HTMLElement;

  readonly host = new PreviewHost();
  private frameWrap: HTMLElement;
  private status: HTMLElement;
  private animSelect: HTMLSelectElement;
  private playBtn: HTMLButtonElement;
  private debugBtn: HTMLButtonElement;
  private debugDraw = false;
  private playing = false;
  private mounted = false;
  private floatBtn: HTMLButtonElement;
  private showStage = true;
  /**
   * "This rig needs the extension runtime." Masks and motion blur are not
   * part of the DragonBones format; a stock player would ignore them, and
   * nothing else in the UI would say so.
   */
  private extras: HTMLElement;

  constructor(
    private readonly session: PreviewSession,
    /** Tear the panel out into a window of its own, or put it back. */
    private readonly onToggleFloat: () => void = () => {},
  ) {
    this.frameWrap = h("div", { class: "preview-frame" }, this.host.iframe);
    this.status = h("div", { class: "preview-status" });
    this.animSelect = h("select", { class: "preview-anim", title: "Animation" });
    this.playBtn = h("button", { class: "iconbtn", title: "Play / pause" }) as HTMLButtonElement;
    this.debugBtn = h("button", { class: "iconbtn", title: "Show bones" }) as HTMLButtonElement;
    this.floatBtn = h("button", {
      class: "iconbtn", title: "Float this panel",
    }) as HTMLButtonElement;

    this.extras = h("div", { class: "preview-extras", style: "display:none" });
    this.el = h("div", { class: "preview" }, this.frameWrap, this.extras, this.status);
    this.footer = this.buildFooter();

    this.host.onMessage((msg) => {
      if (msg.type === "loaded") {
        this.setStatus("");
        clear(this.animSelect);
        for (const name of msg.animations) {
          this.animSelect.appendChild(h("option", { value: name }, name));
        }
        this.animSelect.disabled = msg.animations.length <= 1;
      } else if (msg.type === "error") {
        this.setStatus(msg.message, true);
      }
    });

    this.session.register(this);
  }

  // ── PreviewView ────────────────────────────────────────────────────────

  /** On screen: a tab in the background or a closed panel is detached by the
   *  dock, and rebuilding the export for it cost every edit an atlas pack. */
  active(): boolean { return this.mounted && this.el.isConnected; }
  options(): { debugDraw: boolean; showStage: boolean; play: boolean } {
    return { debugDraw: this.debugDraw, showStage: this.showStage, play: this.playing };
  }
  onStatus(text: string, isError = false): void { this.setStatus(text, isError); }
  onExtras(extensions: ExtensionManifest | null): void { this.showExtras(extensions); }

  onShow(): void {
    this.mounted = true;
    this.session.show(this);
  }

  private buildFooter(): HTMLElement {
    clear(this.playBtn);
    this.playBtn.appendChild(icon("play", 13));
    on(this.playBtn, "click", () => {
      this.playing = !this.playing;
      clear(this.playBtn);
      this.playBtn.appendChild(icon(this.playing ? "pause" : "play", 13));
      this.host.post(this.playing ? { type: "play" } : { type: "pause" });
    });

    this.debugBtn.appendChild(icon("bone", 13));
    on(this.debugBtn, "click", () => {
      this.debugDraw = !this.debugDraw;
      cls(this.debugBtn, "on", this.debugDraw);
      this.host.post({ type: "setDebug", on: this.debugDraw });
    });

    on(this.animSelect, "change", () => {
      this.host.post({ type: "setAnimation", name: this.animSelect.value });
    });

    const stageBtn = h("button", { class: "iconbtn", title: "Show scene bounds" });
    stageBtn.appendChild(icon("scene", 13));
    cls(stageBtn, "on", this.showStage);
    on(stageBtn, "click", () => {
      this.showStage = !this.showStage;
      cls(stageBtn, "on", this.showStage);
      this.host.post({ type: "showStage", on: this.showStage });
    });

    this.floatBtn.appendChild(icon("float", 13));
    on(this.floatBtn, "click", () => this.onToggleFloat());

    const refresh = h("button", { class: "iconbtn", title: "Refresh the preview" });
    refresh.appendChild(icon("loop", 13));
    on(refresh, "click", () => { this.session.invalidate(); void this.session.refresh(true); });

    return h("div", { class: "pfooter" },
      this.playBtn, this.debugBtn, stageBtn,
      h("div", { class: "sep-v" }),
      this.animSelect,
      h("div", { class: "spacer" }),
      this.floatBtn, refresh,
    );
  }

  /**
   * One badge per extension the export carries: things the DragonBones
   * format cannot express, which a game gets only by installing the shipped
   * runtime. This preview installs it exactly as a game must.
   */
  private showExtras(manifest: ExtensionManifest | null): void {
    clear(this.extras);
    const used = manifest?.extensionsUsed ?? [];
    if (used.length === 0) {
      this.extras.style.display = "none";
      return;
    }
    for (const name of used) {
      const doc = EXTENSION_DOCS[name];
      const required = manifest!.extensionsRequired.includes(name);
      const count = name === EXT_MASKS
        ? ` Masks in use: ${manifest!.extensions.ANIMO_masks?.masks.length ?? 0}.`
        : "";
      const pill = h("span", {
        class: "preview-extra",
        role: "button",
        tabindex: "0",
        title:
          `${doc?.title ?? name}: ${required ? "required" : "optional"} for playback.${count} ` +
          `${doc?.without ?? ""} Click for details.`,
      }, icon(name === EXT_MASKS ? "mask" : "motionBlur", 11), h("span", null, name));
      // pointerup, not click: the badge is rebuilt on every export, and a
      // rebuild between down and up eats the click (see CLAUDE.md).
      on(pill, "pointerup", () => openExtensionHelp(name));
      on(pill, "keydown", (ev) => {
        const e = ev as unknown as KeyboardEvent;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openExtensionHelp(name); }
      });
      this.extras.appendChild(pill);
    }
    this.extras.style.display = "";
  }

  private setStatus(text: string, isError = false): void {
    this.status.textContent = text;
    this.status.style.display = text ? "block" : "none";
    cls(this.status, "error", isError);
  }
}
