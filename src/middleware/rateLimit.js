// In-memory token-bucket rate limiter. Keyed per org (or per API key).
// Refills continuously; cheap and good enough for a single instance. For
// multi-instance you'd back the buckets with Redis — same interface.
const buckets = new Map();

export function rateLimit({ capacity = 120, refillPerSec = 2 } = {}) {
  return (req, res, next) => {
    const key = req.auth?.keyId
      ? `key:${req.auth.keyId}`
      : `org:${req.auth?.orgId || req.ip}`;

    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, last: now };
      buckets.set(key, b);
    }
    // refill
    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
    b.last = now;

    if (b.tokens < 1) {
      res.set('Retry-After', '1');
      return res.status(429).json({ error: 'rate limit exceeded' });
    }
    b.tokens -= 1;
    res.set('X-RateLimit-Remaining', String(Math.floor(b.tokens)));
    next();
  };
}
