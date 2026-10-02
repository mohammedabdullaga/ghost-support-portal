// ---------------------------------------------------------------------------
// In-memory abuse guards (per-process). Good enough for a single VPS instance.
// ---------------------------------------------------------------------------

/**
 * Login brute-force lockout: tracks consecutive failed logins per username.
 * After `maxFails` failures the username is locked for `lockMs`.
 */
export function createLoginAttemptTracker({ maxFails = 3, lockMs = 5 * 60 * 1000 } = {}) {
  const attempts = new Map(); // key -> { count, lockedUntil }

  return {
    /** ms remaining if locked, else 0 */
    lockedFor(key) {
      const rec = attempts.get(key);
      if (!rec) return 0;
      if (rec.lockedUntil && rec.lockedUntil > Date.now()) return rec.lockedUntil - Date.now();
      if (rec.lockedUntil && rec.lockedUntil <= Date.now()) attempts.delete(key); // expired
      return 0;
    },
    /** record a failure; returns ms remaining if this failure triggered a lock */
    fail(key) {
      const rec = attempts.get(key) || { count: 0, lockedUntil: 0 };
      rec.count += 1;
      if (rec.count >= maxFails) {
        rec.lockedUntil = Date.now() + lockMs;
        rec.count = 0;
      }
      attempts.set(key, rec);
      return rec.lockedUntil > Date.now() ? rec.lockedUntil - Date.now() : 0;
    },
    success(key) {
      attempts.delete(key);
    },
  };
}

/**
 * Fixed-per-second chat throttle: at most one message per `intervalMs` per socket.
 * Returns true if the sender must wait (i.e. is sending too fast).
 */
export function createChatThrottle({ intervalMs = 1000 } = {}) {
  const last = new Map(); // key -> timestamp
  return {
    tooFast(key) {
      const now = Date.now();
      const prev = last.get(key) || 0;
      if (now - prev < intervalMs) return true;
      last.set(key, now);
      return false;
    },
    clear(key) {
      last.delete(key);
    },
  };
}
