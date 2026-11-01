import { useState, type FormEvent } from 'react';
import { changePassword, initialsOf, updateProfile, type Account } from '../api.ts';
import { Button, Callout, KeyValueRow, Marker, Mono, PageTitle, Push, SectionHeading, SplitLayout, StatusLabel, TextField } from '../ds.tsx';

type Props = { account: Account; connectors: number | null; onAccount: (account: Account) => void; onBack: () => void; backLabel: string };
type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; message: string } | { kind: 'error'; message: string };

const Failed = ({ status }: { status: Status }) => (status.kind === 'error' ? <div role="alert"><Callout>{status.message}</Callout></div> : null);
const Done = ({ status }: { status: Status }) => (status.kind === 'done' ? <span role="status"><StatusLabel>{status.message}</StatusLabel></span> : null);

export function Profile({ account, connectors, onAccount, onBack, backLabel }: Props) {
  const [name, setName] = useState(account.name);
  const [company, setCompany] = useState(account.workspace.name);
  const [details, setDetails] = useState<Status>({ kind: 'idle' });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [password, setPassword] = useState<Status>({ kind: 'idle' });
  const changed = name.trim() !== account.name || company.trim() !== account.workspace.name;
  const longEnough = next.length >= 8;

  const saveDetails = async (e: FormEvent) => {
    e.preventDefault();
    setDetails({ kind: 'busy' });
    const r = await updateProfile({ name, company });
    if (!r.ok) return setDetails({ kind: 'error', message: r.error });
    onAccount(r.value);
    setName(r.value.name);
    setCompany(r.value.workspace.name);
    setDetails({ kind: 'done', message: 'Saved' });
  };
  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPassword({ kind: 'busy' });
    const r = await changePassword({ current, next });
    if (!r.ok) return setPassword({ kind: 'error', message: r.error });
    setCurrent('');
    setNext('');
    setPassword({ kind: 'done', message: 'Password changed' });
  };

  return <SplitLayout footer={<Button variant="link" onClick={onBack}>{backLabel}</Button>} panel={<>
    <SectionHeading lead="Your connectors are saved here, under this account.">Your workspace</SectionHeading>
    <KeyValueRow label="Company" value={account.workspace.name} />
    {connectors === null ? null : <KeyValueRow label="Connectors" value={connectors ? `${connectors} saved` : 'None yet'} />}
    <SectionHeading size="group" style={{ marginTop: 36 }}>Where these show</SectionHeading>
    <KeyValueRow label="Your name" value="Your initials, top right" /></>}>
    <div className="profile-head">
      <span className="avatar avatar-lg" aria-hidden>{initialsOf({ email: account.email, name })}</span>
      <PageTitle title={account.name || 'Your profile'} lead={<span style={{ font: 'var(--type-meta)', color: 'var(--text-meta)', overflowWrap: 'anywhere' }}>{account.email}</span>} />
    </div>
    <section className="profile-row">
      <div><h2>Your details</h2><p>How you appear in Integration Builder.</p></div>
      <form onSubmit={saveDetails} className="profile-section">
        <TextField label="Your name" value={name} onChange={v => { setName(v); setDetails({ kind: 'idle' }); }} autoComplete="name" />
        <TextField label="Company" value={company} onChange={v => { setCompany(v); setDetails({ kind: 'idle' }); }} autoComplete="organization" />
        <div style={{ borderTop: 'var(--rule-hair)' }}><KeyValueRow label={<span style={{ font: 'var(--type-label)' }}>Email</span>} value={<><span style={{ color: 'var(--text-strong)' }}>{account.email}</span> <Mono>Can't be changed</Mono></>} /></div>
        <Failed status={details} />
        <div className="footer-row profile-actions"><Done status={details} /><Push /><Button type="submit" disabled={!changed || details.kind === 'busy'}>{details.kind === 'busy' ? 'Saving…' : 'Save changes'}</Button></div>
      </form>
    </section>
    <section className="profile-row">
      <div><h2>Password</h2><p>Changing it logs you out on every other device.</p></div>
      <form onSubmit={savePassword} className="profile-section">
        <TextField label="Current password" type="password" value={current} onChange={v => { setCurrent(v); setPassword({ kind: 'idle' }); }} autoComplete="current-password" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <TextField label="New password" type="password" value={next} onChange={v => { setNext(v); setPassword({ kind: 'idle' }); }} autoComplete="new-password" />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}><Marker tone={longEnough ? 'done' : 'hollow'} style={longEnough ? undefined : { borderColor: 'var(--ink-4)' }} /><Mono>At least 8 characters</Mono></span>
        </div>
        <Failed status={password} />
        <div className="footer-row profile-actions"><Done status={password} /><Push /><Button type="submit" variant="secondary" disabled={!current || !longEnough || password.kind === 'busy'}>{password.kind === 'busy' ? 'Changing…' : 'Change password'}</Button></div>
      </form>
    </section>
  </SplitLayout>;
}
