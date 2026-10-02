import { io } from 'socket.io-client';
import { getToken } from './api.js';

let socket = null;

/**
 * Returns a shared, JWT-authenticated socket (created lazily, recreated if the
 * token changed). Connects same-origin unless VITE_API_URL points elsewhere.
 */
export function getSocket() {
  const token = getToken();
  if (!token) return null;

  if (socket && socket.auth?.token === token) return socket;
  if (socket) socket.disconnect();

  const url = import.meta.env.VITE_API_URL || undefined;
  socket = io(url, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
  });
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

/** Emits an event and resolves with the ack payload (8s timeout). */
export function emitAck(event, payload) {
  const s = getSocket();
  if (!s) return Promise.resolve({ ok: false, error: 'NO_SOCKET' });
  return new Promise((resolve) => {
    s.timeout(8000).emit(event, payload, (err, ack) => {
      resolve(err ? { ok: false, error: 'TIMEOUT' } : ack);
    });
  });
}
