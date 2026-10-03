import type { AssetId } from "./ids";
import { isImage, type Project } from "./types";

/** The assets the document's images draw with. */
export function assetsInUse(project: Project): Set<AssetId> {
  return new Set(Object.values(project.items).filter(isImage).map((i) => i.assetId));
}
