// Minimal promise wrapper around IndexedDB. No new dependencies; the single
// "kv" object store keeps projects, naming drafts and migration markers.
const DB_NAME = "zhichuang-workshop";
const DB_VERSION = 1;
const STORE = "kv";

export function isIdbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (!isIdbAvailable()) return Promise.reject(new Error("IndexedDB 不可用。"));
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB 打开失败。"));
      request.onblocked = () => reject(new Error("IndexedDB 被其他页面占用，请关闭其他标签页后重试。"));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, task: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    db =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = task(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB 读写失败。"));
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB 事务中止。"));
      }),
  );
}

export function idbGet(key: string): Promise<unknown> {
  return run("readonly", store => store.get(key)).then(
    record => (record as { value?: unknown } | undefined)?.value,
  );
}

export function idbSet(key: string, value: unknown): Promise<void> {
  return run("readwrite", store => store.put({ key, value })).then(() => undefined);
}

export function idbDel(key: string): Promise<void> {
  return run("readwrite", store => store.delete(key)).then(() => undefined);
}
