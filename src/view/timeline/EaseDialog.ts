import type { Store } from "@/app/Store";
import { uiFont } from "@/core/prefs/fonts";
import { doSetEases, type EaseTarget } from "@/app/TimelineOps";
import {
    applyTween,
    type ChannelEases,
    classicDir,
    DEFAULT_CUSTOM_CURVE,
    EASE_FAMILIES,
    type EaseDir,
    type EaseFamily,
    easeFunction,
    easeScalar,
    type EaseSpec,
    familyInfo,
    presetAmount,
    TWEEN_CHANNELS,
    type TweenChannel,
    type TweenSpec,
} from "@/core/math/easing";
import {
    anchorsOf,
    curveValueAt,
    insertAnchor,
    moveAnchor,
    moveHandle,
    pullHandles,
    removeAnchor,
    toCorner,
} from "@/core/math/easeCurve";
import { Modal } from "@/view/widgets/Modal";
import { NumberField, type NumberFieldOpts } from "@/view/widgets/NumberField";
import { clear, h, on } from "@/view/widgets/dom";

type Scope = "all" | TweenChannel;
type Choice = "none" | "default" | "linear" | "classic" | EaseFamily | "custom";

const CHANNEL_LABEL: Record<TweenChannel, string> = {
  position: "Position", rotation: "Rotation", scale: "Scale", color: "Color",
};

const DIRS: Array<[EaseDir, string]> = [["in", "In"], ["out", "Out"], ["inOut", "In-Out"]];

function choiceOf(spec: TweenSpec | undefined): Choice {
  if (!spec) return "default";
  switch (spec.kind) {
    case "none":   return "none";
    case "linear": return "linear";
    case "ease":   return "classic";
    case "curve":  return "custom";
    case "preset": return spec.family;
  }
}

/** Flash's Classic ease as DragonBones' one scalar: in is (−1, 0), out is
 *  (0, 1], in-out is (1, 2]. In-out never reaches 1, which reads as out. */
function classicSpec(dir: EaseDir, strength: number): EaseSpec {
  const s = Math.min(100, Math.max(0, strength)) / 100;
  if (dir === "in") return s === 0 ? { kind: "linear" } : { kind: "ease", value: -s };
  if (dir === "out") return s === 0 ? { kind: "linear" } : { kind: "ease", value: s };
  return { kind: "ease", value: Math.max(1.01, 1 + s) };
}

function classicStrength(value: number): number {
  if (value < 0) return Math.round(-value * 100);
  if (value <= 1) return Math.round(value * 100);
  return Math.round((value - 1) * 100);
}

/** The ideal curve, drawn dashed behind what the runtime will sample. */
function idealAt(spec: TweenSpec, p: number): number {
  switch (spec.kind) {
    case "none":   return 0;
    case "linear": return p;
    case "ease":   return easeScalar(p, spec.value);
    case "curve":  return curveValueAt(spec.curve, p);
    case "preset": return easeFunction(spec)(p);
  }
}

/**
 * The Ease panel, after Animate's: which property, which ease, and the curve
 * the runtime will actually play.
 *
 * It edits a draft; OK writes every target interval in one `EditTracks`.
 * `targets[0]` supplies the starting values and the span the graph is drawn
 * for — a preset's samples depend on the span, so with several targets of
 * different length the graph is exact for the first one only.
 */
export function openEaseDialog(store: Store, targets: EaseTarget[]): void {
  const first = targets[0];
  const anim = store.currentAnimation;
  if (!first || !anim) return;
  const key = anim.tracks[first.nodeId]?.keys.find((k) => k.frame === first.frame);
  if (!key) return;

  let tween: TweenSpec = key.tween;
  let eases: ChannelEases = { ...(key.eases ?? {}) };
  let scope: Scope = "all";
  let dir: EaseDir = "out";
  let selectedAnchor = -1;
  const span = first.span;
  const hasColor = targets.some((t) => anim.tracks[t.nodeId]?.keys.some((k) => k.color !== undefined));
  const channels = TWEEN_CHANNELS.filter((c) => c !== "color" || hasColor || eases.color);

  const modal = new Modal({
    title: targets.length > 1 ? `Ease (${targets.length} tweens)` : "Ease",
    width: 760, height: 470,
    onClose: () => offKeys(),
  });

  const scopeList = h("div", { class: "ease-list" });
  const choiceList = h("div", { class: "ease-list" });
  const dirBar = h("div", { class: "modesw ease-dirs" });
  const amountLabel = h("span", { class: "ease-amount-label" });
  // NumberField keeps this object, so the range follows the family shown.
  const amountOpts: NumberFieldOpts = {
    min: 0, max: 100, step: 1, decimals: 2,
    onInput: (v, committing) => { if (committing) setAmount(v); },
  };
  const amount = new NumberField(amountOpts);
  const amountBox = h("div", { class: "ease-amount" }, amountLabel, amount.el);
  const canvas = h("canvas", { class: "ease-graph" });
  const hint = h("div", { class: "ease-hint" });
  const ctx = canvas.getContext("2d")!;

  modal.body.appendChild(h("div", { class: "ease-dlg" },
    h("div", { class: "ease-col" }, h("div", { class: "ease-head" }, "Property"), scopeList),
    h("div", { class: "ease-col" }, h("div", { class: "ease-head" }, "Ease"), choiceList),
    h("div", { class: "ease-main" },
      h("div", { class: "ease-bar" }, dirBar, amountBox),
      canvas,
      hint)));

  const info = h("span", { class: "ease-info" },
    `${span} frame${span === 1 ? "" : "s"} · the export keeps ${span + 1} points of the curve`);
  const cancel = h("button", { class: "btn" }, "Cancel");
  on(cancel, "pointerup", () => modal.close());
  const ok = h("button", { class: "btn primary" }, "OK");
  on(ok, "pointerup", () => {
    const clean = tween.kind === "none" ? undefined : eases;
    doSetEases(store, targets, tween, clean && Object.keys(clean).length ? clean : undefined);
    modal.close();
  });
  modal.footer.append(info, h("div", { class: "spacer" }), cancel, ok);

  /* ── State ─────────────────────────────────────────────────────────────*/

  const specInScope = (): TweenSpec | undefined => (scope === "all" ? tween : eases[scope]);
  /** What the graph shows: an unset override follows the default. */
  const effective = (): TweenSpec => (scope === "all" ? tween : eases[scope] ?? tween);

  const setSpec = (spec: TweenSpec | undefined) => {
    if (scope === "all") {
      tween = spec ?? { kind: "linear" };
    } else {
      const next = { ...eases };
      if (spec && spec.kind !== "none") next[scope] = spec;
      else delete next[scope];
      eases = next;
    }
  };

  const syncDirFromSpec = () => {
    const s = specInScope();
    if (s?.kind === "preset") dir = s.dir;
    else if (s?.kind === "ease") dir = classicDir(s.value);
  };

  const choose = (c: Choice) => {
    const cur = specInScope();
    selectedAnchor = -1;
    switch (c) {
      case "none":    setSpec({ kind: "none" }); break;
      case "default": setSpec(undefined); break;
      case "linear":  setSpec({ kind: "linear" }); break;
      case "classic":
        setSpec(cur?.kind === "ease" ? cur : classicSpec(dir, 100));
        break;
      case "custom":
        setSpec(cur?.kind === "curve" ? cur : { kind: "curve", curve: [...DEFAULT_CUSTOM_CURVE] });
        break;
      default:
        setSpec(cur?.kind === "preset" && cur.family === c ? cur : { kind: "preset", family: c, dir });
    }
    render();
  };

  const setDir = (d: EaseDir) => {
    dir = d;
    const cur = specInScope();
    if (cur?.kind === "preset") setSpec({ ...cur, dir: d });
    else if (cur?.kind === "ease") setSpec(classicSpec(d, classicStrength(cur.value)));
    render();
  };

  const setAmount = (v: number) => {
    const cur = specInScope();
    if (cur?.kind === "preset") setSpec({ ...cur, amount: presetAmount({ ...cur, amount: v }) });
    else if (cur?.kind === "ease") setSpec(classicSpec(dir, v));
    render();
  };

  /* ── Lists ─────────────────────────────────────────────────────────────*/

  const row = (label: string, on_: boolean, run: () => void, opts: { mark?: boolean; disabled?: boolean } = {}) => {
    const el = h("div", {
      class: `ease-row${on_ ? " on" : ""}${opts.disabled ? " disabled" : ""}`,
    }, label, opts.mark ? h("span", { class: "ease-mark" }, "●") : null);
    // pointerup, not click: the list is rebuilt under the pointer. See CLAUDE.md.
    if (!opts.disabled) on(el, "pointerup", run);
    return el;
  };

  const renderScopes = () => {
    clear(scopeList);
    scopeList.appendChild(row("All properties", scope === "all", () => { scope = "all"; syncDirFromSpec(); render(); }));
    for (const ch of channels) {
      scopeList.appendChild(row(CHANNEL_LABEL[ch], scope === ch,
        () => { scope = ch; syncDirFromSpec(); render(); },
        { mark: !!eases[ch], disabled: tween.kind === "none" }));
    }
  };

  const renderChoices = () => {
    clear(choiceList);
    const current = choiceOf(specInScope());
    if (scope === "all") choiceList.appendChild(row("No tween", current === "none", () => choose("none")));
    else choiceList.appendChild(row("Same as All", current === "default", () => choose("default")));
    choiceList.appendChild(row("Linear", current === "linear", () => choose("linear")));
    choiceList.appendChild(row("Classic", current === "classic", () => choose("classic")));
    for (const f of EASE_FAMILIES) {
      choiceList.appendChild(row(f.label, current === f.id, () => choose(f.id)));
    }
    choiceList.appendChild(row("Custom", current === "custom", () => choose("custom")));
  };

  const renderBar = () => {
    const s = specInScope();
    clear(dirBar);
    const directional = s?.kind === "preset" || s?.kind === "ease";
    dirBar.style.visibility = directional ? "visible" : "hidden";
    for (const [d, label] of DIRS) {
      const b = h("button", { class: `seg${d === dir ? " on" : ""}` }, label);
      on(b, "pointerup", () => setDir(d));
      dirBar.appendChild(b);
    }

    let shown = false;
    if (s?.kind === "ease") {
      amountLabel.textContent = "Strength";
      Object.assign(amountOpts, { min: 0, max: 100, step: 1 });
      amount.set(classicStrength(s.value));
      shown = true;
    } else if (s?.kind === "preset") {
      const a = familyInfo(s.family).amount;
      if (a) {
        amountLabel.textContent = a.label;
        Object.assign(amountOpts, { min: a.min, max: a.max, step: a.step });
        amount.set(presetAmount(s));
        shown = true;
      }
    }
    amountBox.style.visibility = shown ? "visible" : "hidden";

    if (s?.kind === "curve") {
      hint.textContent =
        "Double-click the curve to add a point · Drag to move it · ⌥-drag a point to pull out handles · " +
        "⌥-click for a sharp corner · ⌘-click to delete · ⌥-drag a handle to move it on its own";
    } else if (tween.kind === "none") {
      hint.textContent = "No tween: the frames keep the first keyframe's values until the next keyframe.";
    } else if (scope !== "all" && !eases[scope]) {
      hint.textContent = "Uses the ease set for All properties.";
    } else {
      hint.textContent = "Solid line: the curve as it plays after export, one point per frame. Dashed line: the exact curve.";
    }
  };

  const render = () => {
    renderScopes();
    renderChoices();
    renderBar();
    draw();
  };

  /* ── Graph ─────────────────────────────────────────────────────────────*/

  type Hit = { kind: "anchor"; index: number } | { kind: "handle"; index: number; side: "in" | "out" } | null;
  let gesture: { hit: NonNullable<Hit>; alt: boolean; moved: boolean; startX: number; startY: number } | null = null;

  const PAD = 28;
  let yMin = 0, yMax = 1;
  const cssW = () => canvas.clientWidth || 440;
  const cssH = () => canvas.clientHeight || 300;
  const toX = (x: number) => PAD + x * (cssW() - 2 * PAD);
  const toY = (y: number) => cssH() - PAD - ((y - yMin) / (yMax - yMin)) * (cssH() - 2 * PAD);
  const fromX = (px: number) => (px - PAD) / (cssW() - 2 * PAD);
  const fromY = (py: number) => yMin + ((cssH() - PAD - py) / (cssH() - 2 * PAD)) * (yMax - yMin);

  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = cssW(), hgt = cssH();
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(hgt * dpr)) canvas.height = Math.round(hgt * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas);
    const col = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;

    const spec = effective();
    const STEPS = 240;
    const ideal: number[] = [];
    const played: number[] = [];
    for (let i = 0; i <= STEPS; i++) {
      const p = i / STEPS;
      ideal.push(idealAt(spec, p));
      played.push(applyTween(spec, p, span));
    }
    // Frozen while a point is dragged: rescaling under the pointer would
    // move the point away from it.
    if (!gesture) {
      const lo = Math.min(0, ...ideal, ...played);
      const hi = Math.max(1, ...ideal, ...played);
      const margin = (hi - lo) * 0.04;
      yMin = lo < 0 ? lo - margin : 0;
      yMax = hi > 1 ? hi + margin : 1;
      if (spec.kind === "curve") {
        for (const a of anchorsOf(spec.curve)) {
          yMin = Math.min(yMin, a.y, a.inY, a.outY);
          yMax = Math.max(yMax, a.y, a.inY, a.outY);
        }
      }
    }

    ctx.clearRect(0, 0, w, hgt);
    ctx.fillStyle = col("--bg-sunken", "#333");
    ctx.fillRect(0, 0, w, hgt);

    // Frames across, percent up.
    ctx.lineWidth = 1;
    ctx.strokeStyle = col("--line-grid", "#383838");
    ctx.beginPath();
    const every = Math.max(1, Math.ceil(span / 40));
    for (let f = 0; f <= span; f += every) {
      const x = Math.round(toX(f / span)) + 0.5;
      ctx.moveTo(x, toY(yMax)); ctx.lineTo(x, toY(yMin));
    }
    for (let v = Math.ceil(yMin * 4) / 4; v <= yMax + 1e-9; v += 0.25) {
      const y = Math.round(toY(v)) + 0.5;
      ctx.moveTo(toX(0), y); ctx.lineTo(toX(1), y);
    }
    ctx.stroke();

    ctx.strokeStyle = col("--line-soft", "#4e4e4e");
    ctx.beginPath();
    for (const v of [0, 1]) {
      const y = Math.round(toY(v)) + 0.5;
      ctx.moveTo(toX(0), y); ctx.lineTo(toX(1), y);
    }
    ctx.stroke();

    ctx.fillStyle = col("--fg-dim", "#8f8f8f");
    ctx.font = uiFont(9, store.prefs.value.interface.fontSize);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const v of [0, 0.5, 1]) ctx.fillText(`${v * 100}`, PAD - 4, toY(v));
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("0", toX(0), hgt - PAD + 4);
    ctx.fillText(String(span), toX(1), hgt - PAD + 4);

    const plot = (values: number[]) => {
      ctx.beginPath();
      values.forEach((v, i) => {
        const x = toX(i / STEPS), y = toY(v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    const accent = col("--accent", "#00bcd9");
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = col("--fg-dim", "#8f8f8f");
    plot(ideal);
    ctx.setLineDash([]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    plot(played);
    ctx.lineWidth = 1;

    // What the stage shows on each whole frame.
    ctx.fillStyle = accent;
    for (let f = 0; f <= span; f += every) {
      const p = f / span;
      ctx.beginPath();
      ctx.arc(toX(p), toY(applyTween(spec, p, span)), 2, 0, Math.PI * 2);
      ctx.fill();
    }

    if (spec.kind === "curve" && specInScope()?.kind === "curve") drawHandles(spec.curve);
  };

  const drawHandles = (curve: readonly number[]) => {
    const anchors = anchorsOf(curve);
    const fg = getComputedStyle(canvas).getPropertyValue("--fg-strong").trim() || "#f0f0f0";
    ctx.strokeStyle = fg;
    ctx.fillStyle = fg;
    anchors.forEach((a, i) => {
      const handles: Array<[number, number]> = [];
      if (i > 0) handles.push([a.inX, a.inY]);
      if (i < anchors.length - 1) handles.push([a.outX, a.outY]);
      for (const [hx, hy] of handles) {
        if (Math.hypot(hx - a.x, hy - a.y) < 1e-6) continue;
        ctx.beginPath();
        ctx.moveTo(toX(a.x), toY(a.y));
        ctx.lineTo(toX(hx), toY(hy));
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(toX(hx), toY(hy), 3, 0, Math.PI * 2);
        ctx.fill();
      }
      const s = i === selectedAnchor ? 7 : 5;
      ctx.fillRect(toX(a.x) - s / 2, toY(a.y) - s / 2, s, s);
    });
  };

  /* ── Custom curve editing ──────────────────────────────────────────────*/

  const hitTest = (curve: readonly number[], px: number, py: number): Hit => {
    const anchors = anchorsOf(curve);
    const near = (x: number, y: number) => Math.hypot(toX(x) - px, toY(y) - py) <= 6;
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i]!;
      if (i > 0 && i < anchors.length - 1 && near(a.x, a.y)) return { kind: "anchor", index: i };
    }
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i]!;
      if (i < anchors.length - 1 && near(a.outX, a.outY)) return { kind: "handle", index: i, side: "out" };
      if (i > 0 && near(a.inX, a.inY)) return { kind: "handle", index: i, side: "in" };
    }
    return null;
  };

  const editable = () => {
    const s = specInScope();
    return s?.kind === "curve" ? s : null;
  };

  const localPoint = (ev: PointerEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { px: ev.clientX - r.left, py: ev.clientY - r.top };
  };


  on(canvas, "pointerdown", (ev) => {
    const e = ev as PointerEvent;
    const spec = editable();
    if (!spec || e.button !== 0) return;
    const { px, py } = localPoint(e);
    let hit = hitTest(spec.curve, px, py);

    if (hit?.kind === "anchor" && (e.metaKey || e.ctrlKey)) {
      setSpec({ kind: "curve", curve: removeAnchor(spec.curve, hit.index) });
      selectedAnchor = -1;
      render();
      return;
    }
    if (!hit && e.altKey) {
      const ins = insertAnchor(spec.curve, fromX(px));
      if (ins.index < 0) return;
      setSpec({ kind: "curve", curve: ins.curve });
      hit = { kind: "anchor", index: ins.index };
    }
    if (!hit) return;
    if (hit.kind === "anchor") selectedAnchor = hit.index;
    gesture = { hit, alt: e.altKey, moved: false, startX: px, startY: py };
    canvas.setPointerCapture(e.pointerId);
    render();
  });

  on(canvas, "pointermove", (ev) => {
    const e = ev as PointerEvent;
    const spec = editable();
    if (!gesture || !spec) return;
    const { px, py } = localPoint(e);
    if (!gesture.moved && Math.hypot(px - gesture.startX, py - gesture.startY) < 3) return;
    gesture.moved = true;
    const x = fromX(px), y = fromY(py);
    const { hit } = gesture;
    let curve: number[];
    if (hit.kind === "anchor") {
      curve = gesture.alt ? pullHandles(spec.curve, hit.index, x, y) : moveAnchor(spec.curve, hit.index, x, y);
    } else {
      curve = moveHandle(spec.curve, hit.index, hit.side, x, y, !e.altKey);
    }
    setSpec({ kind: "curve", curve });
    draw();
  });

  const endGesture = (ev: Event) => {
    const e = ev as PointerEvent;
    const spec = editable();
    if (gesture && spec && !gesture.moved && gesture.alt && gesture.hit.kind === "anchor") {
      setSpec({ kind: "curve", curve: toCorner(spec.curve, gesture.hit.index) });
    }
    gesture = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    render();
  };
  on(canvas, "pointerup", endGesture);
  on(canvas, "pointercancel", endGesture);

  on(canvas, "dblclick", (ev) => {
    const spec = editable();
    if (!spec) return;
    const { px, py } = localPoint(ev as MouseEvent);
    if (hitTest(spec.curve, px, py)) return;
    const ins = insertAnchor(spec.curve, fromX(px));
    if (ins.index < 0) return;
    setSpec({ kind: "curve", curve: ins.curve });
    selectedAnchor = ins.index;
    render();
  });

  const offKeys = on(window, "keydown", (ev) => {
    const e = ev as unknown as KeyboardEvent;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
    const spec = editable();
    if (!spec || selectedAnchor < 0) return;
    const a = anchorsOf(spec.curve)[selectedAnchor];
    if (!a) return;
    e.preventDefault();
    const step = (e.shiftKey ? 0.1 : 0.01) * (e.key === "ArrowUp" ? 1 : -1);
    setSpec({ kind: "curve", curve: moveAnchor(spec.curve, selectedAnchor, a.x, a.y + step) });
    draw();
  });

  syncDirFromSpec();
  render();
  // The canvas has no size until the modal is laid out.
  requestAnimationFrame(draw);
}
