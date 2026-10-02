import { Globe, Headset, LogOut } from 'lucide-react';
import { useApp } from '../App.jsx';

export default function Header() {
  const { t, lang, setLang, auth, logout } = useApp();

  return (
    <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="rounded-2xl bg-cyan-500/10 p-2 text-cyan-400">
            <Headset size={20} />
          </div>
          <div>
            <h1 className="text-sm font-bold leading-tight">{t('appName')}</h1>
            <p className="text-[11px] leading-tight text-slate-400">
              {auth?.user?.role === 'ADMIN'
                ? auth.user.agentName || t('adminTitle')
                : t('tagline')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
            className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200 transition active:scale-95 hover:border-cyan-500/50"
            aria-label="Toggle language"
          >
            <Globe size={14} />
            {lang === 'ar' ? 'EN' : 'عربي'}
          </button>

          {auth && (
            <button
              type="button"
              onClick={logout}
              className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200 transition active:scale-95 hover:border-rose-500/50 hover:text-rose-300"
              aria-label={t('logout')}
            >
              <LogOut size={14} />
              <span className="hidden sm:inline">{t('logout')}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
