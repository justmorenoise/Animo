import type { FrameToHost, HostToFrame, PreviewTexture } from "./protocol";
import type { ExtensionManifest } from "@/runtime/animo-pixi";

/**
 * Parent-side driver for the preview iframe.
 *
 * Runtime failures surface here as an event instead of vanishing into the
 * frame's console, because "the preview is blank" with no explanation is the
 * least useful thing this panel could do.
 */
export class PreviewHost {
  readonly iframe: HTMLIFrameElement;
  private ready = false;
  private queue: HostToFrame[] = [];
  private listeners = new Set<(msg: FrameToHost) => void>();
  /** The last payload, replayed whenever the frame comes back. */
  private lastLoad: Extract<HostToFrame, { type: "load" }> | null = null;

  constructor() {
    this.iframe = document.createElement("iframe");
    // Not "/preview.html": under a subdirectory deploy the document is not
    // at the site root. `BASE_URL` is what `base` in vite.config.ts resolves to.
    this.iframe.src = `${import.meta.env.BASE_URL}preview.html`;
    this.iframe.style.cssText = "border:0;width:100%;height:100%;display:block;background:#353535";
    this.iframe.setAttribute("title", "DragonBones runtime preview");

    window.addEventListener("message", (e) => {
      if (e.source !== this.iframe.contentWindow) return;
      const msg = e.data as FrameToHost;
      if (!msg || typeof msg !== "object" || !("type" in msg)) return;
      if (msg.type === "ready") {
        const reloaded = this.ready;
        this.ready = true;
        // Moving an iframe in the DOM reloads it, and the dock rebuilds its
        // DOM whenever a panel is focused or a tab is dragged. Rather than
        // trying to keep the element in place, just replay the last payload
        // whenever the frame announces itself again.
        if (reloaded && this.lastLoad) {
          this.iframe.contentWindow?.postMessage(this.lastLoad, "*");
          return;
        }
        for (const q of this.queue) this.post(q);
        this.queue = [];
      }
      for (const fn of this.listeners) fn(msg);
    });
  }

  /**
   * Take the frame out of the page. Whatever goes back in later is a fresh
   * page, so nothing is carried over: replaying the last payload there loaded
   * an export from the previous visit first and the current one after it.
   */
  detach(): void {
    this.iframe.remove();
    this.ready = false;
    this.queue = [];
    this.lastLoad = null;
  }

  /**
   * Empty the frame. `lastLoad` goes with it, or the next `ready` — a dock
   * focus or a float/dock move reloads the iframe — would put the export
   * that was just cleared straight back.
   */
  clear(): void {
    this.lastLoad = null;
    this.post({ type: "clear" });
  }

  onMessage(fn: (msg: FrameToHost) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  post(msg: HostToFrame): void {
    if (msg.type === "load") this.lastLoad = msg;
    if (!this.ready) { this.queue.push(msg); return; }
    this.iframe.contentWindow?.postMessage(msg, "*");
  }

  load(skeleton: unknown, textures: PreviewTexture[], opts: {
    armature?: string; animation?: string; debugDraw?: boolean;
    play?: boolean; frame?: number;
    fit?: { x: number; y: number; w: number; h: number };
    stage?: { width: number; height: number; background: string };
    extensions?: ExtensionManifest | null;
  } = {}): void {
    this.post({ type: "load", skeleton, textures, ...opts });
  }

  /** Await one message of a given type — used by the parity harness. */
  once<T extends FrameToHost["type"]>(type: T, timeoutMs = 8000): Promise<Extract<FrameToHost, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`Preview timed out waiting for "${type}"`)); }, timeoutMs);
      const off = this.onMessage((msg) => {
        if (msg.type === type) {
          clearTimeout(timer);
          off();
          resolve(msg as Extract<FrameToHost, { type: T }>);
        } else if (msg.type === "error") {
          clearTimeout(timer);
          off();
          reject(new Error(msg.message));
        }
      });
    });
  }
}
