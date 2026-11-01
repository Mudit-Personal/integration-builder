import { useState, type FormEvent } from 'react';
import { changePassword, initialsOf, updateProfile, type Account } from '../api.ts';
import { Button, Mono, PageTitle, Push, SectionHeading, TextField } from '../ds.tsx';

type Props = { account: Account; onAccount: (account: Account) => void; onBack: () => void; backLabel: string };
type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; message: string } | { kind: 'error'; message: string };

const Message = ({ status }: { status: Status }) =>
  status.kind === 'done' ? <p role="status" className="profile-note">{status.message}</p>
  : status.kind === 'error' ? <p role="alert" className="signup-error">{status.message}</p> : null;

export function Profile({ account, onAccount, onBack, backLabel }: Props) {
  const [name, setName] = useState(account.name);
  const [company, setCompany] = useState(account.workspace.name);
  const [details, setDetails] = useState<Status>({ kind: 'idle' });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [password, setPassword] = useState<Status>({ kind: 'idle' });
  const changed = name.trim() !== account.name || company.trim() !== account.workspace.name;

  const saveDetails = async (e: FormEvent) => {
    e.preventDefault();
    setDetails({ kind: 'busy' });
    const r = await updateProfile({ name, company });
    if (!r.ok) return setDetails({ kind: 'error', message: r.error });
    onAccount(r.value);
    setName(r.value.name);
    setCompany(r.value.workspace.name);
    setDetails({ kind: 'done', message: 'Saved.' });
  };
  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPassword({ kind: 'busy' });
    const r = await changePassword({ current, next });
    if (!r.ok) return setPassword({ kind: 'error', message: r.error });
    setCurrent('');
    setNext('');
    setPassword({ kind: 'done', message: 'Password changed. Any other device you were logged in on has been logged out.' });
  };

  return <main className="centered profile">
    <div className="profile-head">
      <span className="avatar avatar-lg" aria-hidden>{initialsOf({ email: account.email, name })}</span>
      <PageTitle title={account.name || 'Your profile'} lead={`${account.email}. Your email can't be changed.`} />
    </div>
    <form onSubmit={saveDetails} className="profile-section">
      <SectionHeading size="label">Your details</SectionHeading>
      <TextField label="Your name" value={name} onChange={v => { setName(v); setDetails({ kind: 'idle' }); }} autoComplete="name" />
      <TextField label="Company" value={company} onChange={v => { setCompany(v); setDetails({ kind: 'idle' }); }} autoComplete="organization" />
      <Message status={details} />
      <div className="footer-row"><Push /><Button type="submit" disabled={!changed || details.kind === 'busy'}>{details.kind === 'busy' ? 'Saving…' : 'Save'}</Button></div>
    </form>
    <form onSubmit={savePassword} className="profile-section">
      <SectionHeading size="label">Password</SectionHeading>
      <TextField label="Current password" type="password" value={current} onChange={v => { setCurrent(v); setPassword({ kind: 'idle' }); }} autoComplete="current-password" />
      <TextField label="New password" type="password" value={next} onChange={v => { setNext(v); setPassword({ kind: 'idle' }); }} autoComplete="new-password" />
      <Mono>At least 8 characters. Changing it logs you out everywhere else.</Mono>
      <Message status={password} />
      <div className="footer-row"><Push /><Button type="submit" variant="secondary" disabled={!current || next.length < 8 || password.kind === 'busy'}>{password.kind === 'busy' ? 'Changing…' : 'Change password'}</Button></div>
    </form>
    <div className="footer-row profile-back"><Button variant="link" onClick={onBack}>{backLabel}</Button></div>
  </main>;
}
