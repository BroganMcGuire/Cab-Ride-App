/**
 * IDB — minimal IndexedDB wrapper so a fault tap is captured to disk
 * instantly, even with zero connectivity, and synced to the server later.
 */
const IDB = (() => {
  const DB_NAME = 'cabride';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('faults')) {
          const store = db.createObjectStore('faults', { keyPath: 'clientId' });
          store.createIndex('rideId', 'rideId', { unique: false });
          store.createIndex('synced', 'synced', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(storeName, mode) {
    const db = await open();
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  async function saveFault(fault) {
    const store = await tx('faults', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(fault);
      req.onsuccess = () => resolve(fault);
      req.onerror = () => reject(req.error);
    });
  }

  async function getFaultsForRide(rideId) {
    const store = await tx('faults', 'readonly');
    return new Promise((resolve, reject) => {
      const idx = store.index('rideId');
      const req = idx.getAll(rideId);
      req.onsuccess = () => resolve(req.result.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)));
      req.onerror = () => reject(req.error);
    });
  }

  async function getUnsynced() {
    const store = await tx('faults', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result.filter((f) => !f.synced));
      req.onerror = () => reject(req.error);
    });
  }

  async function markSynced(clientId, serverFields = {}) {
    const store = await tx('faults', 'readwrite');
    return new Promise((resolve, reject) => {
      const getReq = store.get(clientId);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if (!rec) return resolve(null);
        Object.assign(rec, serverFields, { synced: true });
        const putReq = store.put(rec);
        putReq.onsuccess = () => resolve(rec);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function deleteFault(clientId) {
    const store = await tx('faults', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(clientId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  return { saveFault, getFaultsForRide, getUnsynced, markSynced, deleteFault };
})();
