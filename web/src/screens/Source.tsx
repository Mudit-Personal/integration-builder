import { useState } from 'react';
import { AppChip, Button, Checkbox, Mono, P, PageTitle, Push, SectionHeading, SplitLayout, TextField, ToggleGroup } from '../ds.tsx';
import { LEFT_OUT, type Deliverable } from '../decisions.ts';
import { hostFrom } from '../live.ts';
import { matchApp } from '../pack.ts';
import { AUDIENCES, JOURNEYS } from '../journey.ts';
import { APPS, type Action, type Flow } from '../state.ts';

const CHIPS = 7;
// With 40+ apps, alphabetical chips would open on 1Password and Adobe. Lead with the best-known apps instead.
const FEATURED = ['slack', 'github', 'jira-cloud', 'notion', 'okta', 'calendly', 'hubspot', 'zoom'];
const rank = (slug: string) => (FEATURED.indexOf(slug) + 1 || FEATURED.length + 1);
const BY_FEATURED = [...APPS].sort((a, b) => rank(a.slug) - rank(b.slug));

type Props = { s: Flow; dispatch: (a: Action) => void; go: (step: number) => void; onRead: (url: string) => void };

export function Source({ s, dispatch, go, onRead }: Props) {
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
  const host = known?.host ?? hostFrom(s.url) ?? 'this API';
  const d = s.decisions;
  const j = JOURNEYS[s.audience];
  const all: [Deliverable, string, string][] = [
    ['client', 'API client', `Typed client for ${host}`],
    ['auth', 'Auth setup', 'Sign-in and token handling'],
    ['users', 'Users', 'Everyone in your organization and their role'],
    ['usage', 'Usage data', 'Activity records, where the API has them'],
    ['errors', 'Error handling', 'Typed errors, retries and rate limits'],
    ['pagination', 'Pagination', 'Walks every page for you'],
    ['logging', 'Logging', 'Structured logs with secrets redacted'],
    ['caching', 'Response caching', 'Cache results for a few minutes'],
  ];
  const rows = j.deliverables === 'all' ? all : all.filter(([key]) => key === 'users' || key === 'usage');
  const nothing = !d.deliverables.users && !d.deliverables.usage;
  return <SplitLayout footer={<><Push />{nothing ? <Mono>Pick at least Users or Usage data</Mono> : null}<Button disabled={nothing || (!ready && !url)} onClick={() => (ready ? go(j.afterRead) : onRead(url))}>Read the docs</Button></>} panel={<>
    <SectionHeading>What happens next</SectionHeading>
    {j.next.map((t, i) => <div key={i} style={{ display: 'flex', gap: 28, padding: '16px 0', borderBottom: 'var(--rule-hair)' }}><Mono>{i + 1}</Mono><span>{t}</span></div>)}
    <SectionHeading size="label" style={{ marginTop: 36 }}>Safe by default</SectionHeading>
    <P>Read-only requests. One destination. Tokens never in code or logs.</P></>}>
    <PageTitle title={j.title[0]} lead={j.title[1]} />
    <div style={{ font: 'var(--type-label)', margin: '32px 0 12px' }}>Who's setting this up?</div>
    <ToggleGroup options={AUDIENCES.map(a => JOURNEYS[a].label)} value={j.label} onChange={v => dispatch({ type: 'audience', audience: AUDIENCES.find(a => JOURNEYS[a].label === v)! })} />
    <div style={{ font: '400 14px/1.45 var(--font-sans)', color: 'var(--text-muted)', marginTop: 10 }}>{j.blurb}</div>
    <TextField label="API documentation link" mono value={s.url} onChange={url => dispatch({ type: 'url', url })} style={{ marginTop: 36 }} />
    <TextField label="Search apps" value={search} onChange={setSearch} style={{ marginTop: 20 }} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
      {chips.map(a => <AppChip key={a.slug} name={a.name} icon={a.logo ? `./apps/${a.logo}` : undefined} selected={known?.slug === a.slug} onClick={() => dispatch({ type: 'pick', app: a })} />)}
    </div>
    <div aria-live="polite" style={{ font: '400 14px/1.45 var(--font-sans)', color: 'var(--text-muted)', marginTop: 10 }}>{!matches.length ? 'No matches. Paste a link to the documentation instead.' : matches.length > CHIPS ? `Showing ${CHIPS} of ${matches.length}. Search to find the rest.` : null}</div>
    <SectionHeading size="label" style={{ marginTop: 36 }}>What should we generate?</SectionHeading>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(260px,100%),1fr))', columnGap: 32 }}>
      {rows.map(([key, label, description]) => <Checkbox key={key} checked={d.deliverables[key]} label={label} description={d.deliverables[key] ? description : `Left out. ${LEFT_OUT[key]}`}
        onChange={v => dispatch({ type: 'decide', patch: { deliverables: { ...d.deliverables, [key]: v } } })} />)}
    </div>
    {j.deliverables === 'all' ? <>
      <div style={{ font: 'var(--type-label)', margin: '32px 0 12px' }}>Your stack</div>
      <Mono>TypeScript · Node 24 · native fetch</Mono></>
      : <div style={{ font: '400 14px/1.45 var(--font-sans)', color: 'var(--text-muted)', marginTop: 14 }}>Sign-in, paging, error handling and logging are included.</div>}
  </SplitLayout>;
}
