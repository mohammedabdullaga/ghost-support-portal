import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Loader2, Send, X } from 'lucide-react';
import { useApp } from '../App.jsx';
import { API_BASE } from '../api.js';
import { IMAGE_ACCEPT, MAX_IMAGE_BYTES, formatTime } from '../i18n.js';

/** One chat bubble. Agent bubbles carry the agent's display name. */
export function MessageBubble({ msg, mine }) {
  const { t, lang } = useApp();
  return (
    <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
      {!mine && msg.senderRole === 'ADMIN' && msg.senderName && (
        <span className="mb-1 px-1 text-[10px] font-semibold text-cyan-400">{msg.senderName}</span>
      )}
      <div
        className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow ${
          mine
            ? 'rounded-br-md bg-cyan-600 text-white'
            : 'rounded-bl-md bg-slate-800 text-slate-100'
        }`}
      >
        {msg.imageUrl && (
          <a href={`${API_BASE}${msg.imageUrl}`} target="_blank" rel="noreferrer">
            <img
              src={`${API_BASE}${msg.imageUrl}`}
              alt={t('attach')}
              loading="lazy"
              className="mb-1.5 max-h-56 rounded-xl object-cover"
            />
          </a>
        )}
        {msg.text && <p className="whitespace-pre-wrap break-words">{msg.text}</p>}
      </div>
      <span className="mt-1 px-1 text-[10px] text-slate-500">{formatTime(lang, msg.createdAt)}</span>
    </div>
  );
}

/** Text + image composer with client-side pre-validation (4MB / JPEG-PNG-WEBP). */
export function ChatComposer({ onSend, sending }) {
  const { t } = useApp();
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  function pickFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
      setError(t('badType'));
      return;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      setError(t('tooLarge'));
      return;
    }
    setError('');
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  }

  function clearFile() {
    if (preview) URL.revokeObjectURL(preview);
    setFile(null);
    setPreview('');
  }

  async function submit() {
    const value = text.trim();
    if ((!value && !file) || sending) return;
    setError('');
    const result = await onSend(value, file);
    if (result === true) {
      setText('');
      clearFile();
    } else {
      setError(result === 'CHAT_RATE_LIMIT' ? t('chatTooFast') : t('genericError'));
    }
  }

  return (
    <div className="border-t border-slate-800 bg-slate-900 p-3 pb-safe">
      {preview && (
        <div className="relative mb-2.5 inline-block">
          <img src={preview} alt="" className="h-16 w-16 rounded-xl border border-slate-700 object-cover" />
          <button
            type="button"
            onClick={clearFile}
            className="absolute -end-1.5 -top-1.5 rounded-full bg-slate-950 p-1 text-slate-300 ring-1 ring-slate-700 transition active:scale-90"
            aria-label={t('removeImage')}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {error && <p className="mb-2 text-[11px] font-medium text-rose-400">{error}</p>}
      <div className="flex items-center gap-2">
        <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} className="hidden" onChange={pickFile} />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="rounded-2xl border border-slate-700 bg-slate-800 p-3 text-slate-300 transition active:scale-95 hover:border-cyan-500/50 hover:text-cyan-400"
          aria-label={t('attach')}
        >
          <ImagePlus size={18} />
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t('typeMessage')}
          maxLength={2000}
          className="min-w-0 flex-1 rounded-2xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm text-slate-100 placeholder-slate-500 outline-none transition focus:border-cyan-500/60"
        />
        <button
          type="button"
          onClick={submit}
          disabled={sending || (!text.trim() && !file)}
          className="rounded-2xl bg-cyan-600 p-3 text-white transition active:scale-95 hover:bg-cyan-500 disabled:opacity-50"
          aria-label={t('typeMessage')}
        >
          {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} className="rtl:-scale-x-100" />}
        </button>
      </div>
    </div>
  );
}

/**
 * Mobile bottom-sheet live chat. Renders full history from the DB and streams
 * new messages over the authenticated socket.
 */
export default function ChatSheet({ open, onClose, messages, onSend, sending }) {
  const { t, auth } = useApp();
  const scrollRef = useRef(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [open, messages.length]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label="close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div className="relative flex h-[82vh] flex-col overflow-hidden rounded-t-2xl border-t border-slate-700 bg-slate-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
            </span>
            <div>
              <h3 className="text-sm font-bold">{t('liveChat')}</h3>
              <p className="text-[10px] text-slate-400">{t('supportOnline')}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-700 bg-slate-800 p-2 text-slate-300 transition active:scale-95"
            aria-label="close"
          >
            <X size={16} />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.map((m) => (
            <MessageBubble key={m.id} msg={m} mine={m.senderRole === 'USER' && auth.user.role === 'USER'} />
          ))}
          {messages.length === 0 && (
            <p className="pt-10 text-center text-xs text-slate-500">{t('typeMessage')}</p>
          )}
        </div>

        <ChatComposer onSend={onSend} sending={sending} />
      </div>
    </div>
  );
}
