import { clear, cls, h, on } from "@/view/widgets/dom";
import { icon } from "@/view/icons";
import { NumberField } from "@/view/widgets/NumberField";
import type { Panel } from "@/view/widgets/Dock";
import type { Store } from "@/app/Store";
import {
    type DocumentSettingsPatch,
    RenameNode,
    SetDocumentSettings,
    SetNodeBlendMode,
    SetNodeMotionBlur,
    SetPivot,
} from "@/core/history/commands";
import {
    applyColors,
    applyEdit,
    colorAtFrame,
    displayAtFrame,
    editsMultipleFrames,
    transformAtFrame,
} from "@/app/TimelineOps";
import { cloneTf, type Transform } from "@/core/math/Transform";
import type { NodeId } from "@/core/doc/ids";
import type { Rect } from "@/core/math/geom";
import { instancesOf, type PoseAt, selectionBounds } from "@/view/tools/gizmo";
import {
    applyWorldMatrix,
    moveBy,
    type NodeSnapshot,
    rotateAbout,
    snapshotOf,
    topmostSelected,
    worldScaleMatrix,
} from "@/view/tools/transformOps";
import { displaySize, type Pose } from "@/core/doc/pose";
import { frameDirections, SCENE_FRAME } from "@/view/viewport/nodeFrame";
import {
    type BlendMode,
    type ColorTransform,
    DEFAULT_COLOR,
    DEFAULT_MOTION_BLUR,
    isDefaultColor,
    isSymbol,
    type Node,
} from "@/core/doc/types";
import { ikRelations } from "@/core/doc/ikGraph";
import { type IkPatch, RemoveIkConstraint, SetBoneLength, SetIkOptions, } from "@/core/history/ikCommands";

/**
 * A multi-selection edited as one object — Flash's behaviour, and the
 * "virtual group" of Edit Multiple Frames: X/Y/W/H are its bounding box, and
 * every write moves, scales or rotates the whole group.
 */
interface GroupSnapshot {
  bounds: Rect;
  snaps: NodeSnapshot[];
  /** The first selected node's transform: the typed Scale, Rotate and Skew
   *  are for it, and the rest of the group follows rigidly. */
  first: Transform;
}

type FieldKey =
  | "x" | "y" | "w" | "h"
  | "scaleX" | "scaleY"
  | "rotation" | "skewX" | "skewY"
  | "pivotX" | "pivotY";

/**
 * The inspector. Every field writes through the same commands the stage
 * gizmo uses, so numeric entry and direct manipulation share one undo story.
 */
/** One piece of a link row: a separator, or a name that selects nodes. */
type LinkPart = string | { text: string; select: NodeId[]; title?: string };

export class PropertiesPanel implements Panel {
  readonly id = "properties";
  readonly title = "Properties";
  readonly icon = "properties" as const;
  readonly el: HTMLElement;

  private body: HTMLElement;
  private fields = new Map<FieldKey, NumberField>();
  private nameInput: HTMLInputElement | null = null;
  /** The "this frame is turned" badge, refreshed on every sync: the pose it
   *  reads is the RENDERED one, which does not exist yet at layout time and
   *  changes under the playhead anyway. */
  private frameNote: HTMLElement | null = null;
  private suppress = false;
  /** With nothing selected: refreshes the document fields in place. The
   *  section used to be rebuilt on every "frame" event, which during playback
   *  destroyed the field under the cursor sixty times a second. */
  private docSync: Array<() => void> = [];
  private rebuilding = false;
  /** A field scrub in progress: one interaction from the first step to the
   *  commit, so Edit Multiple Frames edits the keys as they were when it
   *  began. */
  private scrubbing = false;
  /** The virtual group being edited, captured at the first step of a scrub
   *  (or for one typed value). Every step is computed from it, not from the
   *  last rendered pose, which lags a step behind a fast scrub. */
  private group: GroupSnapshot | null = null;
  /** Chain toggles: keep the paired fields proportional. Remembered across
   *  selections and sessions, the way Animate's link button behaves. */
  private linked: Record<"size" | "scale" | "stage", boolean> = {
    size: loadLinked("size"),
    scale: loadLinked("scale"),
    stage: loadLinked("stage"),
  };

  /** Identity of what is currently laid out. A change here means the panel's
   *  STRUCTURE is stale (different item, different node kind), not just its
   *  numbers, so it must be rebuilt rather than merely re-synced. */
  private signature = "";

  /** Chosen colour-effect mode per node. Not in the document: it is a view of
   *  one ColorTransform, so it is re-derived when a node is first shown and
   *  then remembered while the selection lasts. */
  private colorModes = new Map<NodeId, ColorMode>();

  /**
   * The panel needs the RENDERED pose, not a freshly composed one: a bone
   * driven by IK is rotated by the solver at display time, and the note below
   * would otherwise name the frame the file describes rather than the one the
   * user is looking at.
   */
  constructor(
    private readonly store: Store,
    private readonly poseOf: () => Pose | null = () => null,
    /** Every pose on stage the selection can be edited in: the playhead's,
     *  plus each frame Edit Multiple Frames shows. */
    private readonly posesOf: () => PoseAt[] = () => [],
  ) {
    this.body = h("div", { class: "props" });
    this.el = this.body;
    store.subscribe((t) => {
      if (t === "selection" || t === "doc" || t === "frame" || t === "stage") this.sync();
    });
    this.rebuild();
  }

  // ── Structure ──────────────────────────────────────────────────────────

  private signatureOf(): string {
    const nodes = this.store.selectedNodes;
    if (nodes.length === 0) return `doc:${this.store.project.motionBlur?.enabled === true}`;
    // The display shown decides the Instance and Colour sections, and
    // changes under the playhead on a layer that switches artwork.
    return nodes.map((n) => `${n.id}:${n.kind}:${displayAtFrame(this.store, n).display?.itemId ?? ""}`).join("|");
  }

  /**
   * Rebuild the panel's DOM.
   *
   * Never re-entrant: removing a focused field fires its `blur`, the blur
   * commits, the commit emits, and the emit used to land back here in the
   * middle of `clear` — "removeChild: the node is no longer a child", thrown
   * from inside Playback's tick, which killed the playback loop while the
   * transport still said Pause. A nested request is covered by the sync that
   * always follows.
   */
  private rebuild(): void {
    if (this.rebuilding) return;
    this.rebuilding = true;
    try {
      // Commit what is being typed while its field still exists.
      const active = document.activeElement;
      if (active instanceof HTMLElement && this.body.contains(active)) active.blur();
      this.build();
    } finally {
      this.rebuilding = false;
    }
    this.sync();
  }

  private build(): void {
    clear(this.body);
    this.fields.clear();
    this.nameInput = null;
    this.docSync = [];
    this.signature = this.signatureOf();
    const nodes = this.store.selectedNodes;

    if (nodes.length === 0) {
      this.body.appendChild(this.documentSection());
      return;
    }

    // A bone has no artwork, so width, height and a transform point would be
    // fields with nothing behind them.
    const bone = nodes.length === 1 && nodes[0]!.kind === "bone" ? nodes[0]! : null;

    this.body.appendChild(this.instanceSection(nodes.length));
    this.body.appendChild(this.section("Position and Size", true, [
      this.row("", [this.field("x", "X"), this.field("y", "Y")]),
      ...(bone ? [] : [this.linkedRow("", "size", this.field("w", "W"), this.field("h", "H"))]),
    ], this.makeFrameNote()));
    this.body.appendChild(this.section("Transform", true, [
      this.linkedRow("Scale", "scale",
        this.field("scaleX", "X", { step: 0.01, decimals: 3, sensitivity: 60 }),
        this.field("scaleY", "Y", { step: 0.01, decimals: 3, sensitivity: 60 })),
      this.row("Rotate", [this.field("rotation", "∠", { unit: "°" })]),
      // Skew X and Skew Y ARE the two angular degrees of freedom, exactly as
      // in Flash: a pure rotation shows the same value in both, and pulling
      // them apart is what shears the object.
      this.row("Skew", [
        this.field("skewX", "X", { unit: "°" }),
        this.field("skewY", "Y", { unit: "°" }),
      ]),
      ...(bone ? [] : [this.row("Pivot", [this.field("pivotX", "X"), this.field("pivotY", "Y")])]),
    ]));
    // A bone produces no slot, so it has neither colour nor blend mode.
    if (!bone) this.body.appendChild(this.colorSection(nodes));
    if (bone) {
      this.body.appendChild(this.boneSection(bone));
      const section = this.ikSection(bone);
      if (section) this.body.appendChild(section);
    }
  }

  /**
   * Colour effect and blend mode.
   *
   * Only MULTIPLIERS are offered. The runtime parses and tweens the four
   * offsets but `PixiSlot._updateColor` never reads them — it puts
   * `alphaMultiplier` into `display.alpha` and packs the three colour
   * multipliers into `display.tint`, which is a pure multiply. Exposing an
   * offset would look right on the stage and vanish in the preview, so Flash's
   * additive Tint is deliberately not reproduced here; "Tint" below is
   * multiplicative and says so.
   *
   * A symbol instance gets Alpha only: its display is a Container, so the
   * `instanceof PIXI.Sprite` guards in `_updateColor` and `_updateBlendMode`
   * both fail and neither tint nor blend mode reaches it.
   */
  private colorSection(nodes: Node[]): HTMLElement {
    const node = nodes[0]!;
    const ids = nodes.map((n) => n.id);
    const shown = displayAtFrame(this.store, node).display;
    const isInstance = isSymbol(shown ? this.store.project.items[shown.itemId] : undefined);
    const current = colorAtFrame(this.store, node);

    const mode = this.colorModes.get(node.id) ?? deriveColorMode(current, isInstance);
    this.colorModes.set(node.id, mode);

    const write = (next: ColorTransform, committing: boolean) => {
      this.scrubStep("node.color", committing);
      // The commit belongs to the scrub's entry: a different kind on the last
      // step left a second undo step that restored the same colour.
      applyColors(this.store, new Map(ids.map((id) => [id, next])), this.store.history.inInteraction);
      this.store.emit("stage");
      this.store.emit("timeline");
      if (committing) this.store.history.endInteraction();
    };

    const modeSel = h("select", { class: "preview-anim" },
      h("option", { value: "none" }, "None"),
      h("option", { value: "alpha" }, "Alpha"),
      ...(isInstance ? [] : [
        h("option", { value: "brightness" }, "Brightness"),
        h("option", { value: "tint" }, "Tint (multiply)"),
        h("option", { value: "advanced" }, "Advanced"),
      ]));
    modeSel.value = mode;
    on(modeSel, "change", () => {
      const next = modeSel.value as ColorMode;
      this.colorModes.set(node.id, next);
      if (next === "none") write({ ...DEFAULT_COLOR }, true);
      this.rebuild();
    });

    const rows: HTMLElement[] = [this.row("Effect", [modeSel])];

    const pct = (glyph: string, value: number, pick: (v: number) => ColorTransform) => {
      const nf = new NumberField({
        glyph, min: 0, max: 100, step: 1, decimals: 0, unit: "%",
        onInput: (v, committing) => write(pick(v), committing),
      });
      nf.set(value);
      return nf.el;
    };

    if (mode === "alpha" || mode === "advanced") {
      rows.push(this.row("Alpha", [
        pct("A", current.aM, (v) => ({ ...colorAtFrame(this.store, node), aM: v })),
      ]));
    }

    if (mode === "brightness") {
      // Flash brightens with an offset; without offsets the honest range is
      // "darken to black", so the label says multiply rather than promising
      // Flash's curve.
      rows.push(this.row("Brightness", [
        pct("B", current.rM, (v) => ({ ...colorAtFrame(this.store, node), rM: v, gM: v, bM: v })),
      ]));
    }

    if (mode === "tint") {
      const swatch = h("input", { type: "color", value: colorToHex(current), class: "swatch" });
      on(swatch, "input", () => {
        const { r, g, b } = hexToPct(swatch.value);
        write({ ...colorAtFrame(this.store, node), rM: r, gM: g, bM: b }, false);
      });
      on(swatch, "change", () => {
        const { r, g, b } = hexToPct(swatch.value);
        write({ ...colorAtFrame(this.store, node), rM: r, gM: g, bM: b }, true);
      });
      rows.push(this.row("Tint", [swatch]));
      rows.push(h("div", { class: "prow wide" },
        h("div", { class: "hint", style: "padding:2px 0" },
          "Tint multiplies the colours, so it can only darken: black artwork stays black.")));
    }

    if (mode === "advanced") {
      const base = () => colorAtFrame(this.store, node);
      rows.push(this.row("Red", [pct("R", current.rM, (v) => ({ ...base(), rM: v }))]));
      rows.push(this.row("Green", [pct("G", current.gM, (v) => ({ ...base(), gM: v }))]));
      rows.push(this.row("Blue", [pct("B", current.bM, (v) => ({ ...base(), bM: v }))]));
    }

    const blend = h("select", { class: "preview-anim" },
      ...BLEND_MODES.map(([value, label]) => h("option", { value }, label)));
    blend.value = node.blendMode ?? "normal";
    blend.disabled = isInstance;
    on(blend, "change", () => {
      this.store.apply(new SetNodeBlendMode(
        this.store.currentSymbolId, ids, blend.value as BlendMode,
      ));
      this.store.emit("stage");
      this.store.emit("doc");
    });
    rows.push(this.row("Blend", [blend]));

    const blurStrength = new NumberField({
      glyph: "", min: 0, max: 200, step: 1, decimals: 0, unit: "%",
      onInput: (v, committing) => {
        this.scrubStep("node.motionBlur", committing);
        this.store.apply(new SetNodeMotionBlur(this.store.currentSymbolId, ids, v / 100));
        this.store.emit("doc");
        if (committing) this.store.history.endInteraction();
      },
    });
    blurStrength.set(Math.round((node.motionBlur ?? 1) * 100));
    rows.push(this.row("Motion blur", [blurStrength.el]));
    if (!this.store.project.motionBlur?.enabled) {
      rows.push(h("div", { class: "prow wide" },
        h("div", { class: "hint", style: "padding:2px 0" },
          "Motion blur is off for this document. Click an empty spot on the stage to turn it on under Document.")));
    }
    if (isInstance) {
      rows.push(h("div", { class: "prow wide" },
        h("div", { class: "hint", style: "padding:2px 0" },
          "DragonBones cannot tint or blend a symbol, only an image, so the " +
          "export ignores these here. Alpha still works.")));
    }

    return this.section("Color Effect", true, rows);
  }

  /** Bone length: the second segment of a two-bone IK solve, not decoration. */
  private boneSection(node: Node): HTMLElement {
    const length = new NumberField({
      glyph: "L", min: 1, max: 4096, step: 1, decimals: 0,
      onInput: (v, committing) => {
        this.scrubStep("bone.length", committing);
        this.store.apply(new SetBoneLength(
          this.store.currentSymbolId, new Map([[node.id, v]]),
        ));
        this.store.emit("stage");
        if (committing) this.store.history.endInteraction();
      },
    });
    length.set(node.boneLength ?? 0);
    return this.section("Bone", true, [this.row("Length", [length.el])]);
  }

  /**
   * Every constraint this bone takes part in — as the target doing the
   * pulling, as the effector being solved, or as the chain ROOT, which the
   * constraint never names and the solver moves anyway.
   *
   * A list, not a lookup: one target can drive several chains, and `find`
   * showed the first and hid the rest. The named bones matter more than the
   * options do — a target is parented OUTSIDE the chain it drives, so nothing
   * in the layer tree says what it is attached to, and this section is the
   * only place that spells the relationship out.
   */
  private ikSection(node: Node): HTMLElement | null {
    const symbol = this.store.currentSymbol;
    const relations = ikRelations(symbol, node.id);
    if (relations.length === 0) return null;
    const nameOf = (id: NodeId) => symbol.nodes[id]?.name ?? "\u2014";

    const rows: HTMLElement[] = [];
    for (const rel of relations) {
      const constraint = rel.constraint;
      const write = (patch: IkPatch) => {
        this.store.apply(new SetIkOptions(this.store.currentSymbolId, constraint.id, patch));
        this.store.emit("stage");
        this.store.emit("doc");
      };

      const chainSel = h("select", { class: "preview-anim" },
        h("option", { value: "1" }, "2 bones"),
        h("option", { value: "0" }, "1 bone"));
      chainSel.value = String(constraint.chain);
      on(chainSel, "change", () => write({ chain: chainSel.value === "1" ? 1 : 0 }));

      const bend = h("button", { class: "btn" }, constraint.bendPositive ? "Positive" : "Negative");
      on(bend, "click", () => write({ bendPositive: !constraint.bendPositive }));

      const weight = new NumberField({
        glyph: "W", min: 0, max: 1, step: 0.05, decimals: 2, sensitivity: 200,
        onInput: (v, committing) => {
          this.scrubStep("ik.options", committing);
          write({ weight: v });
          if (committing) this.store.history.endInteraction();
        },
      });
      weight.set(constraint.weight);

      const remove = h("button", { class: "btn" }, "Remove");
      on(remove, "click", () => {
        this.store.apply(new RemoveIkConstraint(this.store.currentSymbolId, constraint.id));
        this.store.emit("stage");
        this.store.emit("doc");
      });

      const role = rel.role === "target" ? "Target: drag this"
        : rel.role === "root" ? "Solved bone (chain root)"
        : "Solved bone (effector)";

      // Which bones this constraint MOVES, root first, and which one pulls
      // them. Both named, whichever end of the constraint is selected: the
      // question is always "what is on the other side of this?".
      // The names are the navigation. A constraint's cast is scattered down
      // the layer column — the target is not even near the bones, since it is
      // parented outside the chain — so reading a name here and then hunting
      // for its row is the actual work this section was leaving to the user.
      const chainLinks: LinkPart[] = [];
      rel.chain.forEach((id, i) => {
        if (i > 0) chainLinks.push(" \u2192 ");
        chainLinks.push({ text: nameOf(id), select: [id] });
      });

      rows.push(
        // The constraint itself has no layer: clicking it selects everything
        // it touches, which is the nearest true answer.
        this.linkRow("Constraint", [{
          text: constraint.name,
          select: [...rel.chain, constraint.targetId],
          title: "Select the target and every bone it moves",
        }]),
        this.staticRow("Role", role),
        this.linkRow("Solves", chainLinks),
        // The pulling end, unless it is the node already selected.
        ...(rel.role === "target" ? [] : [this.linkRow("Target", [
          { text: nameOf(constraint.targetId), select: [constraint.targetId] },
        ])]),
        this.row("Chain", [chainSel]),
        this.row("Bend", [bend]),
        this.row("Weight", [weight.el]),
        this.row("", [remove]),
      );
    }

    // Two things nothing else in the UI answers: where targets come from, and
    // which mode a drag writes into. Setup moves the rest pose the file
    // carries; Animate keys the target at the playhead. The solved bones are
    // never keyed either way \u2014 the runtime re-solves them on playback, so a
    // keyframe on one fights the solver and the preview drifts off the stage.
    rows.push(this.noteRow(
      "To add IK, pick the IK tool (K) and click the last bone of a chain: a target "
      + "appears at its end. Drag the target to pose the chain. In Animate mode that "
      + "sets a keyframe on the target, in Setup mode it changes the rest pose. The "
      + "bones themselves never get keyframes: they follow the target.",
    ));

    return this.section("IK", true, rows);
  }

  /**
   * A row of names that select what they name. A part with no live node falls
   * back to plain text rather than a dead link — a constraint can outlive the
   * bone it points at while the document is mid-edit.
   */
  private linkRow(label: string, parts: LinkPart[]): HTMLElement {
    const symbol = this.store.currentSymbol;
    const fields = h("div", { class: "fields links" });
    for (const part of parts) {
      if (typeof part === "string") {
        fields.appendChild(h("span", { class: "hint sep" }, part));
        continue;
      }
      const live = part.select.filter((id) => symbol.nodes[id]);
      if (live.length === 0) {
        fields.appendChild(h("span", { class: "hint" }, part.text));
        continue;
      }
      const btn = h("button", {
        class: "nodelink",
        title: part.title ?? `Select ${part.text}`,
      }, part.text);
      on(btn, "click", () => this.store.selectNodes(live));
      fields.appendChild(btn);
    }
    return h("div", { class: "prow" }, h("label", null, label), fields);
  }

  /** A paragraph inside a section, for the rule a row of fields cannot say. */
  private noteRow(text: string): HTMLElement {
    return h("div", { class: "pnote" }, text);
  }

  /**
   * With nothing selected the panel becomes the document's own settings —
   * frame rate, stage size, background — which is where Animate puts them
   * and therefore where people look for them.
   */
  private documentSection(): HTMLElement {
    const p = this.store.project;

    const docField = (
      glyph: string, read: () => number, min: number, max: number,
      write: (v: number) => DocumentSettingsPatch,
    ) => {
      const nf = new NumberField({
        glyph, min, max, step: 1, decimals: 0,
        onInput: (v, committing) => {
          this.scrubStep("doc.settings", committing);
          this.store.apply(new SetDocumentSettings(write(v)));
          this.store.emit("stage");
          this.store.emit("timeline");
          if (committing) this.store.history.endInteraction();
        },
      });
      nf.set(read());
      this.docSync.push(() => nf.show(read()));
      return nf.el;
    };

    const swatch = h("input", { type: "color", value: p.stage.background, class: "swatch" });
    on(swatch, "input", () => {
      this.store.apply(new SetDocumentSettings({ background: swatch.value }));
      this.store.emit("stage");
    });
    this.docSync.push(() => {
      if (document.activeElement !== swatch) swatch.value = this.store.project.stage.background;
    });

    // NOT the document's name on disk — the tab shows the file for that. This
    // is the name the exporter writes into `_ske.json`, uses for the atlas
    // pages and for the export's own file name, so it is the one thing about
    // the project that a runtime actually reads back.
    const nameInput = h("input", {
      type: "text", value: p.name,
      title: "Name of the exported files and of the armature inside them. Not the name of the project file.",
    });
    const commitName = () => {
      const next = nameInput.value.trim();
      if (!next || next === this.store.project.name) { nameInput.value = this.store.project.name; return; }
      this.store.apply(new SetDocumentSettings({ name: next }));
      this.store.emit("doc");
    };
    on(nameInput, "change", commitName);
    on(nameInput, "blur", commitName);
    on(nameInput, "keydown", (ev) => {
      const e = ev as unknown as KeyboardEvent;
      if (e.key === "Enter") { commitName(); nameInput.blur(); }
      if (e.key === "Escape") { nameInput.value = this.store.project.name; nameInput.blur(); }
      e.stopPropagation();
    });
    this.docSync.push(() => {
      if (document.activeElement !== nameInput) nameInput.value = this.store.project.name;
    });

    // Motion blur is the export's, not the stage's: the runtime extension
    // draws it, so it shows in Play mode and the Preview only.
    const blur = p.motionBlur ?? DEFAULT_MOTION_BLUR;
    const blurOn = h("input", { type: "checkbox", checked: blur.enabled });
    on(blurOn, "change", () => {
      this.store.apply(new SetDocumentSettings({ motionBlur: { enabled: blurOn.checked } }));
      this.store.emit("doc");
    });
    const blurField = (
      glyph: string, read: () => number, min: number, max: number, unit: string,
      write: (v: number) => DocumentSettingsPatch,
    ) => {
      const nf = new NumberField({
        glyph, min, max, step: 1, decimals: 0, unit,
        onInput: (v, committing) => {
          this.scrubStep("doc.settings", committing);
          this.store.apply(new SetDocumentSettings(write(v)));
          this.store.emit("doc");
          if (committing) this.store.history.endInteraction();
        },
      });
      nf.set(read());
      this.docSync.push(() => nf.show(read()));
      return nf.el;
    };
    const blurOf = () => this.store.project.motionBlur ?? DEFAULT_MOTION_BLUR;
    const blurRows = blur.enabled
      ? [
        this.row("Shutter", [blurField("", () => blurOf().shutter, 0, 360, "°", (v) => ({ motionBlur: { shutter: v } }))]),
        this.row("Max trail", [blurField("", () => blurOf().maxLength, 1, 4096, "px", (v) => ({ motionBlur: { maxLength: v } }))]),
        h("div", { class: "prow wide" },
          h("div", { class: "hint", style: "padding:2px 0" },
            "Motion blur shows only while the animation plays (Play mode and the Preview), " +
            "not while you edit. Shutter sets the length of the blur: 180° looks like a film " +
            "camera, 360° is twice as long. Max trail caps it in pixels. Each layer's amount " +
            "is under Color Effect.")),
      ]
      : [];

    const frameValue = h("span", { class: "hint" }, `${this.store.ui.frame + 1}`);
    this.docSync.push(() => {
      const text = `${this.store.ui.frame + 1}`;
      if (frameValue.textContent !== text) frameValue.textContent = text;
    });

    return this.section("Document", true, [
      this.row("Name", [nameInput]),
      this.row("FPS", [docField("", () => this.store.project.frameRate, 1, 120, (v) => ({ frameRate: v }))]),
      this.linkedRow("Size", "stage",
        docField("W", () => this.store.project.stage.width, 1, 16384, (v) => ({ width: v })),
        docField("H", () => this.store.project.stage.height, 1, 16384, (v) => ({ height: v }))),
      this.row("Background", [swatch]),
      this.row("Motion blur", [blurOn]),
      ...blurRows,
      h("div", { class: "prow" }, h("label", null, "Frame"), h("div", { class: "fields" }, frameValue)),
      h("div", { class: "prow wide" },
        h("div", { class: "hint", style: "padding:6px 0 2px" },
          "Nothing selected. Drag an item from the Library onto the stage.")),
    ]);
  }

  private instanceSection(count: number): HTMLElement {
    const node = this.store.selectedNodes[0]!;
    const shown = displayAtFrame(this.store, node).display;
    const item = shown ? this.store.project.items[shown.itemId] : undefined;
    const name = h("input", { type: "text", value: count > 1 ? "" : node.name });
    if (count > 1) { name.placeholder = `${count} objects selected`; name.disabled = true; }
    this.nameInput = name;

    const commitName = () => {
      const next = name.value.trim();
      if (count > 1 || !next || next === node.name) { name.value = node.name; return; }
      this.store.apply(new RenameNode(this.store.currentSymbolId, node.id, next));
      this.store.emit("doc");
    };
    on(name, "change", commitName);
    on(name, "blur", commitName);
    on(name, "keydown", (ev) => {
      const e = ev as unknown as KeyboardEvent;
      if (e.key === "Enter") { commitName(); name.blur(); }
      if (e.key === "Escape") { name.value = node.name; name.blur(); }
      e.stopPropagation();
    });

    // An empty layer has no library item at all: saying "Of: empty / Type:
    // Bitmap" would describe artwork that is not there.
    const kindLabel =
      node.kind === "empty" ? "Empty layer"
      : node.kind === "bone" ? "Bone"
      : node.kind === "group" ? "Group"
      : isSymbol(item) ? "Symbol instance"
      : "Bitmap";

    return this.section("Instance", true, [
      this.row("Name", [name]),
      ...(node.kind === "empty" || node.kind === "group" || node.kind === "bone"
        ? []
        : [this.staticRow("Of", item ? item.name : "—")]),
      this.staticRow("Type", kindLabel),
    ]);
  }

  // ── Builders ───────────────────────────────────────────────────────────

  /**
   * "X and Y are not measured the way the screen is."
   *
   * A node's position is the translation of its LOCAL matrix, so it moves
   * along its PARENT's axes — and a bone chain rotates those. `hips` at -90
   * makes `chest`, `head` and everything under them measure y across the stage
   * rather than down it, which reads as a bug the first time you type a number
   * into the field. The badge names the frame and the angle; the stage draws
   * the same thing as a dashed pair of axes.
   */
  private makeFrameNote(): HTMLElement {
    this.frameNote = h("span", { class: "framenote" });
    this.frameNote.hidden = true;
    return this.frameNote;
  }

  /** One frame behind while scrubbing, since the viewport renders on rAF and
   *  this runs on the store event — invisible on a rounded degree value. */
  private syncFrameNote(nodes: Node[]): void {
    const note = this.frameNote;
    if (!note) return;
    note.hidden = true;

    const pose = this.poseOf();
    if (!pose || nodes.length === 0) return;

    // Only when the whole selection shares one parent: two nodes in different
    // frames have no single answer, and a wrong badge is worse than none.
    const parentId = nodes[0]!.parentId;
    if (nodes.some((n) => n.parentId !== parentId)) return;

    const parentWorld = (parentId ? pose.byNode.get(parentId)?.world : null) ?? SCENE_FRAME;
    const dirs = frameDirections(parentWorld);
    if (!dirs) return;

    const sym = this.store.currentSymbol;
    const parentName = parentId ? sym.nodes[parentId]?.name ?? "the parent" : "the scene";
    const angle = `${dirs.rotation > 0 ? "+" : ""}${Math.round(dirs.rotation)}\u00b0`;
    note.textContent = `\u21bb ${angle}`;
    note.title =
      `X and Y follow ${parentName}, which is rotated ${angle}: ` +
      `+X points ${dirs.x}, +Y points ${dirs.y}. The dashed axes on the stage show the same directions.`;
    note.hidden = false;
  }

  private section(
    title: string, open: boolean, rows: HTMLElement[], note?: HTMLElement | null,
  ): HTMLElement {
    const tri = h("span", { class: "tri" });
    const head = h("div", { class: "shead" }, tri, h("span", null, title));
    if (note) head.appendChild(note);
    const body = h("div", { class: "sbody" }, ...rows);
    const sec = h("div", { class: `section${open ? " open" : ""}` }, head, body);
    on(head, "click", () => sec.classList.toggle("open"));
    return sec;
  }

  private row(label: string, controls: HTMLElement[]): HTMLElement {
    return h("div", { class: "prow" },
      h("label", null, label),
      h("div", { class: `fields${controls.length > 1 ? " pair" : ""}` }, ...controls));
  }

  /** A pair of fields with a chain toggle between them. */
  private linkedRow(
    label: string, key: "size" | "scale" | "stage", a: HTMLElement, b: HTMLElement,
  ): HTMLElement {
    const btn = h("button", { class: "iconbtn linkbtn" });
    const paint = () => {
      clear(btn);
      btn.appendChild(icon(this.linked[key] ? "link" : "linkOff", 13));
      cls(btn, "on", this.linked[key]);
      btn.title = this.linked[key]
        ? "Linked: changing one changes the other"
        : "Not linked";
    };
    on(btn, "click", () => {
      this.linked[key] = !this.linked[key];
      saveLinked(key, this.linked[key]);
      paint();
    });
    paint();

    return h("div", { class: "prow" },
      h("label", null, label),
      h("div", { class: "fields pair linked" }, a, btn, b));
  }

  private staticRow(label: string, value: string): HTMLElement {
    return h("div", { class: "prow" },
      h("label", null, label),
      h("div", { class: "fields" }, h("span", { class: "hint" }, value)));
  }

  private field(
    key: FieldKey, glyph: string,
    opts: { step?: number; decimals?: number; unit?: string; sensitivity?: number } = {},
  ): HTMLElement {
    const nf = new NumberField({
      glyph,
      unit: opts.unit,
      step: opts.step ?? 1,
      decimals: opts.decimals ?? 2,
      sensitivity: opts.sensitivity ?? 2,
      onInput: (v, committing) => this.write(key, v, committing),
    });
    this.fields.set(key, nf);
    return nf.el;
  }

  // ── Read / write ───────────────────────────────────────────────────────

  private sync(): void {
    if (this.rebuilding) return;
    if (!this.scrubbing) this.group = null;
    const nodes = this.store.selectedNodes;
    if (this.signatureOf() !== this.signature) {
      this.rebuild();
      return;
    }
    if (nodes.length === 0) {
      for (const update of this.docSync) update();
      return;
    }
    if (this.fields.size === 0) {
      this.rebuild();
      return;
    }
    if (this.nameInput && document.activeElement !== this.nameInput) {
      this.nameInput.value = nodes.length > 1 ? "" : nodes[0]!.name;
    }

    this.syncFrameNote(nodes);

    this.suppress = true;
    const first = nodes[0]!;
    // In Animate mode the fields show what is on screen at the playhead, not
    // the bind pose — otherwise typing a value would silently jump the object.
    const at = new Map(nodes.map((n) => [n.id, transformAtFrame(this.store, n)]));
    const tfOf = (n: typeof first) => at.get(n.id) ?? n.bind;
    const firstTf = tfOf(first);
    const size = displaySize(this.store.project, first, displayAtFrame(this.store, first).index);
    const pivotOf = (n: typeof first) => displayAtFrame(this.store, n).display?.pivot ?? n.pivot;
    const set = (k: FieldKey, value: number, mixed: boolean) => {
      const f = this.fields.get(k);
      if (!f || f.focused) return;
      if (mixed) f.setMixed(); else f.set(value);
    };
    const varies = (read: (n: typeof first) => number) =>
      nodes.some((n) => Math.abs(read(n) - read(first)) > 1e-6);

    const bounds = this.isGroup(nodes) ? this.groupBounds() : null;
    if (bounds) {
      set("x", bounds.x, false);
      set("y", bounds.y, false);
      set("w", bounds.w, false);
      set("h", bounds.h, false);
    } else {
      set("x", firstTf.x, varies((n) => tfOf(n).x));
      set("y", firstTf.y, varies((n) => tfOf(n).y));
      set("w", size.w * firstTf.scaleX, nodes.length > 1);
      set("h", size.h * firstTf.scaleY, nodes.length > 1);
    }
    set("scaleX", firstTf.scaleX, varies((n) => tfOf(n).scaleX));
    set("scaleY", firstTf.scaleY, varies((n) => tfOf(n).scaleY));
    set("rotation", firstTf.skewY, varies((n) => tfOf(n).skewY));
    set("skewX", firstTf.skewX, varies((n) => tfOf(n).skewX));
    set("skewY", firstTf.skewY, varies((n) => tfOf(n).skewY));
    set("pivotX", pivotOf(first).x, varies((n) => pivotOf(n).x));
    set("pivotY", pivotOf(first).y, varies((n) => pivotOf(n).y));
    this.suppress = false;
  }

  /**
   * Opens a NumberField scrub's interaction on its FIRST step: the field
   * reports no start, and `beginInteraction` on every step closed the entry
   * each time — one undo step per pointermove.
   */
  private scrubStep(kind: string, committing: boolean): void {
    const history = this.store.history;
    if (!committing && !history.inInteraction) history.beginInteraction(kind);
  }

  private write(key: FieldKey, value: number, committing: boolean): void {
    if (this.suppress) return;
    const nodes = this.store.selectedNodes;
    if (nodes.length === 0) return;

    if (key === "pivotX" || key === "pivotY") {
      this.writePivot(key, value, committing);
      return;
    }

    const next = this.isGroup(nodes)
      ? this.groupWrite(key, value)
      : this.singleWrite(nodes, key, value);
    if (!next) return;

    if (!committing && !this.scrubbing) {
      this.store.history.beginInteraction("node.transform");
      this.scrubbing = true;
    }
    applyEdit(this.store, next, this.scrubbing);
    if (committing) {
      if (this.scrubbing) this.store.history.endInteraction();
      this.scrubbing = false;
      this.group = null;
    }
  }

  private singleWrite(nodes: Node[], key: FieldKey, value: number): Map<NodeId, Transform> {
    const next = new Map<NodeId, Transform>();
    for (const n of nodes) {
      const t = cloneTf(transformAtFrame(this.store, n));
      const size = displaySize(this.store.project, n, displayAtFrame(this.store, n).index);
      // Ratio against the value being replaced, so the partner field follows
      // proportionally rather than being set to the same number.
      const ratio = (before: number) =>
        Math.abs(before) > 1e-6 ? value / before : 1;

      switch (key) {
        case "x": t.x = value; break;
        case "y": t.y = value; break;
        case "w":
          if (size.w > 0) {
            if (this.linked.size) t.scaleY *= ratio(size.w * t.scaleX);
            t.scaleX = value / size.w;
          }
          break;
        case "h":
          if (size.h > 0) {
            if (this.linked.size) t.scaleX *= ratio(size.h * t.scaleY);
            t.scaleY = value / size.h;
          }
          break;
        case "scaleX":
          if (this.linked.scale) t.scaleY *= ratio(t.scaleX);
          t.scaleX = value || 1e-4;
          break;
        case "scaleY":
          if (this.linked.scale) t.scaleX *= ratio(t.scaleY);
          t.scaleY = value || 1e-4;
          break;
        case "rotation": {
          // Rotation moves both skew angles together, so shear is preserved.
          const shear = t.skewX - t.skewY;
          t.skewY = value;
          t.skewX = value + shear;
          break;
        }
        case "skewX": t.skewX = value; break;
        case "skewY": t.skewY = value; break;
      }
      next.set(n.id, t);
    }
    return next;
  }

  // ── The virtual group ──────────────────────────────────────────────────

  /** Several nodes, or one node shown in several frames by Edit Multiple
   *  Frames: either way more than one thing on stage answers to the fields. */
  private isGroup(nodes: Node[]): boolean {
    if (nodes.length > 1) return true;
    return editsMultipleFrames(this.store) && instancesOf(this.posesOf(), this.groupIds()).length > 1;
  }

  private groupIds(): NodeId[] {
    const sym = this.store.currentSymbol;
    return topmostSelected(
      this.store.selection.nodes.filter((id) => sym.nodes[id]),
      (id) => sym.nodes[id]?.parentId,
    );
  }

  private groupBounds(): Rect | null {
    return selectionBounds(this.store.project, this.posesOf(), this.groupIds());
  }

  private captureGroup(): GroupSnapshot | null {
    const pose = this.poseOf();
    const bounds = this.groupBounds();
    if (!pose || !bounds) return null;
    const snaps: NodeSnapshot[] = [];
    for (const id of this.groupIds()) {
      const n = this.store.node(id);
      const entry = pose.byNode.get(id);
      if (!n || !entry) continue;
      const parent = n.parentId ? pose.byNode.get(n.parentId)?.world : undefined;
      const shown = displayAtFrame(this.store, n);
      snaps.push(snapshotOf(
        id, transformAtFrame(this.store, n), entry.world, parent, shown.display?.pivot ?? n.pivot, shown.index,
      ));
    }
    const first = this.store.selectedNodes[0];
    if (!snaps.length || !first) return null;
    return { bounds, snaps, first: transformAtFrame(this.store, first) };
  }

  /**
   * One write to the group. Position and size are the bounding box: X moves
   * everything by the difference, W scales everything from the box's left
   * edge. Rotate, Scale and Skew are the FIRST node's values, reached by
   * turning or scaling the whole group about the box's centre — so a
   * selection of differently rotated objects keeps its arrangement instead of
   * being flattened to one angle.
   */
  private groupWrite(key: FieldKey, value: number): Map<NodeId, Transform> | null {
    this.group ??= this.captureGroup();
    const g = this.group;
    if (!g) return null;
    const b = g.bounds;
    const centre = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const ratio = (before: number) => (Math.abs(before) > 1e-6 ? value / before : 1);
    const next = new Map<NodeId, Transform>();
    const each = (fn: (s: NodeSnapshot) => Transform) => {
      for (const s of g.snaps) next.set(s.id, fn(s));
    };

    switch (key) {
      case "x": each((s) => moveBy(s, value - b.x, 0)); break;
      case "y": each((s) => moveBy(s, 0, value - b.y)); break;
      case "w":
      case "h": {
        const sx = key === "w" ? ratio(b.w) : this.linked.size ? ratio(b.h) : 1;
        const sy = key === "h" ? ratio(b.h) : this.linked.size ? ratio(b.w) : 1;
        const m = worldScaleMatrix({ x: b.x, y: b.y }, sx || 1e-4, sy || 1e-4);
        each((s) => applyWorldMatrix(s, m));
        break;
      }
      case "scaleX":
      case "scaleY": {
        const sx = key === "scaleX" ? ratio(g.first.scaleX) : this.linked.scale ? ratio(g.first.scaleY) : 1;
        const sy = key === "scaleY" ? ratio(g.first.scaleY) : this.linked.scale ? ratio(g.first.scaleX) : 1;
        const m = worldScaleMatrix(centre, sx || 1e-4, sy || 1e-4);
        each((s) => applyWorldMatrix(s, m));
        break;
      }
      case "rotation":
        each((s) => rotateAbout(s, centre, value - g.first.skewY));
        break;
      case "skewX":
      case "skewY": {
        const delta = value - (key === "skewX" ? g.first.skewX : g.first.skewY);
        each((s) => ({ ...cloneTf(s.local), [key]: s.local[key] + delta }));
        break;
      }
      default:
        return null;
    }
    return next;
  }

  /**
   * Setting the transform point numerically must behave exactly like dragging
   * it: the point moves, the artwork does not. That needs the node's world
   * matrix, which is why the panel is handed a pose provider.
   */
  private writePivot(key: "pivotX" | "pivotY", value: number, committing: boolean): void {
    const pivots = new Map<NodeId, { x: number; y: number }>();
    const displays = new Map<NodeId, number>();
    for (const n of this.store.selectedNodes) {
      const shown = displayAtFrame(this.store, n);
      const pivot = shown.display?.pivot ?? n.pivot;
      pivots.set(n.id, {
        x: key === "pivotX" ? value : pivot.x,
        y: key === "pivotY" ? value : pivot.y,
      });
      displays.set(n.id, shown.index);
    }
    if (pivots.size === 0) return;

    this.scrubStep("node.pivot", committing);
    // The command does the compensation, on the bind pose and on every
    // keyframe, so the artwork stays put whatever mode we are in.
    this.store.apply(new SetPivot(this.store.currentSymbolId, pivots, { displays }));
    if (committing) this.store.history.endInteraction();
  }
}

const LINK_KEY = "animo.props.linked";

function loadLinked(key: "size" | "scale" | "stage"): boolean {
  try {
    const raw = localStorage.getItem(LINK_KEY);
    return raw ? !!(JSON.parse(raw) as Record<string, boolean>)[key] : false;
  } catch { return false; }
}

function saveLinked(key: "size" | "scale" | "stage", value: boolean): void {
  try {
    const raw = localStorage.getItem(LINK_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    all[key] = value;
    localStorage.setItem(LINK_KEY, JSON.stringify(all));
  } catch { /* private mode */ }
}

/* ── Colour effect helpers ───────────────────────────────────────────────*/

type ColorMode = "none" | "alpha" | "brightness" | "tint" | "advanced";

/** Which view of a ColorTransform best explains the value already stored. */
function deriveColorMode(c: ColorTransform, isInstance: boolean): ColorMode {
  if (isDefaultColor(c)) return "none";
  const grey = c.rM === c.gM && c.gM === c.bM;
  if (c.rM === 100 && grey) return "alpha";
  if (isInstance) return "alpha";
  if (c.aM === 100 && grey) return "brightness";
  return "advanced";
}

function colorToHex(c: ColorTransform): string {
  const ch = (v: number) =>
    Math.max(0, Math.min(255, Math.round((v / 100) * 255))).toString(16).padStart(2, "0");
  return `#${ch(c.rM)}${ch(c.gM)}${ch(c.bM)}`;
}

function hexToPct(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  const pc = (v: number) => Math.round((v / 255) * 100);
  return { r: pc((n >> 16) & 255), g: pc((n >> 8) & 255), b: pc(n & 255) };
}

/** Only the modes `PixiSlot._updateBlendMode` actually applies. */
const BLEND_MODES: Array<[BlendMode, string]> = [
  ["normal", "Normal"],
  ["add", "Add"],
  ["multiply", "Multiply"],
  ["screen", "Screen"],
  ["overlay", "Overlay"],
  ["darken", "Darken"],
  ["lighten", "Lighten"],
  ["difference", "Difference"],
  ["hardlight", "Hard Light"],
];
