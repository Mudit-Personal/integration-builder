import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import { clearStored, GROUPS, maskedSample, runChecks, runKey, staticChecks, storedResults } from '../checks.ts';
import { applyDecisions } from '../decisions.ts';
import { Button, Callout, CheckItem, Checkbox, KeyValueRow, Mono, P, PageTitle, Push, SectionHeading, SplitLayout, StatusLabel, type Tone } from '../ds.tsx';
import { hashManifest } from '../../../src/hash.ts';
import { SCENARIOS, type ScenarioResult } from '../../../src/scenario-table.ts';
import { CODE, DECIDE } from '../state.ts';

// The failures a buyer would fear most, shown first once they pass.
const HIGHLIGHTS = ['server_down', 'token_expires_midway', 'token_revoked', 'count_collapse', 'secret_in_error'];

const STATIC_META = { pass: ['Passed', 'done'], fail: ['Needs you', 'hollow'], skipped: ['Skipped', 'pending'] } as const;

const scenarioRow = (r: ScenarioResult | undefined, replay: boolean): { description: string; meta: string; status: Tone } => {
  if (!r) return { description: 'Waiting', meta: '', status: 'pending' };
  if (r.status === 'skipped') return { description: `Not applicable. ${r.detail}`, meta: 'Skipped', status: 'pending' };
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
  const viewer = s.role === 'Viewer';
  const run = s.checks;

  useEffect(() => {
    if (run.kind !== 'idle' || viewer) return;
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
  const canGenerate = done && !failed && !viewer;
  const blockFinding = pack.findings?.find(f => f.severity === 'block');
  const sample = maskedSample(m);
  const survived = done && !failed ? HIGHLIGHTS.map(id => results.find(r => r.id === id && r.status === 'pass')).filter(r => !!r).slice(0, 4) : [];
  const folded = survived.length > 0 && !showAll;
  // A Viewer can't run checks, but still sees the verdict a Builder left on this exact build.
  const verdict = viewer && run.kind === 'idle' && s.result?.hash === hashManifest(m) && !s.result.failed ? s.result : null;

  const title = verdict ? 'All checks passed' : !done ? (run.kind === 'idle' ? 'Checks need a Builder' : 'Running checks…') : failed ? `${failed} ${failed === 1 ? 'check' : 'checks'} failed` : 'All checks passed';
  const lead = verdict ? `${verdict.passed} checks passed when a Builder last ran them on this build. Viewers can see the result but can't run checks.` : !done ? (run.kind === 'idle' ? "Viewers can't run checks. Switch View as to run them." : replay ? 'Replaying stored results.' : `Running the connector against a simulated ${name} built from its docs. Nothing leaves your browser.`)
    : failed ? 'Generate stays off until this is fixed. Nothing was written.'
    : `${passed} checks passed against a simulated ${name} built from its docs. Nothing was written. The real ${name} API was not called.`;

  return <SplitLayout footer={<><Button variant="link" onClick={() => go(DECIDE)}>Back to decisions</Button><Push />{viewer ? <Mono c="var(--ink-2)">Viewers can't run checks</Mono> : null}<Button variant="secondary" disabled={viewer || run.kind === 'running'} onClick={() => dispatch({ type: 'checks-reset' })}>Run again</Button><Button disabled={!canGenerate} onClick={() => go(CODE)}>Generate code</Button></>} panel={<>
    <SectionHeading lead="The first run stores every result in this tab's memory. A re-run with the same decisions replays them. Change a decision and it runs again.">Test cache</SectionHeading>
    <KeyValueRow label="This run" value={replay ? `${results.length} replayed · 0 requests` : `${requests} simulated requests`} />
    <KeyValueRow label="Sent to the real API" value="0" />
    <KeyValueRow label="Stored results" value={stored ? `${stored} · until you reload` : 'None yet'} />
    <div style={{ marginTop: 8 }}><Checkbox checked={replayOn} onChange={setReplayOn} label="Replay stored results on re-run" description="Turn off to run every scenario again." /></div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 20 }}><Button variant="secondary" disabled={!stored} onClick={() => { clearStored(); redraw(n => n + 1); }}>Clear cache</Button>{replay ? <StatusLabel>Replayed</StatusLabel> : null}</div>
    <SectionHeading size="label" style={{ marginTop: 36 }}>What's stored</SectionHeading>
    <P>Scenario results only: pass or fail, a short detail and a request count. No credentials exist here, because the vendor is simulated.</P>
    <SectionHeading size="label" style={{ marginTop: 28 }}>Sample, as everyone sees it</SectionHeading>
    {sample.map((r, i) => <div key={i} className="sample-row"><Mono c="var(--ink)">{r.name}</Mono><Mono c="var(--ink-2)">{r.email}</Mono><Mono>{r.role}</Mono></div>)}
    <div style={{ fontSize: 14, color: 'var(--ink-2)', marginTop: 10 }}>Made-up people from the simulator. Masking can't be turned off, for any role.</div></>}>
    <PageTitle title={title} lead={lead} aside={canGenerate ? <StatusLabel size="lg">Ready to generate</StatusLabel> : null} />
    {survived.length ? <><SectionHeading size="label" style={{ marginTop: 40 }}>What it survived</SectionHeading>
      <div className="highlights">{survived.map(r => <div key={r.id} className="highlight">
        <span className="highlight-title">{r.title}</span>
        <span style={{ color: 'var(--text-muted)' }}>{r.proves}</span>
        <Mono>Passed · {r.requests} simulated requests</Mono>
      </div>)}</div>
      <div style={{ marginTop: 24 }}><Button variant="link" onClick={() => setShowAll(v => !v)}>{showAll ? 'Hide the full list' : `Show every check, ${passed} passed`}</Button></div></> : null}
    {folded || verdict ? null : <div className="checks-grid">
      {GROUPS.map((g, gi) => <div key={g.label}><SectionHeading size="label" style={{ marginTop: 16 }}>{g.label}</SectionHeading>
        {SCENARIOS.filter(x => g.categories.includes(x.category)).map(x => <CheckItem key={x.id} title={x.title} {...scenarioRow(results[SCENARIOS.indexOf(x)], replay)} />)}
        {g.categories.includes('safety') ? fixed.map(c => <CheckItem key={c.id} title={c.title} description={run.kind === 'idle' ? 'Waiting' : c.detail} meta={run.kind === 'idle' ? '' : STATIC_META[c.status][0]} status={run.kind === 'idle' ? 'pending' : STATIC_META[c.status][1]} />) : null}
      </div>)}
    </div>}
    {done && blockFinding ? <Callout title="The verifier blocked this manifest" style={{ marginTop: 28 }}>{blockFinding.message}</Callout> : null}
  </SplitLayout>;
}
