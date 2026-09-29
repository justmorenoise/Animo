import { perf } from "@/app/perf";
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
/** Images decoded side by side when a file is opened. */
export const RESTORE_PARALLEL = 6;

export interface SerializeOptions {
  /** Indent `project.json`. A file the user keeps stays readable and diffable;
   *  an autosave is read once by the editor, and the indent is most of its
   *  size and time. */
  pretty?: boolean;
}

export function serializeProject(
  project: Project, assets: AssetStore, opts: SerializeOptions = {},
): Promise<Blob> {
  return perf.measureAsync("project.serialize", () => serializeUntimed(project, assets, opts.pretty ?? true));
}

async function serializeUntimed(project: Project, assets: AssetStore, pretty: boolean): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const manifest: Manifest = { assets: {} };

  // Only assets the document actually references — importing and deleting
  // should not leave weight behind in every future save.
  // Taken before the first await: an edit landing while the images are read
  // must not reach a project.json whose image list was already fixed.
  const json = perf.measure("project.serialize.json", () => JSON.stringify(project, null, pretty ? 2 : undefined));
  const used = new Set<AssetId>();
  for (const item of Object.values(project.items)) {
    if (isImage(item)) used.add(item.assetId);
  }

  // Read side by side: the blobs are independent and each read is asynchronous.
  const present = [...used].filter((id) => assets.get(id));
  const bytes = await Promise.all(present.map(async (id) => new Uint8Array(await assets.get(id)!.blob.arrayBuffer())));
  present.forEach((id, i) => {
    const path = `assets/${id}.png`;
    files[path] = bytes[i]!;
    manifest.assets[id] = path;
  });

  files["project.json"] = strToU8(json);
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

  const zipped = await perf.measureAsync("project.serialize.zip", () => zipFiles(files));
  return new Blob([zipped as unknown as BlobPart], { type: "application/zip" });
}

export function deserializeProject(
  data: ArrayBuffer, assets: AssetStore,
  /** 0..1 as the images are decoded, which is most of the time a load takes. */
  onProgress: (fraction: number) => void = () => {},
): Promise<LoadedProject> {
  return perf.measureAsync("project.deserialize", () => deserializeUntimed(data, assets, onProgress));
}

async function deserializeUntimed(
  data: ArrayBuffer, assets: AssetStore, onProgress: (fraction: number) => void,
): Promise<LoadedProject> {
  const entries = await perf.measureAsync("project.deserialize.unzip", () => unzipFiles(new Uint8Array(data)));

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
  const names = new Map<string, string>();
  for (const item of Object.values(project.items)) {
    if (isImage(item) && !names.has(item.assetId)) names.set(item.assetId, item.name);
  }

  // Decoding and hashing are asynchronous and independent, so a few run side
  // by side. Their diagnostics are kept in manifest order: which warning comes
  // first should not depend on which image decoded first.
  const problems: Array<Diagnostic | null> = listed.map(() => null);
  let started = 0;
  let finished = 0;
  const assetsStart = performance.now();
  const restore = async (): Promise<void> => {
    while (started < listed.length) {
      const at = started++;
      const [id, path] = listed[at]!;
      onProgress(finished / listed.length);
      const bytes = entries[path];
      if (!bytes) {
        problems[at] = {
          path: `assets.${id}`,
          message: `"${path}" is missing from the archive; images using it will not draw`,
          severity: "warning",
        };
      } else {
        const blob = new Blob([bytes as unknown as BlobPart], { type: "image/png" });
        const name = names.get(id) ?? id;
        try {
          await assets.addWithId(id as AssetId, blob, name);
        } catch {
          problems[at] = {
            path: `assets.${id}`,
            message: `"${name}" could not be decoded and was skipped`,
            severity: "warning",
          };
        }
      }
      onProgress(++finished / listed.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RESTORE_PARALLEL, listed.length) }, restore));
  for (const problem of problems) if (problem) diagnostics.push(problem);

  perf.record("project.deserialize.assets", performance.now() - assetsStart);
  return { project, diagnostics };
}
