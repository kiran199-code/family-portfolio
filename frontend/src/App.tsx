import { useEffect, useState } from 'react';
import { api, getToken, setToken } from './api';
import Dashboard from './pages/Dashboard';
import Transactions from './pages/Transactions';
import ImportPage from './pages/Import';
import Reports from './pages/Reports';
import Admin from './pages/Admin';

const PAGES: [string, string][] = [['dashboard', 'Dashboard'], ['transactions', 'Transactions'], ['import', 'Import'], ['reports', 'Reports'], ['admin', 'Admin']];

function Login({ onDone }: { onDone: () => void }) {
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [err, setErr] = useState<string | null>(null);
  const go = async (e: React.FormEvent) => { e.preventDefault(); try { const r = await api('POST', '/api/auth/login', { username: u, password: p }); setToken(r.token); onDone(); } catch (x: any) { setErr(x.message); } };
  return (
    <div className="wrap" style={{ maxWidth: 420, paddingTop: 80 }}>
      <form className="card" onSubmit={go}>
        <h1 style={{ fontSize: 26 }}>Family Portfolio</h1>
        <div className="form" style={{ gridTemplateColumns: '1fr' }}>
          <label className="fld"><span>Username</span><input type="text" value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" autoFocus /></label>
          <label className="fld"><span>Password</span><input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" /></label>
        </div>
        {err && <div className="banner-err" role="alert">{err}</div>}
        <div className="actions"><button className="btn primary" type="submit" disabled={!u || !p}>Sign in</button></div>
      </form>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const [page, setPage] = useState((location.hash.slice(1).split('/')[0]) || 'dashboard');
  const [theme, setTheme] = useState<string>(() => { try { return localStorage.getItem('fp_theme') ?? 'auto'; } catch { return 'auto'; } });
  useEffect(() => { const f = () => setAuthed(false); window.addEventListener('fp-logout', f); const h = () => setPage(location.hash.slice(1).split('/')[0] || 'dashboard'); window.addEventListener('hashchange', h); return () => { window.removeEventListener('fp-logout', f); window.removeEventListener('hashchange', h); }; }, []);
  useEffect(() => { if (theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', theme); try { localStorage.setItem('fp_theme', theme); } catch { /* ignore */ } }, [theme]);

  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return (
    <>
      <nav className="topnav" aria-label="Pages">
        {PAGES.map(([id, label]) => <a key={id} href={`#${id}`} className={page === id ? 'on' : ''}>{label}</a>)}
        <span className="grow" />
        <button className="lnk" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle theme">{theme === 'dark' ? 'Light' : 'Dark'}</button>
        <button className="lnk" onClick={() => { setToken(null); setAuthed(false); }}>Sign out</button>
      </nav>
      {page === 'transactions' ? <Transactions /> : page === 'import' ? <ImportPage /> : page === 'reports' ? <Reports /> : page === 'admin' ? <Admin /> : <Dashboard />}
    </>
  );
}
