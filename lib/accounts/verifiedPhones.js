// Holds the plaintext number of a session that has just verified itself, long
// enough to text it a welcome once Drive is connected. Accounts store only a
// hash of the number, which is one-way by design, so there is nowhere to read
// the number back from at the end of onboarding.
//
// Deliberately in-process and short-lived: nothing writes a plaintext number to
// disk. A restart mid-onboarding costs the welcome text and nothing else — the
// same instructions are on the page.
function createVerifiedPhoneStore({ ttlMs = 60 * 60 * 1000 } = {}) {
  const entries = new Map();

  function prune(now) {
    for (const [key, entry] of entries) {
      if (now - entry.at >= ttlMs) entries.delete(key);
    }
  }

  return {
    remember(accountId, phone, now = Date.now()) {
      prune(now);
      entries.set(String(accountId), { phone, at: now });
    },
    // Reads and forgets: the number is needed exactly once.
    take(accountId, now = Date.now()) {
      prune(now);
      const key = String(accountId);
      const entry = entries.get(key);
      entries.delete(key);
      return entry ? entry.phone : null;
    },
    forget(accountId) {
      entries.delete(String(accountId));
    }
  };
}

module.exports = { createVerifiedPhoneStore };
