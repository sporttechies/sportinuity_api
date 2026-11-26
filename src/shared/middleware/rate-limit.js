// Small in-memory limiter for public endpoints (one API instance). Counts per client IP and bucket.
const buckets = new Map();

function rateLimit({ name, windowMs, max, message = "Too many attempts. Please try again later." }) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const hit = buckets.get(key);
    if (!hit || hit.reset <= now) {
      buckets.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    hit.count += 1;
    if (hit.count > max) {
      res.set("Retry-After", String(Math.ceil((hit.reset - now) / 1000)));
      return res.status(429).json({ message });
    }
    return next();
  };
}

// Drop expired entries so the map can't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, hit] of buckets) if (hit.reset <= now) buckets.delete(key);
}, 5 * 60 * 1000).unref();

rateLimit.resetAll = () => buckets.clear();
module.exports = { rateLimit };
