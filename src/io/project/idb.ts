/**
 * The one IndexedDB database, and the one place its version is bumped.
 *
 * Two modules opening the same database at different versions is a deadlock
 * waiting to happen (the second open blocks on the first connection), so the
 * stores are declared together here and everything else asks for one by name.
 */

// Renaming it does not migrate the database: it opens an empty new one, and
// the autosave record in the old one is somebody's unsaved work.
const DB_NAME = "animo";
const DB_VERSION = 2;
const STORES = ["autosave", "recents"] as const;

export type StoreName = (typeof STORES)[number];

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open IndexedDB"));
  });
}

export async function withStore<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
    });
  } finally {
    db.close();
  }
}
