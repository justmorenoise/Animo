import { strToU8 } from "fflate";
import { zipFiles } from "@/io/zip";
import type { Project } from "@/core/doc/types";
import { type ImageItem, isImage } from "@/core/doc/types";
import type { AssetStore } from "@/app/AssetStore";
import { type ExportDiagnostic, exportSkeleton } from "@/core/export/exportSkeleton";
import { type AtlasOptions, atlasOptionsFor, type AtlasPage, buildAtlas } from "@/io/atlas/AtlasBuilder";
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from "@/core/export/settings";
import type { DbSkeleton } from "@/core/export/dbTypes";
import type { ExtensionManifest } from "@/runtime/animo-pixi";
import { buildExtensionManifest, extensionReadme, RUNTIME_FILE, } from "@/core/export/extensions";
// The runtime ships verbatim next to the skeleton, so it is read as text from
// the one place it is authored — the same module the preview runs.
import runtimeSource from "@/runtime/animo-pixi.js?raw";

export interface ExportResult {
  fileBase: string;
  skeleton: DbSkeleton;
  pages: AtlasPage[];
  diagnostics: ExportDiagnostic[];
  /** Null when nothing needs an extension, so the common bundle is unchanged. */
  extensions: ExtensionManifest | null;
  /** Write the JSON files without indentation. */
  minifyJson?: boolean;
}

/**
 * Produces everything a DragonBones runtime needs: `<name>_ske.json`,
 * one `<name>_tex.json` + `<name>_tex.png` (or `.webp`) per atlas page, as the
 * document's export settings ask.
 */
export async function buildExport(
  project: Project,
  assets: AssetStore,
  opts: AtlasOptions = atlasOptionsFor(exportSettingsOf(project)),
  onProgress?: (fraction: number) => void,
): Promise<ExportResult> {
  const exported = exportSkeleton(project);
  const { skeleton, diagnostics, usedImages } = exported;

  const items = usedImages
    .map((id) => project.items[id])
    .filter((i): i is ImageItem => isImage(i));

  // Before the atlas await, like the skeleton: an edit made while the pages
  // render must not give the manifest a different document than the skeleton.
  const extensions = buildExtensionManifest(project, exported);

  const fileBase = safeFileName(project.name);
  // The atlas `name` must match the skeleton `name`, or the factory will not
  // pair them and the armature builds with no textures at all.
  const pages = await buildAtlas(items, assets, skeleton.name, fileBase, opts, onProgress);

  if (items.length === 0) {
    diagnostics.push({
      severity: "warning",
      message: "No images are used on the stage, so the atlas is empty.",
    });
  }

  if (extensions) {
    const required = extensions.extensionsUsed.filter((n) => extensions.extensionsRequired.includes(n));
    const optional = extensions.extensionsUsed.filter((n) => !extensions.extensionsRequired.includes(n));
    if (required.length) {
      diagnostics.push({
        severity: "warning",
        message:
          `Required extensions: ${required.join(", ")}. A standard DragonBones player does not show ` +
          `this animation as designed: load ${RUNTIME_FILE} too (README.md in the export explains how).`,
      });
    }
    if (optional.length) {
      diagnostics.push({
        severity: "warning",
        message:
          `Optional extensions: ${optional.join(", ")}. Without ${RUNTIME_FILE} the animation ` +
          `still plays correctly, without them.`,
      });
    }
  }

  return { fileBase, skeleton, pages, diagnostics, extensions, minifyJson: exportSettingsOf(project).minifyJson };
}

/** The document's export settings, the defaults when it has none. */
export function exportSettingsOf(project: Project): ExportSettings {
  return project.exportSettings ?? { ...DEFAULT_EXPORT_SETTINGS };
}

/** Canonical JSON: stable key order and fixed rounding, so exports diff cleanly. */
export function canonicalJson(value: unknown, minify = false): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "number") {
      const r = Math.round(v * 10000) / 10000;
      return Object.is(r, -0) ? 0 : r;
    }
    return v;
  }, minify ? undefined : 2);
}

/** Every exported file by name, shared by the zip and the folder export. */
export async function exportFiles(result: ExportResult): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  const min = result.minifyJson === true;
  files[`${result.fileBase}_ske.json`] = strToU8(canonicalJson(result.skeleton, min));
  if (result.extensions) {
    const armature = result.skeleton.armature[result.skeleton.armature.length - 1]?.name ?? "";
    files[`${result.fileBase}_ext.json`] = strToU8(canonicalJson(result.extensions, min));
    files[RUNTIME_FILE] = strToU8(runtimeSource);
    files["README.md"] = strToU8(extensionReadme(result.fileBase, armature, result.extensions));
  }
  for (const page of result.pages) {
    files[`${page.fileStem}.json`] = strToU8(canonicalJson(page.json, min));
    files[`${page.fileStem}.${page.ext}`] = new Uint8Array(await page.blob.arrayBuffer());
  }
  return files;
}

export async function bundleZip(result: ExportResult): Promise<Blob> {
  const zipped = await zipFiles(await exportFiles(result));
  return new Blob([zipped as unknown as BlobPart], { type: "application/zip" });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The stem every exported file shares: the project name, made file-safe. */
export function safeFileName(name: string): string {
  // Leading dots go too: ".." is a legal-looking stem that the File System
  // Access API refuses outright, and a dotfile is not what anyone meant.
  const cleaned = name.trim().replace(/[^\w.-]+/g, "_").replace(/^[_.]+|[_.]+$/g, "");
  return cleaned || "project";
}
