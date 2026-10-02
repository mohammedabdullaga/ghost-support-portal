import { useState } from 'react';
import { Loader2, ShieldCheck, UserRound, KeyRound, BadgeCheck } from 'lucide-react';
import { useApp } from '../App.jsx';
import { api } from '../api.js';
import SliderChallenge from './SliderChallenge.jsx';

export default function Login() {
  const { t, setAuth } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [agentName, setAgentName] = useState('');
  const [needsAgentName, setNeedsAgentName] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [challenge, setChallenge] = useState(null); // proof payload once solved

  const errorText = (err) => {
    switch (err.code) {
      case 'INVALID_CREDENTIALS':
        return t('loginInvalid');
      case 'UPSTREAM_UNREACHABLE':
        return t('loginUnreachable');
      case 'ACCOUNT_LOCKED':
        return `${t('accountLocked')} (${t('lockedWait')} ${err.retryAfterSec || 300}${t('seconds')})`;
      case 'CHALLENGE_REQUIRED':
        return t('challengeRequired');
      case 'TOO_MANY_REQUESTS':
        return t('tooMany');
      default:
        return t('genericError');
    }
  };

  async function handleSubmit(e) {
    e.preventDefault();
    if (loading || !challenge) return;
    setError('');
    setLoading(true);
    try {
      const res = await api('/api/auth/login', {
        method: 'POST',
        body: {
          username: username.trim(),
          password,
          challenge,
          ...(needsAgentName ? { agentName: agentName.trim() } : {}),
        },
      });
      setAuth({ token: res.token, user: res.user });
    } catch (err) {
      if (err.code === 'AGENT_NAME_REQUIRED') {
        setNeedsAgentName(true);
        setError('');
      } else if (err.code === 'CHALLENGE_REQUIRED') {
        setChallenge(null); // force a fresh challenge
        setError(errorText(err));
      } else {
        setError(errorText(err));
      }
    } finally {
      setLoading(false);
    }
  }

  const inputCls =
    'w-full rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3.5 ps-11 text-sm text-slate-100 placeholder-slate-500 outline-none transition focus:border-cyan-500/60 focus:ring-2 focus:ring-cyan-500/20';

  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-2xl shadow-black/40">
          <div className="mb-6 flex flex-col items-center text-center">
            <div className="mb-3 rounded-2xl bg-cyan-500/10 p-3.5 text-cyan-400">
              <ShieldCheck size={30} />
            </div>
            <h2 className="text-lg font-bold">{t('appName')}</h2>
            <p className="mt-1 text-xs text-slate-400">{t('tagline')}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3.5">
            <div className="relative">
              <UserRound size={17} className="absolute start-4 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                className={inputCls}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t('username')}
                autoComplete="username"
                required
                maxLength={100}
              />
            </div>

            <div className="relative">
              <KeyRound size={17} className="absolute start-4 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="password"
                className={inputCls}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('password')}
                autoComplete="current-password"
                required
                maxLength={100}
              />
            </div>

            {needsAgentName && (
              <div className="space-y-2 rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-3.5">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-cyan-300">
                  <BadgeCheck size={13} />
                  {t('agentNameNote')}
                </p>
                <div className="relative">
                  <BadgeCheck size={17} className="absolute start-4 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    className={inputCls}
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    placeholder={`${t('agentName')} — ${t('agentNameHint')}`}
                    required
                    maxLength={60}
                  />
                </div>
              </div>
            )}

            {/* Proof-of-interaction: drag to the random target before login unlocks */}
            <SliderChallenge onSolved={setChallenge} />

            {error && (
              <p className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3.5 py-2.5 text-xs font-medium text-rose-300">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !challenge}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-cyan-600 py-3.5 text-sm font-bold text-white transition active:scale-[0.98] hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading && <Loader2 size={16} className="animate-spin" />}
              {loading ? t('loggingIn') : challenge ? t('login') : t('challengeSlide')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
