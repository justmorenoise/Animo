/** Branded ids: a NodeId can never be passed where an ItemId is expected. */
declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type ItemId = Brand<string, "ItemId">;
export type NodeId = Brand<string, "NodeId">;
export type LayerId = Brand<string, "LayerId">;
export type AnimId = Brand<string, "AnimId">;
export type IkId = Brand<string, "IkId">;
export type AssetId = Brand<string, "AssetId">;
export type FolderId = Brand<string, "FolderId">;

/**
 * Seedable id generator. Deterministic by default so exporter golden files
 * and parity fixtures reproduce byte-for-byte; `reseed` is what test setup
 * calls between cases.
 */
let counter = 0;
export function reseed(at = 0): void { counter = at; }

function next(prefix: string): string {
  counter += 1;
  return `${prefix}${counter.toString(36)}`;
}

export const newItemId = () => next("i") as ItemId;
export const newNodeId = () => next("n") as NodeId;
export const newLayerId = () => next("l") as LayerId;
export const newAnimId = () => next("a") as AnimId;
export const newIkId = () => next("k") as IkId;
export const newAssetId = () => next("s") as AssetId;
export const newFolderId = () => next("f") as FolderId;

/** For deserialisation: keep the counter ahead of every id already in use. */
export function observeId(id: string): void {
  const n = parseInt(id.slice(1), 36);
  if (Number.isFinite(n) && n > counter) counter = n;
}
