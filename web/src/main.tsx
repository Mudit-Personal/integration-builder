import './shims/globals.ts';
import './app.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { currentSession, logOut, type Account, type Session } from './api.ts';
import { App } from './App.tsx';
import { AuthPage } from './screens/Auth.tsx';
import { Landing } from './screens/Landing.tsx';

/**
 * The landing page owns the root URL. #signup and #login let people in. The app lives under #app and needs a session;
 * #app/new?url= opens a new connector on that link. A docs link typed on the landing page rides along through sign-up.
 */
const urlIn = (hash: string) => new URLSearchParams(hash.split('?')[1]).get('url') ?? undefined;
const newConnector = (url?: string) => (url ? `app/new?url=${encodeURIComponent(url)}` : 'app/new');
const routeOf = (hash: string) => (hash.startsWith('#app') ? 'app' : hash.startsWith('#signup') ? 'signup' : hash.startsWith('#login') ? 'login' : 'landing');

function Root() {
  const [hash, setHash] = useState(location.hash);
  const [session, setSession] = useState<Session>({ kind: 'checking' });
  useEffect(() => {
    const onHash = () => { setHash(location.hash); window.scrollTo(0, 0); };
    addEventListener('hashchange', onHash);
    let tries = 0;
    const check = () => currentSession().then(setSession, () => { if (++tries < 4) setTimeout(check, 1000 * tries); else setSession({ kind: 'out' }); });
    check();
    return () => removeEventListener('hashchange', onHash);
  }, []);
  const route = routeOf(hash);
  const go = (to: string) => { location.hash = to; };
  const signedIn = (account: Account, to: string) => { setSession({ kind: 'in', account }); go(to); };

  // Someone already in skips the forms, and someone out is asked to log in first.
  useEffect(() => {
    const to = session.kind === 'in' && route === 'signup' ? `#${newConnector(urlIn(hash))}`
      : session.kind === 'in' && route === 'login' ? '#app'
      : session.kind === 'out' && route === 'app' ? '#login' : null;
    if (!to) return;
    history.replaceState(null, '', to);
    setHash(to);
  }, [session.kind, route]);

  if (route === 'landing') {
    return <Landing signedIn={session.kind === 'in'} onLogIn={() => go('app')} onStart={url => go(session.kind === 'in' ? newConnector(url) : url ? `signup?url=${encodeURIComponent(url)}` : 'signup')} />;
  }
  if (session.kind === 'checking' || (session.kind === 'in') !== (route === 'app')) return <div className="landing" />;
  if (session.kind === 'in') {
    return <App key={session.account.email} account={session.account} start={hash.startsWith('#app/new') ? { url: urlIn(hash) } : null}
      profile={hash.startsWith('#app/profile')} onProfile={open => { if (open !== hash.startsWith('#app/profile')) go(open ? 'app/profile' : 'app'); }}
      onAccount={account => setSession({ kind: 'in', account })}
      onLogOut={() => { void logOut().then(() => { setSession({ kind: 'out' }); go(''); }); }} />;
  }
  const mode = route === 'signup' ? 'signup' : 'login';
  return <AuthPage key={mode} mode={mode} onHome={() => go('')} onSwitch={() => go(mode === 'signup' ? 'login' : 'signup')}
    onIn={account => signedIn(account, mode === 'signup' ? newConnector(urlIn(hash)) : 'app')} />;
}

createRoot(document.getElementById('root')!).render(<Root />);
