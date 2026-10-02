// Per-visitor read receipts stored in localStorage.
// Maps a conversation id → the timestamp (ms) the visitor last read it.

const KEY = 'ghost_chat_read';

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

function save(map) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}

export function markChatRead(conversationId) {
  const map = load();
  map[conversationId] = Date.now();
  save(map);
}

export function lastReadAt(conversationId) {
  return load()[conversationId] || 0;
}

/** True when the latest activity in a conversation is newer than the last read. */
export function isChatUnread(conversationId, latestIso) {
  if (!latestIso) return false;
  return new Date(latestIso).getTime() > lastReadAt(conversationId);
}
