// Sliding-window counter keyed by an opaque string, used to cap verification
// codes per phone number on top of the per-IP limiter — the IP limit alone lets
// one number be pestered from many addresses. In-process and therefore reset by
// a restart, which is acceptable: it exists to stop a stream of requests, not to
// be an accounting record.
function createAttemptLimiter({ limit, windowMs }) {
  const hits = new Map();

  function prune(now) {
    for (const [key, timestamps] of hits) {
      const live = timestamps.filter(at => now - at < windowMs);
      if (live.length) hits.set(key, live);
      else hits.delete(key);
    }
  }

  return {
    // Records an attempt and reports whether it is within the cap.
    allow(key, now = Date.now()) {
      prune(now);
      const timestamps = hits.get(key) || [];
      if (timestamps.length >= limit) return false;
      timestamps.push(now);
      hits.set(key, timestamps);
      return true;
    },
    reset() {
      hits.clear();
    }
  };
}

module.exports = { createAttemptLimiter };
