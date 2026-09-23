import type { Store } from "@/app/Store";

/**
 * Real-time playback of the current animation.
 *
 * Time is accumulated in seconds and converted to frames rather than adding
 * one frame per animation frame: at 24fps on a 120Hz display the naive
 * version plays five times too fast, and on a busy frame it stutters.
 */
export class Playback {
  private raf = 0;
  private lastTime = 0;
  private accumulator = 0;
  private loopsDone = 0;

  constructor(
    private readonly store: Store,
    private readonly onFrame: (frame: number) => void,
  ) {}

  get playing(): boolean { return this.store.ui.playing; }

  toggle(): void { this.playing ? this.pause() : this.play(); }

  play(): void {
    if (this.playing) return;
    const anim = this.store.currentAnimation;
    if (!anim) return;
    // Restarting from the end is what a play button should do.
    if (this.store.ui.frame >= this.store.maxFrame) this.store.setFrame(0);
    this.loopsDone = 0;
    this.accumulator = 0;
    this.lastTime = performance.now();
    this.store.setUi({ playing: true }, "playback");
    this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (!this.playing) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.store.setUi({ playing: false }, "playback");
  }

  stop(): void {
    this.pause();
    this.store.setFrame(0);
  }

  /**
   * Step the playhead. Stepping forward stops at the end of the animation:
   * the playhead may be PARKED past it (that is how the empty frames are
   * given content) but an arrow key held down should not wander off into
   * them. A playhead already out there keeps its position rather than being
   * yanked back.
   */
  stepBy(delta: number): void {
    this.pause();
    const frame = this.store.ui.frame;
    const limit = Math.max(this.store.maxFrame, frame);
    this.store.setFrame(Math.min(frame + delta, limit));
  }

  toStart(): void { this.pause(); this.store.setFrame(0); }
  toEnd(): void { this.pause(); this.store.setFrame(this.store.maxFrame); }

  private tick = (now: number): void => {
    if (!this.playing) return;
    const anim = this.store.currentAnimation;
    if (!anim) { this.pause(); return; }

    // Scheduled before any listener runs. A throw further down — a panel
    // failing mid-update — used to end the rAF chain while `ui.playing`
    // stayed true: the playhead froze and the transport still showed Pause.
    // `pause()` cancels this very request, so stopping below still works.
    this.raf = requestAnimationFrame(this.tick);

    const dt = Math.min(0.25, (now - this.lastTime) / 1000);   // clamp after a stall
    this.lastTime = now;
    this.accumulator += dt * this.store.project.frameRate;

    if (this.accumulator >= 1) {
      const advance = Math.floor(this.accumulator);
      this.accumulator -= advance;
      let frame = this.store.ui.frame + advance;
      const last = this.store.maxFrame;

      if (frame > last) {
        const loop = this.store.ui.loop && anim.playTimes === 0;
        this.loopsDone++;
        if (loop || (anim.playTimes > 0 && this.loopsDone < anim.playTimes)) {
          frame = last > 0 ? frame % (last + 1) : 0;
        } else {
          frame = last;
          this.store.setFrame(frame);
          this.onFrame(frame);
          this.pause();
          return;
        }
      }
      this.store.setFrame(frame);
      this.onFrame(frame);
    }
  };

  dispose(): void { cancelAnimationFrame(this.raf); }
}
