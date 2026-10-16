const CACHE_KEY = 'airspace-aircraft-cache-v1';

export function readAircraftCache(storage) {
  try {
    const savedValue = (storage ?? globalThis.localStorage).getItem(CACHE_KEY);
    if (!savedValue) return null;

    const snapshot = JSON.parse(savedValue);
    if (snapshot.version !== 1 || !Array.isArray(snapshot.aircraft)) return null;
    return snapshot;
  } catch {
    return null;
  }
}

export function saveAircraftCache(snapshot, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(CACHE_KEY, JSON.stringify({ version: 1, ...snapshot }));
    return true;
  } catch {
    return false;
  }
}
