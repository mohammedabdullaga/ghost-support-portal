import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { translations } from './i18n.js';
import { loadAuth, saveAuth, clearAuth } from './api.js';
import { disconnectSocket } from './socket.js';
import Header from './components/Header.jsx';
import Login from './components/Login.jsx';
import UserDashboard from './components/UserDashboard.jsx';
import AdminDashboard from './components/AdminDashboard.jsx';

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

export default function App() {
  // Default language is Arabic (full RTL); persisted in localStorage.
  const [lang, setLang] = useState(() => localStorage.getItem('ghost_lang') || 'ar');
  const [auth, setAuthState] = useState(loadAuth);

  // Keep <html dir> and lang in sync — drives RTL/LTR for the whole SPA.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    localStorage.setItem('ghost_lang', lang);
  }, [lang]);

  const t = useCallback(
    (key) => translations[lang]?.[key] ?? translations.en[key] ?? key,
    [lang],
  );

  const setAuth = useCallback((value) => {
    saveAuth(value);
    setAuthState(value);
  }, []);

  const logout = useCallback(() => {
    clearAuth();
    disconnectSocket();
    setAuthState(null);
  }, []);

  const value = useMemo(
    () => ({ lang, setLang, t, auth, setAuth, logout }),
    [lang, t, auth, setAuth, logout],
  );

  return (
    <AppContext.Provider value={value}>
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <Header />
        <main className="mx-auto w-full max-w-3xl">
          {!auth ? (
            <Login />
          ) : auth.user.role === 'ADMIN' ? (
            <AdminDashboard key={auth.user.userId} />
          ) : (
            <UserDashboard key={auth.user.userId} />
          )}
        </main>
      </div>
    </AppContext.Provider>
  );
}
