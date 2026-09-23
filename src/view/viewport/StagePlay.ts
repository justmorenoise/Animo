import { clear, cls, h, on } from "@/view/widgets/dom";
import { onAccelChange, withAccel } from "@/view/widgets/accel";
import { icon } from "@/view/icons";
import type { Store } from "@/app/Store";
import { PreviewHost } from "@/preview/previewHost";
import type { PreviewOptions, PreviewSession, PreviewView } from "@/preview/PreviewSession";

/**
 * Play mode: the stage shows the DragonBones runtime instead of the editable
 * scene, the way Unity swaps the Scene view for the Game view.
 *
 * The runtime owns the clock here. The editor's own `Playback` steps
 * `ui.frame` and would only re-drive the runtime frame by frame, which shows
 * the editor's timing rather than the runtime's — and the runtime's timing is
 * the entire reason for running the real thing. So the editor clock is
 * stopped on entry and the playhead FOLLOWS the `tick` messages coming back.
 *
 * The iframe is its own, not the Preview panel's: the dock re-appends a
 * panel's element on every focus and every tab drag, and moving an iframe
 * reloads it. The export behind both is shared, through `PreviewSession`.
 */
export class StagePlay implements PreviewView {
  readonly host = new PreviewHost();
  readonly controls: HTMLElement;

  private playing = false;
  /** True while a `tick` is being applied, so the frame it emits does not
   *  come straight back to the runtime as a `seek`. */
  private following = false;
  private playBtn: HTMLButtonElement;
  private pauseBtn: HTMLButtonElement;
  private loopBtn: HTMLButtonElement;
  private animSelect: HTMLSelectElement;
  private scopeBtn: HTMLButtonElement;
  private cluster: HTMLElement;
  /** Entered, and the runtime has not shown anything yet. */
  private revealPending = false;

  constructor(
    private readonly store: Store,
    private readonly session: PreviewSession,
    private readonly stageHost: HTMLElement,
    /** Stop the editor's own clock; the runtime is the one that runs. */
    private readonly stopEditorPlayback: () => void,
  ) {
    this.host.iframe.style.cssText =
      "border:0;position:absolute;inset:0;width:100%;height:100%;display:block;background:#353535";

    this.playBtn = h("button", { class: "seg play" }) as HTMLButtonElement;
    onAccelChange(() => this.sync());
    this.pauseBtn = h("button", { class: "iconbtn", title: "Pause" }) as HTMLButtonElement;
    this.loopBtn = h("button", { class: "iconbtn", title: "Loop" }) as HTMLButtonElement;
    this.animSelect = h("select", { class: "zoomsel", title: "Animation" }) as HTMLSelectElement;
    // Scene or symbol. Two different questions get asked of the runtime —
    // "is the rig right?" of the whole scene, "does the animation I am
    // authoring in here run?" of the symbol being edited — and only the
    // second one wants the playhead handed over.
    this.scopeBtn = h("button", { class: "seg scope" }) as HTMLButtonElement;

    this.playBtn.appendChild(icon("play", 12));
    this.pauseBtn.appendChild(icon("pause", 12));
    this.loopBtn.appendChild(icon("loop", 12));

    this.cluster = h("div", { class: "playsw" },
      this.playBtn, this.pauseBtn, this.loopBtn, this.scopeBtn, this.animSelect);
    this.controls = this.cluster;

    on(this.playBtn, "click", () => this.toggle());
    on(this.pauseBtn, "click", () => this.setPlaying(!this.playing));
    on(this.loopBtn, "click", () => {
      const loop = !this.store.ui.loop;
      this.store.setUi({ loop }, "playback");
      this.host.post({ type: "setLoop", on: loop });
      this.sync();
    });
    on(this.scopeBtn, "click", () => {
      const scope = this.store.ui.previewScope === "scene" ? "symbol" : "scene";
      this.store.setUi({ previewScope: scope }, "playback");
      this.sync();
      // A different armature: rebuild rather than wait for the coalescer.
      if (this.active()) void this.session.refresh(true);
    });
    on(this.animSelect, "change", () => {
      this.host.post({ type: "setAnimation", name: this.animSelect.value });
      this.playing = true;                    // setAnimation always starts it
      this.sync();
    });

    this.host.onMessage((msg) => {
      if ((msg.type === "loaded" || msg.type === "error") && this.revealPending) this.reveal();
      // Every build starts the animation looping; a `setLoop` sent before it
      // reached an armature that no longer exists.
      if (msg.type === "loaded" && this.active()) this.host.post({ type: "setLoop", on: this.store.ui.loop });
      if (msg.type !== "tick" || !this.active()) return;
      // The playhead follows the runtime, so the timeline stays a readout of
      // what is actually on screen.
      if (this.session.followsPlayhead(this)) {
        this.following = true;
        this.store.setFrame(msg.frame);
        this.following = false;
      }
      if (msg.playing !== this.playing) { this.playing = msg.playing; this.sync(); }
    });

    this.session.register(this);
    this.session.onAnimations((names) => this.fillAnimations(names));
    this.store.subscribe((t) => { if (t === "playback" || t === "doc") this.sync(); });
    this.sync();
  }

  // ── PreviewView ──────────────────────────────────────────────────────────

  active(): boolean { return this.store.ui.playMode; }
  options(): PreviewOptions {
    // `following` makes the session treat a tick-driven frame as playback, so
    // it does not seek the runtime back to where it already is.
    return {
      debugDraw: false, showStage: true, play: this.playing || this.following,
      scope: this.store.ui.previewScope,
    };
  }
  onStatus(): void { /* the stage bar is the status; errors go to the toast */ }

  // ── Mode ─────────────────────────────────────────────────────────────────

  toggle(): void { this.setMode(!this.store.ui.playMode); }

  setMode(on: boolean): void {
    if (on === this.store.ui.playMode) return;
    this.store.setUi({ playMode: on }, "playback");

    if (on) {
      this.stopEditorPlayback();
      // Invisible until the runtime has something to show. Hiding the stage
      // at once left the empty frame on screen while the page, Pixi and the
      // export loaded: a flash of grey before every Play.
      this.host.iframe.style.opacity = "0";
      this.host.iframe.style.pointerEvents = "none";
      this.revealPending = true;
      this.stageHost.appendChild(this.host.iframe);
      this.playing = true;
      // Immediately, not on the session's 250 ms coalescing timer: pressing
      // Play and watching nothing happen for a quarter second reads as broken.
      this.session.present(this);
    } else {
      this.host.detach();
      this.revealPending = false;
      cls(this.stageHost, "playing", false);
      this.playing = false;
    }
    this.sync();
    this.store.emit("stage");
  }

  /** The runtime has built the armature; swap the stage for it once it has
   *  also been drawn (the frame paints on its own next animation frame). */
  private reveal(): void {
    this.revealPending = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!this.store.ui.playMode) return;
      this.host.iframe.style.opacity = "";
      this.host.iframe.style.pointerEvents = "";
      cls(this.stageHost, "playing", true);
    }));
  }

  private setPlaying(playing: boolean): void {
    if (!this.active()) return;
    this.playing = playing;
    // `play` restarts at 0; `resume` is what a pause button implies.
    this.host.post(playing ? { type: "resume" } : { type: "pause" });
    this.sync();
  }

  private fillAnimations(names: string[]): void {
    const current = this.animSelect.value;
    clear(this.animSelect);
    for (const name of names) {
      this.animSelect.appendChild(h("option", { value: name }, name));
    }
    if (names.includes(current)) this.animSelect.value = current;
    this.animSelect.disabled = names.length <= 1;
  }

  private sync(): void {
    const on = this.store.ui.playMode;
    cls(this.cluster, "on", on);
    cls(this.playBtn, "on", on);
    this.playBtn.title = withAccel(on ? "Stop" : "Play", "modify.playMode");
    // Rebuilt only when the state actually changes: replacing an element
    // between pointerdown and pointerup loses the click entirely.
    const wantStop = on;
    if (this.playIconState !== wantStop) {
      this.playIconState = wantStop;
      clear(this.playBtn);
      this.playBtn.appendChild(icon(wantStop ? "close" : "play", 12));
    }
    if (this.pauseIconState !== this.playing) {
      this.pauseIconState = this.playing;
      clear(this.pauseBtn);
      this.pauseBtn.appendChild(icon(this.playing ? "pause" : "play", 12));
    }
    this.pauseBtn.style.display = on ? "" : "none";
    this.loopBtn.style.display = on ? "" : "none";
    this.animSelect.style.display = on ? "" : "none";
    this.scopeBtn.style.display = on ? "" : "none";
    cls(this.loopBtn, "on", this.store.ui.loop);

    const scene = this.store.ui.previewScope === "scene";
    const label = scene ? "Scene" : "Symbol";
    if (this.scopeBtn.textContent !== label) this.scopeBtn.textContent = label;
    this.scopeBtn.title = scene
      ? "Playing the whole scene. Click to play only the symbol you are editing."
      : `Playing only “${this.store.currentSymbol.name}”. Click to play the whole scene.`;
  }

  private playIconState: boolean | null = null;
  private pauseIconState: boolean | null = null;
}
