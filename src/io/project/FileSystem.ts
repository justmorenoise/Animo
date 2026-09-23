/**
 * File access, behind one interface.
 *
 * Chrome and Edge give real Save / Save As over a file handle; everywhere
 * else falls back to a download and an <input type="file">. Keeping the
 * fallback on the same interface is also what makes wrapping this in Electron
 * later a small job rather than a rewrite.
 */

export interface FileRef {
  name: string;
  /** Present only where the File System Access API is available. */
  handle?: FileSystemFileHandle;
}

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

declare global {
  interface Window {
    showSaveFilePicker?(options: {
      suggestedName?: string; types?: PickerType[]; id?: string;
    }): Promise<FileSystemFileHandle>;
    showOpenFilePicker?(options: {
      types?: PickerType[]; multiple?: boolean; id?: string;
    }): Promise<FileSystemFileHandle[]>;
    showDirectoryPicker?(options?: {
      id?: string; mode?: "read" | "readwrite";
    }): Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemHandle {
    queryPermission?(desc: { mode: "read" | "readwrite" }): Promise<PermissionState>;
    requestPermission?(desc: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  }
}

export function hasNativeFiles(): boolean {
  return typeof window.showSaveFilePicker === "function";
}

const PROJECT_TYPE: PickerType = {
  description: "Animo project",
  accept: { "application/zip": [".animo"] },
};

export const ZIP_TYPE: PickerType = {
  description: "DragonBones export (zip)",
  accept: { "application/zip": [".zip"] },
};

export const PNG_TYPE: PickerType = {
  description: "PNG image",
  accept: { "image/png": [".png"] },
};

/**
 * Ask for a location. Returns null when the user cancels.
 *
 * `id` names a picker so the browser reopens it where it was left; projects
 * and exports usually live in different folders, and remembering each
 * separately saves the same navigation every time.
 */
export async function pickSaveLocation(
  suggestedName: string, type: PickerType = PROJECT_TYPE, id = "animo-project",
): Promise<FileRef | null> {
  if (!hasNativeFiles()) return { name: suggestedName };
  try {
    const handle = await window.showSaveFilePicker!({
      suggestedName,
      types: [type],
      id,
    });
    return { name: handle.name, handle };
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

export function hasDirectoryPicker(): boolean {
  return typeof window.showDirectoryPicker === "function";
}

/** Ask for a folder to write several files into. Null when cancelled. */
export async function pickDirectory(id = "animo-export"): Promise<FileSystemDirectoryHandle | null> {
  if (!hasDirectoryPicker()) return null;
  try {
    return await window.showDirectoryPicker!({ id, mode: "readwrite" });
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

export async function writeIntoDirectory(
  dir: FileSystemDirectoryHandle, name: string, blob: Blob,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/**
 * Read a file we have a handle for.
 *
 * A handle outlives the permission that came with it, so a handle from a
 * previous visit needs the grant asking for again — which browsers only allow
 * from a user gesture, hence null (meaning "fall back to the picker") rather
 * than an exception.
 */
export async function readFileRef(ref: FileRef): Promise<ArrayBuffer | null> {
  if (!ref.handle) return null;
  try {
    const mode = { mode: "read" } as const;
    const state = (await ref.handle.queryPermission?.(mode)) ?? "granted";
    if (state !== "granted") {
      const asked = (await ref.handle.requestPermission?.(mode)) ?? "denied";
      if (asked !== "granted") return null;
    }
    const file = await ref.handle.getFile();
    return await file.arrayBuffer();
  } catch {
    return null;                      // moved, deleted, or permission refused
  }
}

export const KEYMAP_TYPE: PickerType = {
  description: "Keyboard shortcuts",
  accept: { "application/json": [".json"] },
};

export async function pickOpenFile(
  type: PickerType = PROJECT_TYPE, id?: string,
): Promise<{ ref: FileRef; data: ArrayBuffer } | null> {
  if (hasNativeFiles()) {
    try {
      const [handle] = await window.showOpenFilePicker!({ types: [type], multiple: false, id });
      if (!handle) return null;
      const file = await handle.getFile();
      return { ref: { name: handle.name, handle }, data: await file.arrayBuffer() };
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = Object.entries(type.accept).flatMap(([mime, exts]) => [...exts, mime]).join(",");
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) { resolve(null); return; }
      resolve({ ref: { name: file.name }, data: await file.arrayBuffer() });
    });
    // A cancelled picker fires no event in some browsers; the element is
    // harmless if it lingers, and a later open replaces it.
    input.click();
  });
}

/** Write through a handle when we have one, otherwise download. */
export async function writeFile(ref: FileRef, blob: Blob): Promise<void> {
  if (ref.handle) {
    const writable = await ref.handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }
  download(blob, ref.name);
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
