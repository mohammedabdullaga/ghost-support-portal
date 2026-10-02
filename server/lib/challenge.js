/**
 * One-time proof-of-interaction challenge store (in-memory).
 *
 * Flow: server issues { id, target } → client drags a slider to `target` and
 * submits { id, pos, moves, duration } → server verifies:
 *   - challenge exists, not expired, not already used
 *   - final position within ±4 of the random target
 *   - enough pointer samples (a real drag, not a scripted jump)
 *   - human-plausible duration
 * Consuming a challenge destroys it — replay is impossible.
 */
export function createChallengeStore({ ttlMs = 3 * 60 * 1000, tolerance = 4 } = {}) {
  const store = new Map(); // id -> { target, expiresAt }

  // periodic cleanup of expired challenges
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, c] of store) if (c.expiresAt <= now) store.delete(id);
  }, 60 * 1000);
  sweeper.unref?.();

  return {
    issue(id, target) {
      store.set(id, { target, expiresAt: Date.now() + ttlMs });
    },

    /**
     * Verifies and consumes a challenge. Returns { ok, reason }.
     */
    verify(id, pos, moves, duration) {
      const c = store.get(id);
      if (!c) return { ok: false, reason: 'CHALLENGE_MISSING' };
      store.delete(id); // one-time use — consume regardless of outcome

      if (c.expiresAt <= Date.now()) return { ok: false, reason: 'CHALLENGE_EXPIRED' };

      const position = Number(pos);
      if (!Number.isFinite(position) || Math.abs(position - c.target) > tolerance) {
        return { ok: false, reason: 'CHALLENGE_WRONG_POSITION' };
      }

      const moveCount = Number(moves);
      if (!Number.isInteger(moveCount) || moveCount < 5) {
        return { ok: false, reason: 'CHALLENGE_NO_INTERACTION' };
      }

      const ms = Number(duration);
      if (!Number.isFinite(ms) || ms < 250) {
        return { ok: false, reason: 'CHALLENGE_TOO_FAST' };
      }

      return { ok: true };
    },
  };
}
