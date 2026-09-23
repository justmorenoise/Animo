import { strFromU8, strToU8 } from "fflate";
import { unzipFiles, zipFiles } from "@/io/zip";
import type { Project } from "@/core/doc/types";
import { isImage } from "@/core/doc/types";
import type { AssetId } from "@/core/doc/ids";
import type { AssetStore } from "@/app/AssetStore";
import { type Diagnostic, migrate, validateProject } from "@/core/doc/schema";

export const PROJECT_EXTENSION = "animo";

interface Manifest {
  /** assetId -> file name inside the archive. */
  assets: Record<string, string>;
}

export interface LoadedProject {
  project: Project;
  diagnostics: Diagnostic[];
}

/**
 * A `.animo` is a zip:
 *
 *   project.json      the document
 *   manifest.json     assetId -> archive path
 *   assets/<id>.png   the binaries
 *
 * Images live as real files rather than base64 inside the JSON: the document
 * stays readable and diffable, and a project with a few megabytes of art does
 * not become a JSON blob that no tool wants to open.
 */
export async function serializeProject(project: Project, assets: AssetStore): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const manifest: Manifest = { assets: {} };

  // Only assets the document actually references — importing and deleting
  // should not leave weight behind in every future save.
  // Taken before the first await: an edit landing while the images are read
  // must not reach a project.json whose image list was already fixed.
  const json = JSON.stringify(project, null, 2);
  const used = new Set<AssetId>();
  for (const item of Object.values(project.items)) {
    if (isImage(item)) used.add(item.assetId);
  }

  for (const id of used) {
    const asset = assets.get(id);
    if (!asset) continue;
    const path = `assets/${id}.png`;
    files[path] = new Uint8Array(await asset.blob.arrayBuffer());
    manifest.assets[id] = path;
  }

  files["project.json"] = strToU8(json);
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

  const zipped = await zipFiles(files);
  return new Blob([zipped as unknown as BlobPart], { type: "application/zip" });
}

export async function deserializeProject(
  data: ArrayBuffer, assets: AssetStore,
  /** 0..1 as the images are decoded, which is most of the time a load takes. */
  onProgress: (fraction: number) => void = () => {},
): Promise<LoadedProject> {
  const entries = await unzipFiles(new Uint8Array(data));

  const projectRaw = entries["project.json"];
  if (!projectRaw) {
    throw new Error("This does not look like a project file: project.json is missing.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(projectRaw));
  } catch (err) {
    throw new Error(`project.json is not valid JSON: ${(err as Error).message}`);
  }

  const { project, diagnostics } = validateProject(migrate(parsed));

  // Restore assets under their original ids, so node references still resolve.
  const manifestRaw = entries["manifest.json"];
  const manifest: Manifest = manifestRaw
    ? (JSON.parse(strFromU8(manifestRaw)) as Manifest)
    : { assets: {} };

  assets.clear();
  const listed = Object.entries(manifest.assets);
  let decoded = 0;
  for (const [id, path] of listed) {
    onProgress(decoded++ / listed.length);
    const bytes = entries[path];
    if (!bytes) {
      diagnostics.push({
        path: `assets.${id}`,
        message: `"${path}" is missing from the archive; images using it will not draw`,
        severity: "warning",
      });
      continue;
    }
    const blob = new Blob([bytes as unknown as BlobPart], { type: "image/png" });
    const name = Object.values(project.items).find(
      (i) => isImage(i) && i.assetId === id,
    )?.name ?? id;
    try {
      await assets.addWithId(id as AssetId, blob, name);
    } catch {
      diagnostics.push({
        path: `assets.${id}`,
        message: `"${name}" could not be decoded and was skipped`,
        severity: "warning",
      });
    }
  }

  return { project, diagnostics };
}
