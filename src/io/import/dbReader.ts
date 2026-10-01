import { strFromU8 } from "fflate";
import { unzipFiles } from "@/io/zip";
import { asArr, asObj, num, str } from "@/core/doc/dbTimeline";
import { DbImportError } from "@/core/doc/dbImport";

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

/** Where a SubTexture's pixels go in the image it was packed from. */
export interface Cut {
  /** The image: the untrimmed frame at full size. */
  width: number;
  height: number;
  /** The region on the page. */
  src: { x: number; y: number; w: number; h: number };
  /** `setTransform` for drawing the region at (0, 0, w, h). */
  m: [number, number, number, number, number, number];
}

/**
 * The region, its trim (`frameX/Y` are the NEGATIVE of the offset, as the
 * exporter writes them) and the atlas `scale` (a texture stored at half size
 * has scale 0.5, and the runtime draws it at twice that). A `rotated` region
 * is stored turned 90° clockwise, its `width` and `height` as on the page —
 * the Starling convention DragonBones comes from.
 */
export function subTextureCut(st: Record<string, unknown>, scale: number): Cut {
  const x = num(st.x, 0), y = num(st.y, 0), w = num(st.width, 0), h = num(st.height, 0);
  const rotated = st.rotated === true;
  const shownW = rotated ? h : w, shownH = rotated ? w : h;
  const fx = num(st.frameX, 0), fy = num(st.frameY, 0);
  const k = scale > 0 ? 1 / scale : 1;
  const frameW = num(st.frameWidth, 0) > 0 ? num(st.frameWidth, 0) : shownW;
  const frameH = num(st.frameHeight, 0) > 0 ? num(st.frameHeight, 0) : shownH;
  const m: Cut["m"] = rotated
    ? [0, -k, k, 0, -fx * k, (shownH - fy) * k]
    : [k, 0, 0, k, -fx * k, -fy * k];
  return { width: Math.max(1, Math.round(frameW * k)), height: Math.max(1, Math.round(frameH * k)), src: { x, y, w, h }, m };
}

/** Each file as a path and its bytes, zips opened. */
async function expand(files: File[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (/\.zip$/i.test(f.name)) {
      for (const [path, data] of Object.entries(await unzipFiles(bytes))) if (!path.endsWith("/")) out.set(path, data);
    } else {
      out.set(f.name, bytes);
    }
  }
  return out;
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
  const sorted = sortDbFiles(await expand(files));
  const warnings: string[] = [];
  const images: DbFiles["images"] = [];
  const total = Math.max(1, sorted.atlases.reduce((n, a) => n + asArr(a.json.SubTexture).length, 0));
  if (!sorted.atlases.length) warnings.push("No texture atlas (_tex.json) came with the skeleton: every image is missing.");

  const rotated: string[] = [];
  for (const atlas of sorted.atlases) {
    const imagePath = str(atlas.json.imagePath);
    const page = [...sorted.pngs].find(([p]) => baseName(p) === baseName(imagePath))
      ?? (sorted.pngs.size === 1 && sorted.atlases.length === 1 ? [...sorted.pngs][0] : undefined);
    if (!page) { warnings.push(`The atlas page "${imagePath}" is missing: its images are left out.`); continue; }
    const scale = num(atlas.json.scale, 1);
    if (scale !== 1) warnings.push(`"${imagePath}" stores its images at ${Math.round(scale * 100)}%: they are scaled back to full size and will look soft.`);
    const bitmap = await createImageBitmap(new Blob([page[1] as BlobPart], { type: "image/png" }));
    try {
      for (const raw of asArr(atlas.json.SubTexture)) {
        const st = asObj(raw);
        if (!st || !str(st.name)) continue;
        if (st.rotated === true) rotated.push(str(st.name));
        const cut = subTextureCut(st, scale);
        const canvas = new OffscreenCanvas(cut.width, cut.height);
        const ctx = canvas.getContext("2d")!;
        ctx.setTransform(...cut.m);
        ctx.drawImage(bitmap, cut.src.x, cut.src.y, cut.src.w, cut.src.h, 0, 0, cut.src.w, cut.src.h);
        images.push({ name: str(st.name), blob: await canvas.convertToBlob({ type: "image/png" }), width: cut.width, height: cut.height });
        onProgress(images.length / total);
      }
    } finally {
      bitmap.close();
    }
  }
  if (rotated.length) warnings.push(`${rotated.map((n) => `"${n}"`).join(", ")} ${rotated.length === 1 ? "is" : "are"} stored rotated in the atlas and turned back: check that ${rotated.length === 1 ? "it reads" : "they read"} the right way up.`);
  const name = str(sorted.skeleton.json.name) || baseName(sorted.skeleton.path).replace(/(_ske)?\.json$/i, "");
  return { name, skeleton: sorted.skeleton.json, extensions: sorted.extensions, images, warnings };
}
