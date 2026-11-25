// Minimal promise wrapper around IndexedDB. Structured clone stores
// Uint8Array samples directly; JSON export is responsible for base64.

const DB_NAME = 'fuzz-workbench-db';
const DB_VERSION = 1;
const STORE = 'kv';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this browser context'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function tx(mode) {
  return openDB().then(
    (db) => db.transaction(STORE, mode).objectStore(STORE),
  );
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function kvGet(key, fallback = null) {
  try {
    const store = await tx('readonly');
    const value = await requestPromise(store.get(key));
    return value === undefined ? fallback : value;
  } catch (error) {
    console.warn('[storage] get failed', key, error);
    return fallback;
  }
}

export async function kvSet(key, value) {
  const store = await tx('readwrite');
  await requestPromise(store.put(value, key));
  return true;
}

export async function kvRemove(key) {
  const store = await tx('readwrite');
  await requestPromise(store.delete(key));
  return true;
}

export async function kvClear() {
  const store = await tx('readwrite');
  await requestPromise(store.clear());
  return true;
}

export const keys = {
  settings: 'fuzz:settings:v1',
  activeTarget: 'fuzz:active-target:v1',
  targetCorpus: (id) => `fuzz:corpus:${id}:v1`,
  targetCrashes: (id) => `fuzz:crashes:${id}:v1`,
  targetCheckpoint: (id) => `fuzz:checkpoint:${id}:v1`,
};
