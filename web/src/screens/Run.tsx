import { useEffect, useMemo, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import { maskEmail, maskName, runSync } from '../checks.ts';
import { applyDecisions } from '../decisions.ts';
import { Button, Callout, KeyValueRow, Mono, P, PageTitle, Push, SectionHeading, SplitLayout, StatusLabel } from '../ds.tsx';
import type { RunResult } from '../../../src/runtime.ts';
import { JOURNEYS } from '../journey.ts';
import { CODE } from '../state.ts';

type Sync = { kind: 'running' } | { kind: 'done'; result: RunResult; at: Date } | { kind: 'failed'; message: string };

const SHOWN = 6;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'Never');
const percent = (share: number) => `${Math.round(share * 100)}%`;

export function Run({ s, go, pack, name }: ScreenProps) {
  const m = useMemo(() => applyDecisions(pack.manifest, s.decisions), [pack, s.decisions]);
  const [round, setRound] = useState(0);
  const [sync, setSync] = useState<Sync>({ kind: 'running' });
  useEffect(() => {
    let live = true;
    setSync({ kind: 'running' });
    runSync(m, s.decisions).then(
      result => { if (live) setSync({ kind: 'done', result, at: new Date() }); },
      (e: Error) => { if (live) setSync({ kind: 'failed', message: e.message }); },
    );
    return () => { live = false; };
  }, [m, s.decisions, round]);

  const people = JOURNEYS[s.audience].run === 'people';
  const footer = <><Button variant="link" onClick={() => go(CODE)}>{people ? 'Back' : 'Back to code'}</Button><Push /><Button variant="secondary" disabled={sync.kind === 'running'} onClick={() => setRound(r => r + 1)}>Run again</Button></>;
  if (sync.kind !== 'done') {
    return <SplitLayout footer={footer} panel={people ? <SectionHeading lead={`A preview on a simulated copy of ${name}. Nothing touches your real account.`}>Preview</SectionHeading> : <SectionHeading lead="The generated connector runs here exactly as it will in your app, against a simulated vendor.">First sync</SectionHeading>}>
      <PageTitle title={sync.kind === 'running' ? (people ? `Finding your ${name} people…` : `Syncing ${name}…`) : "The sync didn't finish"} />
      {sync.kind === 'failed' ? <Callout style={{ marginTop: 28 }}>{sync.message}</Callout> : null}
    </SplitLayout>;
  }

  const { users, usage, streams, stats, quality, reconcile } = sync.result;
  const tiles: [string, string][] = [
    ['People synced', String(users.length)],
    ['Pages read', String(streams.users.pages)],
    ['Requests', String(stats.requests)],
    ['Email coverage', percent(quality.emailCoverage)],
  ];
  const reconcileNote = <P>{!reconcile.allowed ? reconcile.reason : people ? 'It read the whole list, so anyone missing next time has really left.' : 'Every page was read, so anyone missing from this sync can be treated as gone.'}</P>;
  return <SplitLayout footer={footer} panel={people ? <>
    <SectionHeading lead={`Once your developer sets it up, this runs on a schedule with your own ${name} account. This preview used a simulated copy.`}>What happens next</SectionHeading>
    <KeyValueRow label="Safe to remove missing people" value={reconcile.allowed ? 'Yes' : 'No'} />
    <KeyValueRow label="Sent to your real account" value="Nothing" />
    {reconcileNote}</> : <>
    <SectionHeading lead={`In your app this runs on a schedule with your own ${name} credentials. Here it ran against the simulator.`}>Running it for real</SectionHeading>
    <KeyValueRow label="Last sync" value={sync.at.toLocaleTimeString(undefined, { timeStyle: 'short' })} />
    <KeyValueRow label="People" value={`${streams.users.status}, ${streams.users.pages} ${streams.users.pages === 1 ? 'page' : 'pages'}`} />
    <KeyValueRow label="Usage events" value={streams.usage.status === 'complete' ? String(usage.length) : 'Left out'} />
    <KeyValueRow label="Safe to remove missing people" value={reconcile.allowed ? 'Yes' : 'No'} />
    <KeyValueRow label="Sent to the real API" value="0" />
    {reconcileNote}</>}>
    {people ? <PageTitle title="Here are your people" lead={`We found ${users.length} people in a simulated copy of ${name}, the same way it will read your real account. Names and emails are masked.`} aside={<StatusLabel size="lg">Preview complete</StatusLabel>} />
      : <><PageTitle title={`${users.length} people synced from ${name}`} lead={`The generated connector ran once, the same way it will in your app. ${stats.requests} requests in ${stats.elapsedMs} ms, all to a simulated ${name}.`} aside={<StatusLabel size="lg">Sync complete</StatusLabel>} />
      <div className="stats">{tiles.map(([label, value]) => <div key={label} className="stat"><span className="stat-value">{value}</span><span style={{ color: 'var(--text-muted)' }}>{label}</span></div>)}</div></>}
    <SectionHeading size="group" style={{ marginTop: 40 }}>People, as everyone sees them</SectionHeading>
    {users.slice(0, SHOWN).map(u => <div key={u.externalId} className="person-row">
      <span style={{ color: 'var(--text-strong)' }}>{maskName(u.displayName)}</span>
      <Mono c="var(--ink-2)">{maskEmail(u.email)}</Mono>
      <Mono>{u.role ?? 'user'}</Mono>
      <Mono>{u.status}</Mono>
      {quality.lastActiveCoverage ? <Mono>{day(u.lastActiveAt)}</Mono> : <span />}
    </div>)}
    <div style={{ fontSize: 14, color: 'var(--ink-2)', marginTop: 10 }}>{users.length > SHOWN ? `${users.length - SHOWN} more. ` : ''}Made-up people from the simulator, masked for every role.</div>
  </SplitLayout>;
}
