const IPTV_API_URL = process.env.IPTV_API_URL || 'http://ghosttv-con.my/player_api.php';
const UPSTREAM_TIMEOUT_MS = 8000;

/** Strip Arabic diacritics (tashkeel) and trim — prevents a stray damma/fatha
 *  typed before the username from breaking both auth and admin matching. */
export function normalizeUsername(u) {
  return String(u || '')
    .replace(/[\u064B-\u0652\u0670]/g, '') // Arabic diacritics
    .trim();
}

/**
 * Validates subscriber credentials against the upstream IPTV panel.
 * Success condition: user_info.auth === 1 AND user_info.status === "Active".
 *
 * @returns {Promise<{ ok: true, info: object } | { ok: false, reason: string }>}
 */
export async function verifyIptvCredentials(username, password) {
  const url = `${IPTV_API_URL}?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { Accept: 'application/json', 'User-Agent': 'GhostSupportPortal/1.0' },
    });
  } catch {
    return { ok: false, reason: 'UPSTREAM_UNREACHABLE' };
  }

  if (!res.ok) return { ok: false, reason: 'UPSTREAM_UNREACHABLE' };

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: 'UPSTREAM_UNREACHABLE' };
  }

  const info = data?.user_info;
  // The panel may return auth as number 1 or string "1" depending on version.
  const authenticated = info && String(info.auth) === '1';
  if (!authenticated || info.status !== 'Active') {
    return { ok: false, reason: 'INVALID_CREDENTIALS' };
  }

  return { ok: true, info };
}
