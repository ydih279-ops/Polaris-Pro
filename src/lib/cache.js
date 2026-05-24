// Tiny LRU + TTL cache. No Redis dependency — keeps the free-tier deploy
// single-service. For a real multi-instance deployment you'd swap this for
// Redis behind the same get/set interface; nothing else would change.
class LRUCache {
  constructor(max = 500) {
    this.max = max;
    this.map = new Map(); // key -> { value, expires }
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expires && entry.expires < Date.now()) {
      this.map.delete(key);
      return null;
    }
    // touch — move to most-recently-used
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs = 0) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: ttlMs ? Date.now() + ttlMs : 0 });
    if (this.map.size > this.max) {
      // evict least-recently-used (first inserted)
      this.map.delete(this.map.keys().next().value);
    }
  }

  // Invalidate everything under a prefix — used after writes to a dataset.
  invalidatePrefix(prefix) {
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) this.map.delete(key);
    }
  }
}

export const cache = new LRUCache(1000);
