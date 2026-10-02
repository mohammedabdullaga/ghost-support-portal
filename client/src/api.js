export const API_BASE = import.meta.env.VITE_API_URL || '';

const AUTH_KEY = 'ghost_auth';

export function loadAuth() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
  } catch {
    return null;
  }
}

export function saveAuth(auth) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
}

export function clearAuth() {
  localStorage.removeItem(AUTH_KEY);
}

export function getToken() {
  return loadAuth()?.token ?? null;
}

/**
 * Minimal fetch wrapper that attaches the Bearer token and normalizes errors.
 * Error exposes `.status` and `.code` (server error code string).
 */
export async function api(path, { method = 'GET', body, formData } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload;
  if (formData) {
    payload = formData; // browser sets multipart boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: payload });
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const err = new Error(data?.error || 'REQUEST_FAILED');
    err.status = res.status;
    err.code = data?.error || 'REQUEST_FAILED';
    err.retryAfterSec = data?.retryAfterSec;
    throw err;
  }
  return data;
}

/** Uploads one image file through the hardened pipeline. Returns { url }. */
export function uploadImage(file) {
  const formData = new FormData();
  formData.append('file', file);
  return api('/api/upload', { method: 'POST', formData });
}
