import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ClipboardList,
  Forward,
  Inbox,
  Loader2,
  MessageCircle,
  MessageSquarePlus,
  Search,
  Send,
  Undo2,
  Users,
} from 'lucide-react';
import { useApp } from '../App.jsx';
import { api, uploadImage, API_BASE } from '../api.js';
import { getSocket, emitAck } from '../socket.js';
import { formatDate, formatTime } from '../i18n.js';
import StatusBadge, { CategoryBadge } from './badges.jsx';
import { MessageBubble, ChatComposer } from './ChatSheet.jsx';
import { markChatRead, isChatUnread, lastReadAt } from '../unread.js';

// The agent username that receives forwarded VOD requests.
const VOD_AGENT = 'vodsupport';

export default function AdminDashboard() {
  const { t, lang, auth } = useApp();

  const [tab, setTab] = useState('reports'); // 'reports' | 'chats' | 'users'

  // Reports queue
  const [reports, setReports] = useState([]);
  const [loadingReports, setLoadingReports] = useState(true);
  const [filter, setFilter] = useState('ALL'); // ALL | OPEN | RESOLVED
  const [catFilter, setCatFilter] = useState('ALL'); // ALL | LIVE | VOD | SUGGESTION | OTHER
  const [queueView, setQueueView] = useState('ALL'); // ALL | MINE (assigned to me)
  const [toggling, setToggling] = useState('');
  const [forwarding, setForwarding] = useState('');

  // Chat console
  const [sessions, setSessions] = useState([]);
  const [loadingChats, setLoadingChats] = useState(true);
  const [chatRange, setChatRange] = useState('auto'); // auto | today | yesterday | week | all
  const [chatRangeApplied, setChatRangeApplied] = useState(''); // what the server resolved 'auto' to
  const [unreadOnly, setUnreadOnly] = useState(false); // show only chats with unread customer messages
  const [selected, setSelected] = useState(null); // session object
  const [messages, setMessages] = useState([]);
  const [sendingMsg, setSendingMsg] = useState(false);

  // Users directory (chat trigger)
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [opening, setOpening] = useState('');

  // Search
  const [userQuery, setUserQuery] = useState('');
  const [chatQuery, setChatQuery] = useState('');
  const [chatSearchResults, setChatSearchResults] = useState(null); // null = not searching
  const [searchingChats, setSearchingChats] = useState(false);
  const chatSearchTimer = useRef(null);

  // Inline report replies
  const [replyText, setReplyText] = useState({}); // reportId -> draft
  const [sendingReply, setSendingReply] = useState('');

  // Unread + notifications
  const [readTick, setReadTick] = useState(0); // bump to re-render unread badges
  const [toast, setToast] = useState(null); // { sessionId, from, preview }
  const toastTimer = useRef(null);

  // Refs so socket handlers see current values without stale closures
  const selectedRef = useRef(null);
  const tabRef = useRef('reports');
  useEffect(() => {
    selectedRef.current = selected;
    tabRef.current = tab;
  }, [selected, tab]);

  // ---- Initial loads --------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    api('/api/admin/reports')
      .then((d) => !cancelled && setReports(d.reports))
      .catch(() => {})
      .finally(() => !cancelled && setLoadingReports(false));
    api('/api/admin/chats')
      .then((d) => {
        if (cancelled) return;
        setSessions(d.sessions);
        setChatRangeApplied(d.range || '');
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoadingChats(false));
    api('/api/admin/users')
      .then((d) => !cancelled && setUsers(d.users))
      .catch(() => {})
      .finally(() => !cancelled && setLoadingUsers(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-fetch chats when the admin picks a time filter.
  useEffect(() => {
    if (chatRange === 'auto') return; // initial load already used 'auto'
    let cancelled = false;
    setLoadingChats(true);
    api(`/api/admin/chats?range=${chatRange}`)
      .then((d) => {
        if (cancelled) return;
        setSessions(d.sessions);
        setChatRangeApplied(d.range || chatRange);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoadingChats(false));
    return () => {
      cancelled = true;
    };
  }, [chatRange]);

  // ---- Socket wiring ---------------------------------------------------------
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return undefined;

    const onNewReport = (report) => {
      setReports((prev) => (prev.some((r) => r.id === report.id) ? prev : [report, ...prev]));
    };
    const onReportUpdate = (report) => {
      setReports((prev) => prev.map((r) => (r.id === report.id ? report : r)));
    };
    const onReportResponse = ({ reportId, response }) => {
      setReports((prev) =>
        prev.map((r) =>
          r.id === reportId && !(r.responses || []).some((x) => x.id === response.id)
            ? { ...r, responses: [...(r.responses || []), response] }
            : r,
        ),
      );
    };
    const onMessage = ({ sessionId, message }) => {
      // Bump the session card to the top with its latest message.
      setSessions((prev) => {
        const idx = prev.findIndex((s) => s.id === sessionId);
        if (idx === -1) {
          api('/api/admin/chats').then((d) => setSessions(d.sessions)).catch(() => {});
          return prev;
        }
        const updated = { ...prev[idx], messages: [message], updatedAt: message.createdAt };
        return [updated, ...prev.filter((s) => s.id !== sessionId)];
      });
      setSelected((sel) => {
        if (sel?.id === sessionId) {
          setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
        }
        return sel;
      });

      // Notification popup: only for the OTHER party's messages, and only when
      // the admin isn't already viewing this exact chat.
      const fromCustomer = message.senderRole === 'USER';
      const viewingThis = tabRef.current === 'chats' && selectedRef.current?.id === sessionId;
      if (fromCustomer && !viewingThis) {
        showToast({
          sessionId,
          from: message.senderName || 'Customer',
          preview: message.text || '📷',
        });
      }
      setReadTick((x) => x + 1); // refresh unread badges
    };

    socket.on('report:new', onNewReport);
    socket.on('report:update', onReportUpdate);
    socket.on('report:response', onReportResponse);
    socket.on('chat:message', onMessage);
    return () => {
      socket.off('report:new', onNewReport);
      socket.off('report:update', onReportUpdate);
      socket.off('report:response', onReportResponse);
      socket.off('chat:message', onMessage);
    };
  }, []);

  // ---- Actions ---------------------------------------------------------------
  function showToast(data) {
    setToast(data);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }

  function dismissToast() {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(null);
  }

  async function toggleStatus(report) {
    if (toggling) return;
    setToggling(report.id);
    try {
      const next = report.status === 'OPEN' ? 'RESOLVED' : 'OPEN';
      const res = await api(`/api/admin/reports/${report.id}/status`, {
        method: 'PATCH',
        body: { status: next },
      });
      setReports((prev) => prev.map((r) => (r.id === report.id ? res.report : r)));
    } catch {
      /* surfaced by socket echo / next refresh */
    } finally {
      setToggling('');
    }
  }

  async function openSession(session) {
    setSelected(session);
    markChatRead(session.id); // clear unread for this conversation
    setReadTick((x) => x + 1);
    dismissToast();
    try {
      const d = await api(`/api/chat/${session.id}/messages`);
      setMessages(d.messages);
    } catch {
      setMessages([]);
    }
  }

  async function sendReply(text, file) {
    if (!selected) return false;
    setSendingMsg(true);
    try {
      let imageUrl = null;
      if (file) {
        const up = await uploadImage(file);
        imageUrl = up.url;
      }
      const ack = await emitAck('chat:reply', { sessionId: selected.id, text, imageUrl });
      if (ack?.ok) {
        setMessages((prev) => (prev.some((m) => m.id === ack.message.id) ? prev : [...prev, ack.message]));
        return true;
      }
      return ack?.error || false;
    } catch {
      return false;
    } finally {
      setSendingMsg(false);
    }
  }

  /** Admin trigger — pops the chat sheet on the customer's screen in real time. */
  async function startChatWith(user) {
    if (opening) return;
    setOpening(user.id);
    try {
      const ack = await emitAck('chat:open', { userId: user.id });
      if (ack?.ok) {
        setSessions((prev) => {
          const exists = prev.some((s) => s.id === ack.session.id);
          const dto = { ...ack.session, user: { id: user.id, iptvUsername: user.iptvUsername }, messages: ack.messages.slice(-1) };
          return exists ? prev : [dto, ...prev];
        });
        setSelected(ack.session);
        setMessages(ack.messages || []);
        setTab('chats');
      }
    } finally {
      setOpening('');
    }
  }

  /** Post an in-ticket reply the customer can read on their report. */
  async function sendReplyToReport(reportId) {
    const text = (replyText[reportId] || '').trim();
    if (!text || sendingReply) return;
    setSendingReply(reportId);
    try {
      const res = await api(`/api/admin/reports/${reportId}/responses`, {
        method: 'POST',
        body: { text },
      });
      setReplyText((prev) => ({ ...prev, [reportId]: '' }));
      // Optimistic append (socket echo dedupes by id)
      setReports((prev) =>
        prev.map((r) =>
          r.id === reportId && !(r.responses || []).some((x) => x.id === res.response.id)
            ? { ...r, responses: [...(r.responses || []), res.response] }
            : r,
        ),
      );
    } catch {
      /* leave draft intact so agent can retry */
    } finally {
      setSendingReply('');
    }
  }

  /** Forward a VOD ticket to the VOD support agent. */
  async function forwardToVod(report) {
    if (forwarding) return;
    setForwarding(report.id);
    try {
      const res = await api(`/api/admin/reports/${report.id}/assign`, {
        method: 'PATCH',
        body: { assignee: VOD_AGENT },
      });
      // My queue no longer contains it → drop from my list (assignee = someone else)
      setReports((prev) => prev.filter((r) => r.id !== report.id));
    } catch {
      /* agent not found / network — leave in place */
    } finally {
      setForwarding('');
    }
  }

  /** Jump straight into a live chat with the report's owner. */
  async function chatFromReport(report) {
    if (!report.userId || opening) return;
    await startChatWith({ id: report.userId, iptvUsername: report.user?.iptvUsername });
  }

  /** Debounced server-side chat search (username + message content). */
  function onChatQueryChange(value) {
    setChatQuery(value);
    if (chatSearchTimer.current) clearTimeout(chatSearchTimer.current);
    const q = value.trim();
    if (!q) {
      setChatSearchResults(null);
      setSearchingChats(false);
      return;
    }
    chatSearchTimer.current = setTimeout(async () => {
      setSearchingChats(true);
      try {
        const d = await api(`/api/admin/chats/search?q=${encodeURIComponent(q)}`);
        setChatSearchResults(d.sessions);
      } catch {
        setChatSearchResults([]);
      } finally {
        setSearchingChats(false);
      }
    }, 300);
  }

  // ---- Derived ----------------------------------------------------------------
  const me = auth.user.iptvUsername;
  const isVodAgent = me.toLowerCase().includes('vod');
  const openCount = reports.filter((r) => r.status === 'OPEN').length;
  const queueFiltered =
    queueView === 'MINE'
      ? reports.filter((r) => (r.assignee || '').toLowerCase() === me.toLowerCase())
      : reports;
  const visibleReports =
    (filter === 'ALL' ? queueFiltered : queueFiltered.filter((r) => r.status === filter))
      .filter((r) => (catFilter === 'ALL' ? true : r.category === catFilter));

  // Users search (client-side filter by username)
  const filteredUsers = userQuery.trim()
    ? users.filter((u) =>
        u.iptvUsername.toLowerCase().includes(userQuery.trim().toLowerCase()),
      )
    : users;

  // Chats: server search results when a query is active, otherwise the full list
  const baseSessions = chatSearchResults !== null ? chatSearchResults : sessions;
  // Unread-only toggle: keep chats whose latest message is an unread customer one
  const displayedSessions = unreadOnly
    ? baseSessions.filter(
        (s) => s.messages?.[0] && s.messages[0].senderRole === 'USER' && isChatUnread(s.id, s.messages[0].createdAt),
      )
    : baseSessions;

  // Total unread customer messages across all sessions (drives the tab badge)
  void readTick; // re-render trigger when read receipts change
  const unreadChats = sessions.filter(
    (s) => s.messages?.[0] && s.messages[0].senderRole === 'USER' && isChatUnread(s.id, s.messages[0].createdAt),
  ).length;

  const navItems = [
    { id: 'reports', label: t('tabReports'), icon: ClipboardList, badge: 0 },
    { id: 'chats', label: t('tabChats'), icon: MessageCircle, badge: unreadChats },
    { id: 'users', label: t('tabUsers'), icon: Users, badge: 0 },
  ];

  return (
    <div className="px-4 pb-28 pt-5">
      {/* New-message toast popup */}
      {toast && (
        <div className="fixed inset-x-4 top-16 z-50 mx-auto max-w-md">
          <div className="flex items-center gap-3 rounded-2xl border border-cyan-500/40 bg-slate-900 p-3.5 shadow-2xl shadow-black/60">
            <div className="rounded-xl bg-cyan-500/15 p-2 text-cyan-400">
              <MessageCircle size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-slate-100">
                {t('newMessage')} · {toast.from}
              </p>
              <p className="truncate text-[11px] text-slate-400">{toast.preview}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                const s = sessions.find((x) => x.id === toast.sessionId);
                dismissToast();
                setTab('chats');
                if (s) openSession(s);
              }}
              className="shrink-0 rounded-xl bg-cyan-600 px-3 py-1.5 text-[11px] font-bold text-white transition active:scale-95 hover:bg-cyan-500"
            >
              {t('view')}
            </button>
            <button
              type="button"
              onClick={dismissToast}
              className="shrink-0 rounded-lg p-1.5 text-slate-500 transition active:scale-90 hover:text-slate-300"
              aria-label={t('dismiss')}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="mb-5 grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
          <p className="text-2xl font-extrabold text-amber-400">{openCount}</p>
          <p className="mt-0.5 text-[11px] font-semibold text-slate-400">{t('reportsOpen')}</p>
        </div>
        <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4">
          <p className="text-2xl font-extrabold text-cyan-400">{sessions.length}</p>
          <p className="mt-0.5 text-[11px] font-semibold text-slate-400">{t('activeChats')}</p>
        </div>
      </div>

      {/* ---------------- Reports queue ---------------- */}
      {tab === 'reports' && (
        <div className="space-y-3">
          {/* My-queue toggle (for the VOD agent and general admins) */}
          <div className="flex gap-2">
            {[
              { id: 'ALL', label: t('all') },
              { id: 'MINE', label: t('myQueue') },
            ].map((q) => (
              <button
                key={q.id}
                type="button"
                onClick={() => setQueueView(q.id)}
                className={`rounded-full px-3.5 py-1.5 text-[11px] font-bold transition active:scale-95 ${
                  queueView === q.id
                    ? 'bg-violet-600 text-white'
                    : 'border border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'
                }`}
              >
                {q.label}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            {['ALL', 'OPEN', 'RESOLVED'].map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded-full px-3.5 py-1.5 text-[11px] font-bold transition active:scale-95 ${
                  filter === f
                    ? 'bg-cyan-600 text-white'
                    : 'border border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'
                }`}
              >
                {f === 'ALL' ? t('all') : f === 'OPEN' ? t('statusOpen') : t('statusResolved')}
              </button>
            ))}
          </div>

          {/* Report type filter */}
          <div className="flex flex-wrap gap-1.5">
            {['ALL', 'LIVE', 'VOD', 'SUGGESTION', 'OTHER'].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCatFilter(c)}
                className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition active:scale-95 ${
                  catFilter === c
                    ? 'bg-violet-600 text-white'
                    : 'border border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'
                }`}
              >
                {c === 'ALL' ? t('all') : t(`cat${c}`)}
              </button>
            ))}
          </div>

          {loadingReports ? (
            <div className="flex justify-center py-14 text-slate-500">
              <Loader2 size={22} className="animate-spin" />
            </div>
          ) : visibleReports.length === 0 ? (
            <p className="flex flex-col items-center gap-2 rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-12 text-center text-xs text-slate-500">
              <Inbox size={20} /> {t('emptyReportsAdmin')}
            </p>
          ) : (
            visibleReports.map((r) => (
              <article key={r.id} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <CategoryBadge category={r.category} />
                    {r.category === 'VOD' && r.contentType && (
                      <span className="inline-flex items-center rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-[11px] font-semibold text-violet-300">
                        {r.contentType === 'MOVIE' ? t('typeMovie') : t('typeSeries')}
                      </span>
                    )}
                    {r.assignee && (
                      <span className="inline-flex items-center rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-semibold text-cyan-300">
                        {t('assigned')}: {r.assignee}
                      </span>
                    )}
                    <span className="text-[11px] font-bold text-slate-300">{r.user?.iptvUsername}</span>
                  </div>
                  <StatusBadge status={r.status} />
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-200">
                  {r.details}
                </p>
                {r.imageUrl && (
                  <a href={`${API_BASE}${r.imageUrl}`} target="_blank" rel="noreferrer">
                    <img
                      src={`${API_BASE}${r.imageUrl}`}
                      alt=""
                      loading="lazy"
                      className="mt-3 max-h-44 rounded-xl border border-slate-800 object-cover"
                    />
                  </a>
                )}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[10px] text-slate-500">{formatDate(lang, r.createdAt)}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Forward to VOD support — only on unassigned VOD tickets, hidden from the VOD agent */}
                    {r.category === 'VOD' && !r.assignee && !isVodAgent && (
                      <button
                        type="button"
                        onClick={() => forwardToVod(r)}
                        disabled={forwarding === r.id}
                        className="flex items-center gap-1.5 rounded-xl border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 text-[11px] font-bold text-violet-300 transition active:scale-95 hover:bg-violet-500/20 disabled:opacity-50"
                      >
                        {forwarding === r.id ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <Forward size={13} className="rtl:-scale-x-100" />
                        )}
                        {t('forwardToVod')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => chatFromReport(r)}
                      disabled={opening === r.userId}
                      className="flex items-center gap-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-[11px] font-bold text-cyan-300 transition active:scale-95 hover:bg-cyan-500/20 disabled:opacity-50"
                    >
                      {opening === r.userId ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <MessageSquarePlus size={13} />
                      )}
                      {t('openChat')}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleStatus(r)}
                      disabled={toggling === r.id}
                      className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-bold transition active:scale-95 disabled:opacity-50 ${
                        r.status === 'OPEN'
                          ? 'bg-emerald-600/90 text-white hover:bg-emerald-500'
                          : 'border border-slate-700 bg-slate-900 text-slate-300 hover:text-amber-300'
                      }`}
                    >
                      {toggling === r.id ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : r.status === 'OPEN' ? (
                        <CheckCircle2 size={13} />
                      ) : (
                        <Undo2 size={13} />
                      )}
                      {r.status === 'OPEN' ? t('markResolved') : t('reopen')}
                    </button>
                  </div>
                </div>

                {/* In-ticket support responses */}
                {(r.responses || []).length > 0 && (
                  <div className="mt-3 space-y-2 border-t border-slate-800 pt-3">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                      {t('adminResponses')}
                    </p>
                    {r.responses.map((resp) => (
                      <div key={resp.id} className="rounded-xl bg-slate-800/70 px-3 py-2">
                        <p className="text-[10px] font-semibold text-cyan-400">
                          {resp.senderName || 'Support'}
                        </p>
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-200">
                          {resp.text}
                        </p>
                        <p className="mt-1 text-[9px] text-slate-500">{formatDate(lang, resp.createdAt)}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Reply composer */}
                <div className="mt-3 flex items-center gap-2">
                  <input
                    value={replyText[r.id] || ''}
                    onChange={(e) =>
                      setReplyText((prev) => ({ ...prev, [r.id]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendReplyToReport(r.id);
                      }
                    }}
                    placeholder={t('replyPlaceholder')}
                    maxLength={2000}
                    className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-xs text-slate-100 placeholder-slate-500 outline-none transition focus:border-cyan-500/60"
                  />
                  <button
                    type="button"
                    onClick={() => sendReplyToReport(r.id)}
                    disabled={sendingReply === r.id || !(replyText[r.id] || '').trim()}
                    className="flex shrink-0 items-center gap-1.5 rounded-xl bg-cyan-600 px-3 py-2.5 text-[11px] font-bold text-white transition active:scale-95 hover:bg-cyan-500 disabled:opacity-50"
                  >
                    {sendingReply === r.id ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Send size={13} className="rtl:-scale-x-100" />
                    )}
                    <span className="hidden sm:inline">{t('sendReply')}</span>
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      )}

      {/* ---------------- Chat console ---------------- */}
      {tab === 'chats' && (
        <div className="md:grid md:grid-cols-[240px,1fr] md:gap-3">
          {/* Sessions list (hidden on mobile once a chat is open) */}
          <div className={`space-y-2 ${selected ? 'hidden md:block' : ''}`}>
            {/* Time filters + unread toggle */}
            <div className="flex flex-wrap items-center gap-1.5">
              {[
                { id: 'auto', label: t('filterToday') },
                { id: 'yesterday', label: t('filterYesterday') },
                { id: 'week', label: t('filterWeek') },
                { id: 'all', label: t('filterAll') },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setChatRange(f.id)}
                  className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition active:scale-95 ${
                    chatRange === f.id
                      ? 'bg-cyan-600 text-white'
                      : 'border border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {f.label}
                </button>
              ))}
              {/* Unread-only toggle */}
              <button
                type="button"
                onClick={() => setUnreadOnly((v) => !v)}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold transition active:scale-95 ${
                  unreadOnly
                    ? 'bg-rose-600 text-white'
                    : 'border border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'
                }`}
              >
                {unreadChats > 0 && (
                  <span className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-extrabold ${unreadOnly ? 'bg-white/20 text-white' : 'bg-rose-500 text-white'}`}>
                    {unreadChats}
                  </span>
                )}
                {t('filterUnread')}
              </button>
            </div>
            {/* Smart-default notice: quiet day → showing recent instead */}
            {chatRange === 'auto' && chatRangeApplied === 'recent' && (
              <p className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-[10px] text-slate-500">
                {t('showingRecent')}
              </p>
            )}

            {/* Search by username or message content */}
            <div className="relative">
              <Search size={15} className="absolute start-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={chatQuery}
                onChange={(e) => onChatQueryChange(e.target.value)}
                placeholder={t('searchChats')}
                className="w-full rounded-2xl border border-slate-700 bg-slate-900 py-2.5 pe-3 ps-10 text-xs text-slate-100 placeholder-slate-500 outline-none transition focus:border-cyan-500/60"
              />
              {searchingChats && (
                <Loader2 size={14} className="absolute end-3.5 top-1/2 -translate-y-1/2 animate-spin text-slate-500" />
              )}
            </div>

            {loadingChats && chatSearchResults === null ? (
              <div className="flex justify-center py-14 text-slate-500">
                <Loader2 size={22} className="animate-spin" />
              </div>
            ) : displayedSessions.length === 0 ? (
              <p className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-12 text-center text-xs text-slate-500">
                {unreadOnly
                  ? t('noUnread')
                  : chatSearchResults !== null
                    ? t('noResults')
                    : t('noChats')}
              </p>
            ) : (
              displayedSessions.map((s) => {
                const last = s.messages?.[0];
                const active = selected?.id === s.id;
                const unread = last && last.senderRole === 'USER' && isChatUnread(s.id, last.createdAt);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => openSession(s)}
                    className={`w-full rounded-2xl border p-3.5 text-start transition active:scale-[0.98] ${
                      active
                        ? 'border-cyan-500/50 bg-cyan-500/10'
                        : unread
                          ? 'border-cyan-500/40 bg-slate-900'
                          : 'border-slate-800 bg-slate-900/70 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-cyan-400" />}
                        <span className={`truncate text-xs font-bold ${unread ? 'text-white' : 'text-slate-200'}`}>
                          {s.user?.iptvUsername}
                        </span>
                      </span>
                      {last && (
                        <span className="shrink-0 text-[10px] text-slate-500">
                          {formatTime(lang, last.createdAt)}
                        </span>
                      )}
                    </div>
                    {last && (
                      <p className={`mt-1 truncate text-[11px] ${unread ? 'font-semibold text-slate-200' : 'text-slate-400'}`}>
                        {last.text || '📷'}
                      </p>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Message pane */}
          <div
            className={`flex min-h-[55vh] flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 ${
              selected ? '' : 'hidden md:flex'
            }`}
          >
            {selected ? (
              <>
                <div className="flex items-center gap-2 border-b border-slate-800 bg-slate-900 px-3.5 py-3">
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    className="rounded-lg p-1.5 text-slate-400 transition active:scale-90 md:hidden rtl:rotate-180"
                    aria-label="back"
                  >
                    <ChevronLeft size={17} />
                  </button>
                  <div>
                    <p className="text-xs font-bold text-slate-200">
                      {selected.user?.iptvUsername ||
                        sessions.find((s) => s.id === selected.id)?.user?.iptvUsername}
                    </p>
                    <p className="text-[10px] text-slate-500">{t('liveChat')}</p>
                  </div>
                </div>
                <div className="flex-1 space-y-3 overflow-y-auto px-3.5 py-4">
                  {messages.map((m) => (
                    <MessageBubble key={m.id} msg={m} mine={m.senderRole === 'ADMIN'} />
                  ))}
                </div>
                <ChatComposer onSend={sendReply} sending={sendingMsg} />
              </>
            ) : (
              <p className="flex flex-1 items-center justify-center p-10 text-center text-xs text-slate-500">
                {t('selectChat')}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ---------------- Users (chat trigger console) ---------------- */}
      {tab === 'users' && (
        <div className="space-y-2.5">
          {/* Search users by username */}
          <div className="relative">
            <Search size={15} className="absolute start-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={userQuery}
              onChange={(e) => setUserQuery(e.target.value)}
              placeholder={t('searchUsers')}
              className="w-full rounded-2xl border border-slate-700 bg-slate-900 py-2.5 pe-3 ps-10 text-xs text-slate-100 placeholder-slate-500 outline-none transition focus:border-cyan-500/60"
            />
          </div>

          {loadingUsers ? (
            <div className="flex justify-center py-14 text-slate-500">
              <Loader2 size={22} className="animate-spin" />
            </div>
          ) : filteredUsers.length === 0 ? (
            <p className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-12 text-center text-xs text-slate-500">
              {userQuery.trim() ? t('noResults') : t('noUsers')}
            </p>
          ) : (
            filteredUsers.map((u) => (
              <div
                key={u.id}
                className="flex items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/70 p-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-100">{u.iptvUsername}</p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {t('reportsOpen')}: {u.openReports} · {formatDate(lang, u.createdAt)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => startChatWith(u)}
                  disabled={opening === u.id}
                  className="flex shrink-0 items-center gap-1.5 rounded-xl bg-cyan-600 px-3.5 py-2 text-[11px] font-bold text-white transition active:scale-95 hover:bg-cyan-500 disabled:opacity-50"
                >
                  {opening === u.id ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <MessageSquarePlus size={13} />
                  )}
                  {t('startChat')}
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Bottom navigation */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-800 bg-slate-950/90 pb-safe backdrop-blur">
        <div className="mx-auto grid w-full max-w-3xl grid-cols-3">
          {navItems.map(({ id, label, icon: Icon, badge }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`relative flex flex-col items-center gap-1 py-2.5 text-[11px] font-semibold transition active:scale-90 ${
                tab === id ? 'text-cyan-400' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              <span className="relative">
                <Icon size={20} />
                {badge > 0 && (
                  <span className="absolute -end-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-extrabold text-white">
                    {badge}
                  </span>
                )}
              </span>
              {label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
