import { strFromU8 } from "fflate";
import { asArr, asObj, bool, num, str } from "@/core/doc/dbTimeline";
import { DbImportError } from "@/core/doc/dbImport";
import { type AtlasRegion, type Cut, regionCut, shownSize } from "@/core/atlas/region";
import { cutRegions, expandFiles } from "./atlasCut";

/**
 * The files of a DragonBones project, as a user hands them over: a zip (what
 * Animo and DragonBones Pro export), or the loose files — `_ske.json`, one or
 * more `_tex.json` and their pages. Files are told apart by what they hold,
 * not by their names: a skeleton has `armature`, an atlas `SubTexture`,
 * Animo's extension manifest `format: "animo-extensions"`.
 *
 * Every SubTexture is cut out of its page back to the image it was packed
 * from: untrimmed, unrotated, at full size. Decoding and encoding run off the
 * page (`createImageBitmap`, `convertToBlob`); only the copy of each region
 * is drawn here, which is quick.
 */

export interface DbFiles {
  name: string;
  skeleton: unknown;
  extensions?: unknown;
  images: Array<{ name: string; blob: Blob; width: number; height: number }>;
  warnings: string[];
}

/**
 * A SubTexture as an `AtlasRegion`: its trim (`frameX/Y` are the NEGATIVE of
 * the offset, as the exporter writes them). A `rotated` region is stored
 * turned 90° clockwise, its `width` and `height` as on the page — the Starling
 * convention DragonBones comes from.
 */
export function subTextureRegion(st: Record<string, unknown>, page: string): AtlasRegion {
  const r: AtlasRegion = {
    name: str(st.name), page,
    x: num(st.x, 0), y: num(st.y, 0), w: num(st.width, 0), h: num(st.height, 0),
    rotation: bool(st.rotated, false) ? 90 : 0,
    offsetX: -num(st.frameX, 0), offsetY: -num(st.frameY, 0), width: 0, height: 0,
  };
  const shown = shownSize(r);
  r.width = num(st.frameWidth, 0) > 0 ? num(st.frameWidth, 0) : shown.w;
  r.height = num(st.frameHeight, 0) > 0 ? num(st.frameHeight, 0) : shown.h;
  return r;
}

/** The region and the atlas `scale` (a texture stored at half size has scale 0.5, and the runtime draws it at twice that). */
export function subTextureCut(st: Record<string, unknown>, scale: number): Cut {
  return regionCut(subTextureRegion(st, ""), scale);
}

const baseName = (path: string) => path.split("/").pop()!;

/** Which file is which, by content. Pure, so the rules can be tested without a browser. */
export function sortDbFiles(entries: Map<string, Uint8Array>): {
  skeleton: { path: string; json: Record<string, unknown> };
  atlases: Array<{ path: string; json: Record<string, unknown> }>;
  extensions?: unknown;
  pngs: Map<string, Uint8Array>;
} {
  let skeleton: { path: string; json: Record<string, unknown> } | null = null;
  const atlases: Array<{ path: string; json: Record<string, unknown> }> = [];
  let extensions: unknown;
  const pngs = new Map<string, Uint8Array>();
  for (const [path, bytes] of entries) {
    if (/\.dbbin$/i.test(path)) throw new DbImportError("Binary DragonBones files (.dbbin) are not supported: export the project as JSON.");
    if (/\.png$/i.test(path)) { pngs.set(path, bytes); continue; }
    if (!/\.json$/i.test(path)) continue;
    let json: Record<string, unknown> | null;
    try { json = asObj(JSON.parse(strFromU8(bytes).replace(/^\uFEFF/, ""))); } catch { continue; }
    if (!json) continue;
    if (Array.isArray(json.armature)) {
      // Two skeletons: the `_ske.json` one, else the first.
      if (!skeleton || (/_ske\.json$/i.test(path) && !/_ske\.json$/i.test(skeleton.path))) skeleton = { path, json };
    } else if (Array.isArray(json.SubTexture)) atlases.push({ path, json });
    else if (json.format === "animo-extensions") extensions = json;
  }
  if (!skeleton) throw new DbImportError("No DragonBones skeleton among these files: choose the _ske.json, its _tex.json and its PNG, or the zip holding them.");
  return { skeleton, atlases, extensions, pngs };
}

export async function readDbFiles(files: File[], onProgress: (fraction: number) => void = () => {}): Promise<DbFiles> {
  const sorted = sortDbFiles(await expandFiles(files));
  const warnings: string[] = [];
  if (!sorted.atlases.length) warnings.push("No texture atlas (_tex.json) came with the skeleton: every image is missing.");

  const rotated: string[] = [];
  const pages = new Map<string, Blob>();
  const scales = new Map<string, number>();
  const regions: AtlasRegion[] = [];
  for (const atlas of sorted.atlases) {
    const imagePath = str(atlas.json.imagePath);
    const page = [...sorted.pngs].find(([p]) => baseName(p) === baseName(imagePath))
      ?? (sorted.pngs.size === 1 && sorted.atlases.length === 1 ? [...sorted.pngs][0] : undefined);
    if (!page) { warnings.push(`The atlas page "${imagePath}" is missing: its images are left out.`); continue; }
    const scale = num(atlas.json.scale, 1);
    if (scale !== 1) warnings.push(`"${imagePath}" stores its images at ${Math.round(scale * 100)}%: they are scaled back to full size and will look soft.`);
    pages.set(page[0], new Blob([page[1] as BlobPart], { type: "image/png" }));
    scales.set(page[0], scale);
    for (const raw of asArr(atlas.json.SubTexture)) {
      const st = asObj(raw);
      if (!st || !str(st.name)) continue;
      if (bool(st.rotated, false)) rotated.push(str(st.name));
      regions.push(subTextureRegion(st, page[0]));
    }
  }
  const images = await cutRegions(pages, regions, (p) => scales.get(p) ?? 1, onProgress);
  if (rotated.length) warnings.push(`${rotated.map((n) => `"${n}"`).join(", ")} ${rotated.length === 1 ? "is" : "are"} stored rotated in the atlas and turned back: check that ${rotated.length === 1 ? "it reads" : "they read"} the right way up.`);
  const name = str(sorted.skeleton.json.name) || baseName(sorted.skeleton.path).replace(/(_ske)?\.json$/i, "");
  return { name, skeleton: sorted.skeleton.json, extensions: sorted.extensions, images, warnings };
}
