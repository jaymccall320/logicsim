// Minimal IndexedDB key/value store for autosave.
const DB = 'logicsim', STORE = 'kv';
function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function load<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((res, rej) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result as T); r.onerror = () => rej(r.error);
  });
}
export async function save(key: string, value: unknown): Promise<void> {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
