import { useState, type FormEvent } from 'react';
import { logIn, signUp, type Account, type Outcome } from '../api.ts';
import { FACE, SIDE } from './Landing.tsx';

const PLATES = 6;

export type AuthMode = 'signup' | 'login';

const COPY: Record<AuthMode, { title: string; lead: string; submit: string; busy: string; switchText: string; switchLink: string; password: string }> = {
  signup: {
    title: 'Create your workspace', lead: 'Next you pick the app you want to connect.', submit: 'Continue', busy: 'Creating your workspace…',
    switchText: 'Already joined?', switchLink: 'Log in', password: 'At least 8 characters',
  },
  login: {
    title: 'Log in', lead: 'Pick up where you left off.', submit: 'Log in', busy: 'Logging in…',
    switchText: 'New to Integration Builder?', switchLink: 'Create a workspace', password: '',
  },
};

type Props = { mode: AuthMode; onHome: () => void; onSwitch: () => void; onIn: (account: Account) => void };

export function AuthPage({ mode, onHome, onSwitch, onIn }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [company, setCompany] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[mode];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r: Outcome<Account> = mode === 'signup' ? await signUp({ email, password, company }) : await logIn({ email, password });
    setBusy(false);
    if (r.ok) onIn(r.value);
    else setError(r.error);
  };
  return <div className="landing signup">
    <header className="landing-header signup-header">
      <a href="#" onClick={e => { e.preventDefault(); onHome(); }} className="landing-brand landing-link" style={{ textDecoration: 'none' }}><span style={{ width: 10, height: 10, background: 'var(--blue)' }} />Integration Builder</a>
    </header>
    <main className="signup-main">
      <div className="signup-copy">
        <h1>{copy.title}</h1>
        <p className="signup-lead">{copy.lead}</p>
        <form onSubmit={submit} className="signup-form" aria-describedby={error ? 'auth-error' : undefined}>
          <div>
            <label htmlFor="auth-email">Work email</label>
            <input id="auth-email" type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />
          </div>
          <div>
            <label htmlFor="auth-password">Password</label>
            <input id="auth-password" type="password" required minLength={mode === 'signup' ? 8 : undefined} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              placeholder={copy.password || undefined} value={password} onChange={e => setPassword(e.target.value)} />
          </div>
          {mode === 'signup' ? <div>
            <label htmlFor="auth-company">Company</label>
            <input id="auth-company" required autoComplete="organization" value={company} onChange={e => setCompany(e.target.value)} />
          </div> : null}
          {error ? <p id="auth-error" role="alert" className="signup-error">{error}</p> : null}
          <button type="submit" disabled={busy}>{busy ? copy.busy : copy.submit}</button>
        </form>
        <p className="signup-lead" style={{ fontSize: 16, marginTop: 16 }}>{copy.switchText} <a href={mode === 'signup' ? '#login' : '#signup'} onClick={e => { e.preventDefault(); onSwitch(); }} className="landing-link">{copy.switchLink}</a></p>
      </div>
      <div className="signup-stack" aria-hidden="true">
        {Array.from({ length: PLATES }, (_, i) => <svg key={i} viewBox="0 0 460 190" style={{ top: `${(i * 12.5).toFixed(1)}%`, zIndex: PLATES - i }}>
          <path d={SIDE} style={{ fill: 'var(--paper)', stroke: 'var(--ink)', strokeWidth: 1.25 }} />
          <path d={FACE} style={{ fill: 'var(--paper)', stroke: 'var(--ink)', strokeWidth: 1.25 }} />
        </svg>)}
      </div>
    </main>
  </div>;
}
