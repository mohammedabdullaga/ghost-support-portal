import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ClipboardList,
  ImagePlus,
  Loader2,
  MessageCircle,
  PlusCircle,
  X,
} from 'lucide-react';
import { useApp } from '../App.jsx';
import { api, uploadImage, API_BASE } from '../api.js';
import { getSocket, emitAck } from '../socket.js';
import { IMAGE_ACCEPT, MAX_IMAGE_BYTES, formatDate } from '../i18n.js';
import StatusBadge, { CategoryBadge } from './badges.jsx';
import ChatSheet from './ChatSheet.jsx';
import { markChatRead, isChatUnread } from '../unread.js';

const CATEGORIES = ['LIVE', 'VOD', 'SUGGESTION', 'OTHER'];

export default function UserDashboard() {
  const { t, lang, auth } = useApp();

  const [tab, setTab] = useState('new'); // 'new' | 'reports'
  const [reports, setReports] = useState([]);
  const [loadingReports, setLoadingReports] = useState(true);

  // New-report form
  const [category, setCategory] = useState('LIVE');
  const [contentType, setContentType] = useState('MOVIE'); // VOD only
  const [details, setDetails] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [formError, setFormError] = useState('');
  const [sendingReport, setSendingReport] = useState(false);
  const [toast, setToast] = useState('');
  const fileRef = useRef(null);

  // Live chat
  const [chatOpen, setChatOpen] = useState(false);
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [sendingMsg, setSendingMsg] = useState(false);
  const [invite, setInvite] = useState('');
  const [readTick, setReadTick] = useState(0);
  const chatOpenRef = useRef(false);
  useEffect(() => {
    chatOpenRef.current = chatOpen;
  }, [chatOpen]);

  const appendMessage = useCallback((msg) => {
    setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
  }, []);

  // Initial data: my reports + persisted chat history (survives re-login).
  useEffect(() => {
    let cancelled = false;
    api('/api/reports/my')
      .then((d) => !cancelled && setReports(d.reports))
      .catch(() => {})
      .finally(() => !cancelled && setLoadingReports(false));
    api('/api/chat/session')
      .then((d) => {
        if (cancelled) return;
        if (d.session) {
          setSession(d.session);
          setMessages(d.session.messages || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Socket: live messages, admin chat trigger, ticket status updates.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return undefined;

    const onMessage = (payload) => {
      if (payload.userId === auth.user.userId) {
        appendMessage(payload.message);
        // Agent messaged while the sheet is closed → notify + flag unread.
        if (payload.message.senderRole === 'ADMIN' && !chatOpenRef.current) {
          setInvite(payload.message.senderName || 'Support');
          setReadTick((x) => x + 1);
        }
      }
    };
    const onInvited = (payload) => {
      setInvite(payload.agentName || '');
      setChatOpen(true); // admin trigger pops the chat sheet in real time
      // Pull fresh history in case the session was created before mount.
      api('/api/chat/session')
        .then((d) => {
          if (d.session) {
            setSession(d.session);
            setMessages(d.session.messages || []);
            markChatRead(d.session.id); // opening = read (use fresh session id)
            setReadTick((x) => x + 1);
          }
        })
        .catch(() => {});
    };
    const onReportUpdate = (report) => {
      setReports((prev) => prev.map((r) => (r.id === report.id ? { ...report, responses: report.responses ?? r.responses } : r)));
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

    socket.on('chat:message', onMessage);
    socket.on('chat:invited', onInvited);
    socket.on('report:update', onReportUpdate);
    socket.on('report:response', onReportResponse);
    return () => {
      socket.off('chat:message', onMessage);
      socket.off('chat:invited', onInvited);
      socket.off('report:update', onReportUpdate);
      socket.off('report:response', onReportResponse);
    };
  }, [auth.user.userId, appendMessage]);

  // Auto-dismiss toasts
  useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  function pickFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
      setFormError(t('badType'));
      return;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      setFormError(t('tooLarge'));
      return;
    }
    setFormError('');
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  }

  function clearFile() {
    if (preview) URL.revokeObjectURL(preview);
    setFile(null);
    setPreview('');
  }

  async function submitReport(e) {
    e.preventDefault();
    if (sendingReport) return;
    const trimmed = details.trim();
    if (trimmed.length < 3) return;
    setFormError('');
    setSendingReport(true);
    try {
      let imageUrl = null;
      if (file) {
        try {
          const up = await uploadImage(file);
          imageUrl = up.url;
        } catch (err) {
          setFormError(
            err.code === 'FILE_TOO_LARGE' ? t('tooLarge') : t('uploadFailed'),
          );
          return;
        }
      }
      const res = await api('/api/reports', {
        method: 'POST',
        body: {
          category,
          details: trimmed,
          imageUrl,
          ...(category === 'VOD' ? { contentType } : {}),
        },
      });
      setReports((prev) => [res.report, ...prev]);
      setDetails('');
      clearFile();
      setCategory('LIVE');
      setToast(t('reportSent'));
      setTab('reports');
    } catch (err) {
      setFormError(err.code === 'DAILY_REPORT_LIMIT' ? t('dailyReportLimit') : t('genericError'));
    } finally {
      setSendingReport(false);
    }
  }

  async function sendChatMessage(text, attached) {
    setSendingMsg(true);
    try {
      let imageUrl = null;
      if (attached) {
        const up = await uploadImage(attached);
        imageUrl = up.url;
      }
      const ack = await emitAck('chat:send', { text, imageUrl });
      if (ack?.ok) {
        appendMessage(ack.message);
        setSession((prev) => prev ?? { id: ack.sessionId });
        return true;
      }
      return ack?.error || false;
    } catch {
      return false;
    } finally {
      setSendingMsg(false);
    }
  }

  // Unread: latest message is from an agent and newer than when I last opened chat
  void readTick;
  const lastMsg = messages[messages.length - 1];
  const chatUnread =
    !chatOpen &&
    session &&
    lastMsg &&
    lastMsg.senderRole === 'ADMIN' &&
    isChatUnread(session.id, lastMsg.createdAt);

  function openChat() {
    setChatOpen(true);
    setInvite('');
    if (session) markChatRead(session.id);
    setReadTick((x) => x + 1);
  }

  const navItems = [
    { id: 'reports', label: t('navReports'), icon: ClipboardList, dot: false },
    { id: 'new', label: t('navNew'), icon: PlusCircle, dot: false },
    { id: 'chat', label: t('navChat'), icon: MessageCircle, dot: chatUnread },
  ];

  return (
    <div className="px-4 pb-28 pt-5">
      {/* Toasts */}
      {(toast || invite) && (
        <div className="fixed inset-x-4 top-16 z-40 mx-auto max-w-md space-y-2">
          {toast && (
            <p className="flex items-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs font-semibold text-emerald-300 shadow-lg">
              <CheckCircle2 size={15} /> {toast}
            </p>
          )}
          {invite && (
            <button
              type="button"
              onClick={openChat}
              className="flex w-full items-center gap-2 rounded-2xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-start text-xs font-semibold text-cyan-300 shadow-lg transition active:scale-[0.98]"
            >
              <MessageCircle size={15} /> {t('chatInvite')} — {invite}
            </button>
          )}
        </div>
      )}

      {tab === 'new' && (
        <form onSubmit={submitReport} className="space-y-4">
          {/* Fast category chips */}
          <div className="grid grid-cols-2 gap-2.5">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={`rounded-2xl border px-3 py-3.5 text-xs font-bold transition active:scale-95 ${
                  category === c
                    ? 'border-cyan-500/60 bg-cyan-500/10 text-cyan-300'
                    : 'border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-700'
                }`}
              >
                {t(`cat${c}`)}
              </button>
            ))}
          </div>

          {/* Movie / Series toggle — only for VOD content requests */}
          {category === 'VOD' && (
            <div className="rounded-2xl border border-violet-500/20 bg-violet-500/5 p-3">
              <p className="mb-2 text-[11px] font-bold text-violet-300">{t('contentType')}</p>
              <div className="grid grid-cols-2 gap-2">
                {['MOVIE', 'SERIES'].map((ct) => (
                  <button
                    key={ct}
                    type="button"
                    onClick={() => setContentType(ct)}
                    className={`rounded-xl border px-3 py-2.5 text-xs font-bold transition active:scale-95 ${
                      contentType === ct
                        ? 'border-violet-500/60 bg-violet-500/15 text-violet-200'
                        : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {ct === 'MOVIE' ? t('typeMovie') : t('typeSeries')}
                  </button>
                ))}
              </div>
            </div>
          )}

          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder={t(`ph${category}`)}
            rows={4}
            maxLength={2000}
            required
            className="w-full resize-none rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3.5 text-sm text-slate-100 placeholder-slate-500 outline-none transition focus:border-cyan-500/60 focus:ring-2 focus:ring-cyan-500/20"
          />

          {/* Screenshot upload with preview */}
          <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} className="hidden" onChange={pickFile} />
          {preview ? (
            <div className="relative inline-block">
              <img
                src={preview}
                alt=""
                className="h-28 w-28 rounded-2xl border border-slate-700 object-cover"
              />
              <button
                type="button"
                onClick={clearFile}
                className="absolute -end-2 -top-2 rounded-full bg-slate-950 p-1.5 text-slate-300 ring-1 ring-slate-700 transition active:scale-90"
                aria-label={t('removeImage')}
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 px-4 py-4 text-xs font-semibold text-slate-400 transition active:scale-[0.98] hover:border-cyan-500/40 hover:text-cyan-400"
            >
              <ImagePlus size={16} />
              {t('attachScreenshot')}
            </button>
          )}

          {formError && (
            <p className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3.5 py-2.5 text-xs font-medium text-rose-300">
              {formError}
            </p>
          )}

          <button
            type="submit"
            disabled={sendingReport || details.trim().length < 3}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-cyan-600 py-3.5 text-sm font-bold text-white transition active:scale-[0.98] hover:bg-cyan-500 disabled:opacity-50"
          >
            {sendingReport && <Loader2 size={16} className="animate-spin" />}
            {sendingReport ? t('submitting') : t(`submit${category}`)}
          </button>
        </form>
      )}

      {tab === 'reports' && (
        <div className="space-y-3">
          {loadingReports ? (
            <div className="flex justify-center py-14 text-slate-500">
              <Loader2 size={22} className="animate-spin" />
            </div>
          ) : reports.length === 0 ? (
            <p className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-12 text-center text-xs text-slate-500">
              {t('noReports')}
            </p>
          ) : (
            reports.map((r) => (
              <article
                key={r.id}
                className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-sm"
              >
                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <CategoryBadge category={r.category} />
                    {r.category === 'VOD' && r.contentType && (
                      <span className="inline-flex items-center rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-[11px] font-semibold text-violet-300">
                        {r.contentType === 'MOVIE' ? t('typeMovie') : t('typeSeries')}
                      </span>
                    )}
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

                {/* Support responses on this ticket */}
                {(r.responses || []).length > 0 && (
                  <div className="mt-3 space-y-2 border-t border-slate-800 pt-3">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                      {t('adminResponses')}
                    </p>
                    {r.responses.map((resp) => (
                      <div key={resp.id} className="rounded-xl border border-cyan-500/15 bg-cyan-500/5 px-3 py-2">
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

                <p className="mt-3 text-[10px] text-slate-500">{formatDate(lang, r.createdAt)}</p>
              </article>
            ))
          )}
        </div>
      )}

      {/* Persistent chat bottom sheet */}
      <ChatSheet
        open={chatOpen}
        onClose={() => {
          setChatOpen(false);
          setInvite('');
        }}
        messages={messages}
        onSend={sendChatMessage}
        sending={sendingMsg}
      />

      {/* Mobile bottom navigation — haptic-feel active states */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-800 bg-slate-950/90 pb-safe backdrop-blur">
        <div className="mx-auto grid w-full max-w-3xl grid-cols-3">
          {navItems.map(({ id, label, icon: Icon, dot }) => {
            const active = id === 'chat' ? chatOpen : tab === id && !chatOpen;
            return (
              <button
                key={id}
                type="button"
                onClick={() => (id === 'chat' ? openChat() : setTab(id))}
                className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-semibold transition active:scale-90 ${
                  active ? 'text-cyan-400' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <span className="relative">
                  <Icon size={20} />
                  {dot && (
                    <span className="absolute -end-1 -top-1 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-slate-950" />
                  )}
                </span>
                {label}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
