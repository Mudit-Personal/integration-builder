import { useEffect, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import { Button, Callout, CheckItem, KeyValueRow, P, PageTitle, Push, SectionHeading, SplitLayout } from '../ds.tsx';
import { hostFrom, type LiveRead } from '../live.ts';
import { DECIDE, SOURCE } from '../state.ts';

const STEP_MS = 420;

const tokens = (n: number) => `${Math.round(n / 1000)}k`;

function Elapsed() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds(v => v + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <KeyValueRow label="Elapsed" value={`${seconds}s`} />;
}

const HOW_READ = <SectionHeading lead="An AI reads the docs and drafts a connector. Anything it claims has to quote the source, or it fails review.">How this is read</SectionHeading>;

export function LiveReading({ read, url, go, onPaste }: { read: Exclude<LiveRead, { kind: 'idle' }>; url: string; go: (step: number) => void; onPaste: (text: string) => void }) {
  const [text, setText] = useState('');
  const host = hostFrom(url) ?? 'this site';
  const back = <Button variant="link" onClick={() => go(SOURCE)}>Back</Button>;
  if (read.kind === 'reading') {
    return <SplitLayout footer={back} panel={<>{HOW_READ}<Elapsed /></>}>
      <PageTitle title={`Reading ${host}'s documentation…`} lead="This usually takes 1 to 3 minutes." />
      <div className="stream" style={{ borderTop: 'var(--rule-strong)', marginTop: 28 }}>
        {read.messages.map((m, i) => <CheckItem key={`${i}${m}`} title={m} status={i === read.messages.length - 1 ? 'live' : 'done'} />)}
      </div>
    </SplitLayout>;
  }
  if (read.kind === 'paste') {
    return <SplitLayout footer={<>{back}<Push /><Button disabled={!text.trim()} onClick={() => onPaste(text)}>Read pasted text</Button></>} panel={HOW_READ}>
      <PageTitle title={`Paste ${host}'s docs`} lead={read.message} />
      <label style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 36, font: 'var(--type-label)', color: 'var(--text-strong)' }}>Documentation text
        <textarea className="paste" rows={14} value={text} onChange={e => setText(e.target.value)} />
      </label>
    </SplitLayout>;
  }
  return <SplitLayout footer={back} panel={HOW_READ}>
    <PageTitle title="We couldn't finish reading these docs" />
    <Callout style={{ marginTop: 28 }}>{read.message}</Callout>
  </SplitLayout>;
}

export function Read({ s, go, pack, name }: ScreenProps) {
  const steps = pack.readSteps;
  const live = !!s.live;
  const [n, setN] = useState(live ? steps.length : 0);
  const [run, setRun] = useState(0);
  useEffect(() => {
    if (live) return;
    setN(0);
    const timer = setInterval(() => setN(v => {
      if (v + 1 >= steps.length) clearInterval(timer);
      return v + 1;
    }), STEP_MS);
    return () => clearInterval(timer);
  }, [run, steps.length, live]);
  const done = n >= steps.length;
  return <SplitLayout footer={<><Button variant="link" onClick={() => go(SOURCE)}>Back</Button>{live ? null : <Button variant="secondary" onClick={() => setRun(r => r + 1)}>Replay</Button>}<Push /><Button disabled={!done} onClick={() => go(DECIDE)}>Review decisions</Button></>} panel={<>
    <SectionHeading lead={live ? 'An AI read these docs just now. Findings show the quote behind them, and anything without one is marked.' : 'An AI read these docs ahead of time, and this replays that read step by step. Every finding shows the quote it came from. To read a new API live, paste its docs link on Source.'}>How this was read</SectionHeading>
    <KeyValueRow monoLabel label="Read from docs" value="Backed by a quote" />
    <KeyValueRow monoLabel label="No quote, review it" value="An assumption" />
    <KeyValueRow monoLabel label="Marked for review" value="For a person" />
    {pack.read ? <>
      <SectionHeading size="label" style={{ marginTop: 36 }}>This read</SectionHeading>
      <KeyValueRow label="Attempts" value={pack.read.attempts} />
      <KeyValueRow label="Tokens" value={`${tokens(pack.read.inputTokens)} in · ${tokens(pack.read.outputTokens)} out`} /></> : null}
    <SectionHeading size="label" style={{ marginTop: 36 }}>Fingerprint</SectionHeading>
    <P>The result is fingerprinted as <code>{pack.hash}</code>.</P></>}>
    <PageTitle title={done ? `${name}'s documentation is mapped` : `Mapping ${name}'s documentation…`} lead={done ? `${steps.length} steps done. Nothing has been generated yet.` : live ? 'Showing what the read found.' : `Replaying an AI read of ${name}'s docs, with the quote behind each finding.`} />
    <div style={{ borderTop: 'var(--rule-strong)', marginTop: 28 }}>{steps.map((r, i) => <CheckItem key={r.title} title={r.title} description={r.description} waiting={i >= n} meta={i < n ? r.meta : ''} status={i < n ? 'done' : i === n ? 'live' : 'pending'} />)}</div>
  </SplitLayout>;
}
