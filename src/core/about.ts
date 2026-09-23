/**
 * Who made this, what it stands on, and under what licence, as data.
 *
 * Pure, like the rest of `core/`: the About dialog renders it, and the same
 * table is what a THIRD-PARTY-NOTICES file has to agree with. Keeping it here
 * rather than in the dialog means a test can check it, and means the next
 * thing that needs to print the credits (an Electron About panel, a build
 * banner) does not have to reach into `view/`.
 */

export const APP_NAME = "Animo";
export const APP_TAGLINE = "A Flash-style animation editor that exports DragonBones";

/**
 * Replaced at build time by `define` in vite.config.ts. `typeof` rather than a
 * plain read: vitest runs its own config and never substitutes the token, and
 * an undeclared identifier throws on read but is safe to `typeof`.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

export const AUTHOR = "Morenoise";
export const AUTHOR_URL = "https://morenoise.it";
export const REPO_URL = "https://github.com/justmorenoise/animo";
export const SITE_URL = "https://morenoise.it/en/apps/animo";
export const SPONSOR_URL = "https://github.com/sponsors/justmorenoise";

export const LICENSE_ID = "AGPL-3.0-or-later";

/**
 * The one sentence that keeps the licence usable.
 *
 * The exporter copies `animo-pixi.js` into the zip and it ships inside the
 * games people make; AGPL there would reach their code. So the runtime file
 * and everything the exporter writes are carved out. See LICENSE-EXCEPTION.md.
 */
export const LICENSE_NOTE =
  "Animo is free software, released under the GNU AGPL v3 or later. What you "
  + "export is yours: the exported files, including the runtime file for the "
  + "extensions, are under the MIT license and can go into any game, commercial "
  + "or not.";

export const TRADEMARK_NOTE =
  "DragonBones is a trademark of Egret Technology. PixiJS is a trademark of its "
  + "owners. Animo is an independent project, not affiliated with either.";

/** How the editor relates to the runtime it exports for. */
export const DRAGONBONES_NOTE =
  "Animo saves animations in the DragonBones 5.5 format, so they play in any "
  + "engine with a DragonBones runtime. The Preview panel and Play mode run the "
  + "real DragonBones runtime on the exported files: what you see there is what "
  + "your game will show.";

/** The two features the format cannot carry, and how they reach a game. */
export const PIXI_NOTE =
  "Mask layers and motion blur go beyond what the DragonBones format can "
  + "describe. The export saves them in an extra file and adds a small runtime "
  + "for PixiJS 8 that applies them. Both are added only when the project uses "
  + "these features.";

export interface Credit {
  name: string;
  /** Omitted where the version is not pinned by us. */
  version?: string;
  license: string;
  url: string;
  /** What it does here, in one line. */
  what: string;
}

export const CREDITS: readonly Credit[] = Object.freeze([
  {
    name: "DragonBones",
    version: "5.7.000",
    license: "MIT",
    url: "https://github.com/DragonBones/DragonBonesJS",
    what: "The animation runtime. Included so the Preview plays your animation for real.",
  },
  {
    name: "PixiJS",
    version: "8.9.2",
    license: "MIT",
    url: "https://pixijs.com",
    what: "Draws the Preview. The runtime extensions are written for it.",
  },
  {
    name: "ag-psd",
    license: "MIT",
    url: "https://github.com/Agamnentzar/ag-psd",
    what: "Reads Photoshop files for PSD import.",
  },
  {
    name: "fflate",
    license: "MIT",
    url: "https://github.com/101arrowz/fflate",
    what: "Compresses project files and exports.",
  },
  {
    name: "pako",
    license: "MIT AND Zlib",
    url: "https://github.com/nodeca/pako",
    what: "Decompresses PSD data for ag-psd.",
  },
  {
    name: "Vite, TypeScript, Vitest",
    license: "MIT / Apache-2.0",
    url: "https://vite.dev",
    what: "Build and test tools. Not part of the app.",
  },
]);
