import apps from './generated/apps.json' with { type: 'json' };
import type { ScenarioResult } from '../../src/scenario-table.ts';
import type { ChecksRun, StaticCheck } from './checks.ts';
import type { CheckResult, SavedConnector } from './connectors.ts';
import { DEFAULT_DECISIONS, DELIVERABLES, type Decisions, type QuestionId } from './decisions.ts';
import type { LiveRead } from './live.ts';
import { audienceOf, CHECKS, CODE, DECIDE, JOURNEYS, READ, SOURCE, type Audience } from './journey.ts';
import { matchApp, type AppEntry, type AppPack } from './pack.ts';

export { CHECKS, CODE, DECIDE, READ, READY, RUN, SOURCE } from './journey.ts';

export const APPS = apps as AppEntry[];

export type Answer = 'recommended' | 'chosen';
export type Flow = {
  /** Null on the home screen. Set on a new or opened connector. */
  id: string | null;
  step: number; maxStep: number; slug: string; url: string;
  /** Set when slug names a live read rather than a corpus app. hash tells two reads of one app apart. */
  live: { url: string; hash: string } | null;
  read: LiveRead;
  audience: Audience;
  decisions: Decisions; answers: Partial<Record<QuestionId, Answer>>;
  checks: ChecksRun;
  /** Outlives the run in checks, which is never saved, so a reopened connector keeps its verdict. */
  result: CheckResult | null;
  codeReached: boolean;
};

export type Action =
  | { type: 'new'; id: string; audience: Audience }
  | { type: 'open'; saved: SavedConnector; lost: boolean }
  | { type: 'home' }
  | { type: 'go'; step: number }
  | { type: 'pick'; app: AppEntry }
  | { type: 'url'; url: string }
  | { type: 'audience'; audience: Audience }
  | { type: 'read-start'; url: string }
  | { type: 'read-progress'; message: string }
  | { type: 'read-done'; pack: AppPack }
  | { type: 'read-stopped'; read: Exclude<LiveRead, { kind: 'idle' | 'reading' }> }
  | { type: 'read-clear' }
  | { type: 'decide'; patch: Partial<Decisions>; answer?: [QuestionId, Answer] }
  | { type: 'checks-start'; replay: boolean }
  | { type: 'checks-result'; result: ScenarioResult }
  | { type: 'checks-done'; hash: string; fixed: StaticCheck['status'][] }
  | { type: 'checks-reset' }
  | { type: 'checks-abandon' }
  | { type: 'reset' };

const IDLE: ChecksRun = { kind: 'idle' };

const NOT_READING: LiveRead = { kind: 'idle' };

const CLEAN = { decisions: DEFAULT_DECISIONS, answers: {}, checks: IDLE, result: null, codeReached: false } satisfies Partial<Flow>;

const fresh = (app: AppEntry) => ({ ...CLEAN, slug: app.slug, live: null });

const START_APP = APPS.find(a => a.slug === 'slack') ?? APPS[0];
export const initial = (): Flow => ({
  id: null, step: SOURCE, maxStep: SOURCE, url: '', read: NOT_READING, audience: 'developer', ...fresh(START_APP),
});

export const reducer = (s: Flow, a: Action): Flow => {
  switch (a.type) {
    case 'new': return { ...initial(), id: a.id, audience: a.audience };
    case 'open': {
      const { id, slug, step, flow } = a.saved;
      // Connectors saved before every deliverable had a switch lack the newer keys.
      const opened = { ...initial(), id, slug, ...flow, audience: audienceOf(flow.audience), decisions: { ...flow.decisions, deliverables: { ...DEFAULT_DECISIONS.deliverables, ...flow.decisions.deliverables } } };
      return a.lost ? { ...opened, step: SOURCE, maxStep: SOURCE, live: null, result: null, codeReached: false } : { ...opened, step };
    }
    case 'home': return initial();
    case 'go': return { ...s, step: a.step, maxStep: Math.max(s.maxStep, a.step), codeReached: s.codeReached || a.step === CODE };
    case 'pick': return { ...s, ...fresh(a.app), url: a.app.docsUrl, maxStep: SOURCE };
    case 'url': {
      const app = matchApp(APPS, a.url);
      return app && app.slug !== s.slug ? { ...s, ...fresh(app), url: a.url, maxStep: SOURCE } : { ...s, url: a.url };
    }
    case 'audience': {
      const next = { ...s, audience: a.audience };
      const on = s.decisions.deliverables;
      // This journey shows only Users and Usage data, and tells the person the rest is included.
      const kept = JOURNEYS[a.audience].deliverables === 'outcomes' ? { ...DEFAULT_DECISIONS.deliverables, users: on.users, usage: on.usage } : on;
      return DELIVERABLES.every(k => kept[k] === on[k]) ? next : reducer(next, { type: 'decide', patch: { deliverables: kept } });
    }
    case 'read-start': return { ...s, url: a.url, step: READ, maxStep: READ, read: { kind: 'reading', messages: [] } };
    case 'read-progress': return s.read.kind === 'reading' ? { ...s, read: { ...s.read, messages: [...s.read.messages, a.message] } } : s;
    case 'read-done': return {
      ...s, ...CLEAN, step: JOURNEYS[s.audience].afterRead, maxStep: Math.max(s.maxStep, JOURNEYS[s.audience].afterRead), slug: a.pack.manifest.app.slug, live: { url: s.url, hash: a.pack.hash }, read: NOT_READING,
      // What to generate was chosen on Source, before the read.
      decisions: { ...DEFAULT_DECISIONS, deliverables: s.decisions.deliverables },
    };
    case 'read-stopped': return { ...s, read: a.read };
    case 'read-clear': return { ...s, read: NOT_READING, maxStep: SOURCE };
    // A changed decision invalidates the checks, so Code cannot be reached on stale results.
    case 'decide': return {
      ...s, decisions: { ...s.decisions, ...a.patch }, checks: IDLE, result: null, codeReached: false, maxStep: Math.min(s.maxStep, DECIDE),
      answers: a.answer ? { ...s.answers, [a.answer[0]]: a.answer[1] } : s.answers,
    };
    case 'checks-start': return { ...s, maxStep: Math.min(s.maxStep, CHECKS), checks: { kind: 'running', replay: a.replay, results: [] } };
    case 'checks-result': return s.checks.kind === 'running' ? { ...s, checks: { ...s.checks, results: [...s.checks.results, a.result] } } : s;
    case 'checks-done': {
      if (s.checks.kind !== 'running') return s;
      const all = [...s.checks.results.map(r => r.status), ...a.fixed];
      return { ...s, checks: { ...s.checks, kind: 'done' }, result: { hash: a.hash, passed: all.filter(x => x === 'pass').length, failed: all.filter(x => x === 'fail').length } };
    }
    case 'checks-reset': return { ...s, checks: IDLE };
    case 'checks-abandon': return s.checks.kind === 'running' ? { ...s, checks: IDLE } : s;
    // Keeps the app and any live read, so starting over never spends a second read.
    case 'reset': return { ...s, ...CLEAN, step: SOURCE, maxStep: SOURCE, read: NOT_READING };
  }
};
