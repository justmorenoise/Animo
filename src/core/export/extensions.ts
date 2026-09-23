import type { Project } from "@/core/doc/types";
import type { ExtensionManifest } from "@/runtime/animo-pixi";
import type { SkeletonResult } from "./exportSkeleton";

/**
 * Everything the skeleton cannot carry, as one manifest.
 *
 * The data describes INTENT, not a Pixi implementation: motion blur is a
 * shutter angle, not a filter setup. A video or spritesheet export can then
 * honour the same manifest exactly (temporal supersampling), and a runtime
 * other than Pixi can implement the same extension names.
 */

export const EXT_MASKS = "ANIMO_masks";
export const EXT_MOTION_BLUR = "ANIMO_motion_blur";

/** Trails shorter than this, in armature pixels, are not worth a filter pass. */
export const MOTION_BLUR_THRESHOLD = 0.5;

/** Null when the project needs nothing beyond the stock skeleton. */
export function buildExtensionManifest(
  project: Project, result: Pick<SkeletonResult, "masks" | "motionBlurSlots">,
): ExtensionManifest | null {
  const manifest: ExtensionManifest = {
    format: "animo-extensions",
    version: 1,
    extensionsUsed: [],
    extensionsRequired: [],
    extensions: {},
  };

  if (result.masks.length > 0) {
    manifest.extensionsUsed.push(EXT_MASKS);
    // Required for THIS export, not required of every project: it is only listed
    // when the document has masks, and without the clip what should be hidden is
    // drawn, which is wrong rather than poorer.
    manifest.extensionsRequired.push(EXT_MASKS);
    manifest.extensions.ANIMO_masks = { version: 1, masks: result.masks };
  }

  const mb = project.motionBlur;
  if (mb?.enabled && mb.shutter > 0) {
    manifest.extensionsUsed.push(EXT_MOTION_BLUR);
    manifest.extensions.ANIMO_motion_blur = {
      version: 1,
      shutter: mb.shutter,
      maxLength: mb.maxLength,
      threshold: MOTION_BLUR_THRESHOLD,
      slots: result.motionBlurSlots,
    };
  }

  return manifest.extensionsUsed.length > 0 ? manifest : null;
}

export const RUNTIME_FILE = "animo-pixi.js";

/**
 * What each extension is, in words a user of the app can act on.
 *
 * One table, read by the README in the zip AND by the Help dialog, so the
 * two cannot drift. Pure data: `core/` never touches the DOM.
 */
export interface ExtensionDoc {
  /** "Mask layers": a name, not the identifier. */
  title: string;
  /** The one-liner the README lists it by. */
  short: string;
  /** What it is and why the format cannot carry it. */
  what: string[];
  /** What a player without the extension does instead. */
  without: string;
  required: boolean;
}

export const EXTENSION_DOCS: Record<string, ExtensionDoc> = {
  [EXT_MASKS]: {
    title: "Mask layers",
    short:
      "Mask layers. Without it a player draws the hidden artwork, and the mask shape on top.",
    required: true,
    what: [
      "A mask layer decides which part of the layers linked to it is visible: only "
      + "what falls inside the mask's artwork is drawn. Transparency counts, so where "
      + "the mask is half transparent the artwork is half visible, and a soft edge or "
      + "a gradient mask works as expected.",
      "The DragonBones format has no masks (its \"bone mask\" is something else, a way "
      + "to blend animations). Animo writes the masks to a separate file next to the "
      + "skeleton, and the runtime file included in the export applies them in PixiJS.",
      "A mask can be drawn in any colour. Pixi would treat a black mask as empty, so "
      + "the runtime turns each mask white before using it and keeps its transparency. "
      + "The mask itself is never visible.",
    ],
    without:
      "The artwork that should be hidden shows, and the mask artwork is drawn on top of "
      + "it. The animation looks broken.",
  },
  [EXT_MOTION_BLUR]: {
    title: "Motion blur",
    short: "Motion blur, adjustable per layer. WebGL renderer only.",
    required: false,
    what: [
      "Motion blur smears each piece of artwork along the path it moved since the "
      + "previous frame, rotation included, so fast movement looks smoother. A foot "
      + "swinging from the ankle blurs at the toe, not at the joint.",
      "The blur is set for the whole document (Shutter and Max trail, under "
      + "Document) and then per layer (under Color Effect), so a fast arm can blur "
      + "while the rest stays sharp.",
      "The export stores these settings, not a Pixi filter, so another runtime or a "
      + "video export can reproduce the same effect. The blur follows the animation's "
      + "own time: a paused animation is sharp, and the result does not depend on the "
      + "screen's refresh rate. In Pixi it is a WebGL filter, skipped with the WebGPU "
      + "renderer.",
    ],
    without: "The animation plays normally, without the blur.",
  },
};

/** How a game wires the extensions in. Shared by the README and the Help dialog. */
export function extensionSnippet(fileBase = "<name>", armature = "<armature>"): string {
  return `import { installExtensions } from "./${RUNTIME_FILE}";

const factory = dragonBones.PixiFactory.factory;
factory.parseDragonBonesData(skeletonJson);          // ${fileBase}_ske.json
factory.parseTextureAtlasData(atlasJson, atlasTexture);

const display = factory.buildArmatureDisplay("${armature}");
app.stage.addChild(display);

// extJson is ${fileBase}_ext.json, loaded as plain JSON.
const extensions = installExtensions(display, extJson, { PIXI, ticker: PIXI.Ticker.shared });
display.animation.play();

// When the armature is removed:
extensions.destroy();`;
}

/** The README shipped in the zip: what is needed, and the one way to wire it. */
export function extensionReadme(fileBase: string, armature: string, manifest: ExtensionManifest): string {
  const required = manifest.extensionsUsed.filter((n) => manifest.extensionsRequired.includes(n));
  const optional = manifest.extensionsUsed.filter((n) => !manifest.extensionsRequired.includes(n));
  const list = (names: string[]) =>
    names.length ? names.map((n) => `- \`${n}\`: ${EXTENSION_DOCS[n]?.short ?? ""}`).join("\n") : "- none";

  return `# ${fileBase}

Exported by Animo as DragonBones 5.5 data, plus the features the
DragonBones format cannot describe (the extensions).

| File | Purpose |
|---|---|
| \`${fileBase}_ske.json\`, \`${fileBase}_tex*.json\`, \`${fileBase}_tex*.png\` (or \`.webp\`) | Standard DragonBones files: any DragonBones runtime loads them |
| \`${fileBase}_ext.json\` | The extensions used by this animation |
| \`${RUNTIME_FILE}\` | Applies the extensions in PixiJS 8 (ES module, no dependencies) |

## Required extensions

Without these the animation does not look as designed.

${list(required)}

## Optional extensions

Without these the animation still plays correctly, with less detail.

${list(optional)}

## PixiJS 8

\`\`\`js
${extensionSnippet(fileBase, armature)}
\`\`\`

Pass as \`ticker\` the one that advances DragonBones (\`PIXI.Ticker.shared\`
by default). The extensions run on it at LOW priority, after the armature has
been posed. If you advance DragonBones yourself
(\`PixiFactory.useSharedTicker = false\`), leave \`ticker\` out and call
\`extensions.update(dt)\` right after \`PixiFactory.advanceTime(dt)\`, with the
same \`dt\` in seconds.

\`extensions.missing\` lists the extensions in the file that this runtime does
not know.

## Other runtimes

\`${fileBase}_ext.json\` is plain JSON and the extension names are stable, so
another runtime (Phaser, Cocos, Unity) can implement the same extensions.
`;
}
