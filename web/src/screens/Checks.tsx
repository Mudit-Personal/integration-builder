import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import { clearStored, GROUPS, maskedSample, runChecks, runKey, staticChecks, storedResults } from '../checks.ts';
import { applyDecisions } from '../decisions.ts';
import { Button, Callout, CheckItem, Checkbox, KeyValueRow, Mono, P, PageTitle, Push, SectionHeading, SplitLayout, StatusLabel, type Tone } from '../ds.tsx';
import { hashManifest } from '../../../src/hash.ts';
import { SCENARIOS, type ScenarioResult } from '../../../src/scenario-table.ts';
import { JOURNEYS } from '../journey.ts';
import { CODE, DECIDE } from '../state.ts';

// The failures a buyer would fear most, shown first once they pass.
const HIGHLIGHTS = ['server_down', 'token_expires_midway', 'token_revoked', 'count_collapse', 'secret_in_error'];

const NOT_TESTED = 'Not tested, because';
const STATIC_META = { pass: ['Passed', 'done'], fail: ['Needs you', 'hollow'], skipped: ['Skipped', 'pending'] } as const;

const scenarioRow = (proves: string, r: ScenarioResult | undefined, replay: boolean, next: boolean): { description: string; meta: string; status: Tone; waiting?: boolean } => {
  if (!r) return { description: proves, meta: '', status: next ? 'live' : 'pending', waiting: true };
  if (r.status === 'skipped') return { description: r.detail.startsWith(NOT_TESTED) ? r.detail : `Not applicable. ${r.detail}`, meta: 'Skipped', status: 'pending' };
  if (r.status === 'fail') return { description: r.detail, meta: 'Failed', status: 'hollow' };
  return { description: r.proves, meta: replay ? 'Passed · replayed' : 'Passed', status: 'done' };
};

export function Checks({ s, dispatch, go, pack, name }: ScreenProps) {
  const d = s.decisions;
  const m = useMemo(() => applyDecisions(pack.manifest, d), [pack, d]);
  const key = runKey(m, d);
  const [replayOn, setReplayOn] = useState(true);
  const [, redraw] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const active = useRef<AbortController | null>(null);
  const run = s.checks;

  useEffect(() => {
    if (run.kind !== 'idle') return;
    const replay = replayOn ? storedResults(key) : undefined;
    const ctrl = new AbortController();
    active.current = ctrl;
    dispatch({ type: 'checks-start', replay: !!replay });
    runChecks(m, d, replay, result => dispatch({ type: 'checks-result', result }), ctrl.signal)
      .then(() => { if (!ctrl.signal.aborted) dispatch({ type: 'checks-done', hash: hashManifest(m), fixed: staticChecks(pack, m, d).map(c => c.status) }); });
  });
  useEffect(() => () => {
    if (active.current && !active.current.signal.aborted) {
      active.current.abort();
      dispatch({ type: 'checks-abandon' });
    }
  }, []);

  const results = run.kind === 'idle' ? [] : run.results;
  const replay = run.kind !== 'idle' && run.replay;
  const done = run.kind === 'done';
  const fixed = staticChecks(pack, m, d);
  const failed = results.filter(r => r.status === 'fail').length + (done ? fixed.filter(c => c.status === 'fail').length : 0);
  const passed = results.filter(r => r.status === 'pass').length + fixed.filter(c => c.status === 'pass').length;
  const requests = results.reduce((sum, r) => sum + r.requests, 0);
  const stored = storedResults(key)?.length ?? 0;
  const canGenerate = done && !failed;
  const blockFinding = pack.findings?.find(f => f.severity === 'block');
  const sample = maskedSample(m);
  const survived = done && !failed ? HIGHLIGHTS.map(id => results.find(r => r.id === id && r.status === 'pass')).filter(r => !!r).slice(0, 4) : [];
  const verdict = JOURNEYS[s.audience].checks === 'verdict';
  const folded = (verdict || survived.length > 0) && !showAll;

  const untested = results.filter(r => r.status === 'skipped' && r.detail.startsWith(NOT_TESTED)).length;
  const title = !done ? 'Running checks…' : failed ? `${failed} ${failed === 1 ? 'check' : 'checks'} failed` : 'All checks passed';
  const lead = !done ? (replay ? 'Replaying stored results.' : `Running the connector against a simulated ${name} built from its docs. Nothing leaves your browser.`)
    : failed ? 'Generate stays off until this is fixed. Nothing was written.'
    : `${passed} checks passed against a simulated ${name} built from its docs.${untested ? ` ${untested} not tested, because you left out what they test.` : ''} Nothing was written. The real ${name} API was not called.`;

  const people = <>
    <SectionHeading size="label" style={{ marginTop: verdict ? 36 : 28 }}>Sample, as everyone sees it</SectionHeading>
    {sample.map((r, i) => <div key={i} className="sample-row"><Mono c="var(--ink)">{r.name}</Mono><Mono c="var(--ink-2)">{r.email}</Mono><Mono>{r.role}</Mono></div>)}
    <div style={{ fontSize: 14, color: 'var(--ink-2)', marginTop: 10 }}>Made-up people from the simulator. Masking can't be turned off, for any role.</div></>;
  const panel = verdict ? <>
    <SectionHeading lead={`A simulated copy of ${name}, built from its docs. We tried the problems a real account runs into, like outages and expired sign-ins.`}>What we tested</SectionHeading>
    <SectionHeading size="label" style={{ marginTop: 36 }}>Your account</SectionHeading>
    <P>Nothing touched your real {name} account. No sign-in was needed.</P>
    {people}</> : <>
    <SectionHeading lead="The first run stores every result in this tab's memory. A re-run with the same decisions replays them. Change a decision and it runs again.">Test cache</SectionHeading>
    <KeyValueRow label="This run" value={replay ? `${results.length} replayed · 0 requests` : `${requests} simulated requests`} />
    <KeyValueRow label="Sent to the real API" value="0" />
    <KeyValueRow label="Stored results" value={stored ? `${stored} · until you reload` : 'None yet'} />
    <div style={{ marginTop: 8 }}><Checkbox checked={replayOn} onChange={setReplayOn} label="Replay stored results on re-run" description="Turn off to run every scenario again." /></div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 20 }}><Button variant="secondary" disabled={!stored} onClick={() => { clearStored(); redraw(n => n + 1); }}>Clear cache</Button>{replay ? <StatusLabel>Replayed</StatusLabel> : null}</div>
    <SectionHeading size="label" style={{ marginTop: 36 }}>What's stored</SectionHeading>
    <P>Scenario results only: pass or fail, a short detail and a request count. No credentials exist here, because the vendor is simulated.</P>
    {people}</>;

  return <SplitLayout footer={<><Button variant="link" onClick={() => go(DECIDE)}>{verdict ? 'Back' : 'Back to decisions'}</Button><Push /><Button variant="secondary" disabled={run.kind === 'running'} onClick={() => dispatch({ type: 'checks-reset' })}>Run again</Button><Button disabled={!canGenerate} onClick={() => go(CODE)}>{verdict ? 'Continue' : 'Generate code'}</Button></>} panel={panel}>
    <PageTitle title={title} lead={lead} aside={canGenerate ? <StatusLabel size="lg">{verdict ? 'Ready to hand off' : 'Ready to generate'}</StatusLabel> : null} />
    {survived.length ? <><SectionHeading size="label" style={{ marginTop: 40 }}>What it survived</SectionHeading>
      <div className="highlights">{survived.map(r => <div key={r.id} className="highlight">
        <span className="highlight-title">{r.title}</span>
        <span style={{ color: 'var(--text-muted)' }}>{r.proves}</span>
        <Mono>Passed · {r.requests} simulated requests</Mono>
      </div>)}</div></> : null}
    {survived.length || (verdict && done) ? <div style={{ marginTop: 24 }}><Button variant="link" onClick={() => setShowAll(v => !v)}>{showAll ? 'Hide the full list' : `Show every check, ${passed} passed`}</Button></div> : null}
    {folded ? null : <div className="checks-grid">
      {GROUPS.map((g, gi) => <div key={g.label}><SectionHeading size="label" style={{ marginTop: 16 }}>{g.label}</SectionHeading>
        {SCENARIOS.filter(x => g.categories.includes(x.category)).map(x => <CheckItem key={x.id} title={x.title} {...scenarioRow(x.proves, results[SCENARIOS.indexOf(x)], replay, run.kind === 'running' && SCENARIOS.indexOf(x) === results.length)} />)}
        {g.categories.includes('safety') ? fixed.map(c => <CheckItem key={c.id} title={c.title} description={run.kind === 'idle' ? 'Waiting' : c.detail} meta={run.kind === 'idle' ? '' : STATIC_META[c.status][0]} status={run.kind === 'idle' ? 'pending' : STATIC_META[c.status][1]} />) : null}
      </div>)}
    </div>}
    {done && blockFinding ? <Callout title="The verifier blocked this manifest" style={{ marginTop: 28 }}>{blockFinding.message}</Callout> : null}
  </SplitLayout>;
}
