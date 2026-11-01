import { useState } from 'react';
import { AppChip, Button, Checkbox, Mono, P, PageTitle, Push, SectionHeading, SplitLayout, TextField, ToggleGroup } from '../ds.tsx';
import { hostFrom } from '../live.ts';
import { matchApp } from '../pack.ts';
import { APPS, READ, type Action, type Flow } from '../state.ts';

const CHIPS = 7;
// With 40+ apps, alphabetical chips would open on 1Password and Adobe. Lead with the best-known apps instead.
const FEATURED = ['slack', 'github', 'jira-cloud', 'notion', 'okta', 'calendly', 'hubspot', 'zoom'];
const rank = (slug: string) => (FEATURED.indexOf(slug) + 1 || FEATURED.length + 1);
const BY_FEATURED = [...APPS].sort((a, b) => rank(a.slug) - rank(b.slug));

const NEXT = ['We read the documentation and work out how the API is built.', 'You get a list of every decision: what came from the docs, what we chose, what we need from you.', 'We test a simulated copy of the API, built from its docs, with safeguards on and results stored for replay.', 'You get code to drop into your app.'];

type Props = { s: Flow; dispatch: (a: Action) => void; go: (step: number) => void; code: string; setCode: (code: string) => void; onRead: (url: string) => void };

export function Source({ s, dispatch, go, code, setCode, onRead }: Props) {
  const [search, setSearch] = useState('');
  const known = matchApp(APPS, s.url);
  const q = search.trim().toLowerCase();
  const matches = q ? APPS.filter(a => `${a.name} ${a.host}`.toLowerCase().includes(q)) : BY_FEATURED;
  const chips = matches.slice(0, CHIPS);
  // A saved connector may be further down the list than the chips reach.
  if (known && matches.includes(known) && !chips.includes(known)) chips[CHIPS - 1] = known;
  const url = s.url.trim();
  // Already read, by us earlier or live just now. Nothing to spend.
  const ready = !!known || (!!url && s.live?.url === url);
  const needsCode = !ready && !!url;
  const host = known?.host ?? hostFrom(s.url) ?? 'this API';
  const d = s.decisions;
  const always = (label: string) => <span>{label} <Mono>always</Mono></span>;
  const toggle = (key: 'usage' | 'caching') => (v: boolean) => dispatch({ type: 'decide', patch: { deliverables: { ...d.deliverables, [key]: v } } });
  const rows = [
    { label: always('API client'), description: `Typed client for ${host}`, checked: true },
    { label: always('Auth setup'), description: 'Sign-in and token handling', checked: true },
    { label: always('Users'), description: 'Everyone in your organization and their role', checked: true },
    { label: 'Usage data', description: 'Activity records, where the API has them', checked: d.deliverables.usage, onChange: toggle('usage') },
    { label: always('Error handling'), description: 'Typed errors, retries and rate limits', checked: true },
    { label: always('Pagination'), description: 'Walks every page for you', checked: true },
    { label: always('Logging'), description: 'Structured logs with secrets redacted', checked: true },
    { label: 'Response caching', description: 'Optional. Cache results for a few minutes', checked: d.deliverables.caching, onChange: toggle('caching') },
  ];
  return <SplitLayout footer={<><Push /><Button disabled={!ready && !(url && code)} onClick={() => (ready ? go(READ) : onRead(url))}>Read the docs</Button></>} panel={<>
    <SectionHeading>What happens next</SectionHeading>
    {NEXT.map((t, i) => <div key={i} style={{ display: 'flex', gap: 28, padding: '16px 0', borderBottom: 'var(--rule-hair)' }}><Mono>{i + 1}</Mono><span>{t}</span></div>)}
    <SectionHeading size="label" style={{ marginTop: 36 }}>Safe by default</SectionHeading>
    <P>Read-only requests. One destination. Tokens never in code or logs.</P></>}>
    <PageTitle title="Connect an API" lead="Pick a known API or paste a link to its documentation. We'll read it and generate integration code for your app." />
    <TextField label="API documentation link" mono value={s.url} onChange={url => dispatch({ type: 'url', url })} style={{ marginTop: 36 }} />
    {needsCode ? <>
      <TextField label="Access code" type="password" value={code} onChange={setCode} style={{ marginTop: 20 }} />
      <div style={{ font: '400 14px/1.45 var(--font-sans)', color: s.read.kind === 'denied' ? 'var(--text-strong)' : 'var(--text-muted)', marginTop: 10 }}>{s.read.kind === 'denied' ? s.read.message : 'Live reading uses AI. Ask whoever shared this link for the code.'}</div>
    </> : null}
    <TextField label="Search apps" value={search} onChange={setSearch} style={{ marginTop: 20 }} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
      {chips.map(a => <AppChip key={a.slug} name={a.name} icon={a.logo ? `./apps/${a.logo}` : undefined} selected={known?.slug === a.slug} onClick={() => dispatch({ type: 'pick', app: a })} />)}
    </div>
    <div aria-live="polite" style={{ font: '400 14px/1.45 var(--font-sans)', color: 'var(--text-muted)', marginTop: 10 }}>{!matches.length ? 'No matches. Paste a link to the documentation instead.' : matches.length > CHIPS ? `Showing ${CHIPS} of ${matches.length}. Search to find the rest.` : null}</div>
    <SectionHeading size="label" style={{ marginTop: 36 }}>What should we generate?</SectionHeading>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(260px,100%),1fr))', columnGap: 32 }}>
      {rows.map((r, i) => <Checkbox key={i} checked={r.checked} disabled={!r.onChange} onChange={r.onChange} label={r.label} description={r.description} />)}
    </div>
    <div style={{ font: 'var(--type-label)', margin: '32px 0 12px' }}>Who's setting this up?</div>
    <ToggleGroup options={['Developer', 'Not a developer']} value={s.audience} onChange={v => dispatch({ type: 'set', patch: { audience: v as Flow['audience'] } })} />
    <div style={{ font: '400 14px/1.45 var(--font-sans)', color: 'var(--text-muted)', marginTop: 10 }}>{s.audience === 'Developer' ? 'We show the technical detail and the code first.' : 'We explain every decision in plain words, and hand you a prompt to pass to your developer or AI tool.'}</div>
    <div style={{ font: 'var(--type-label)', margin: '32px 0 12px' }}>Your stack</div>
    <Mono>TypeScript · Node 24 · native fetch</Mono>
  </SplitLayout>;
}
