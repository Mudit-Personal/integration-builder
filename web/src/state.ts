import apps from './generated/apps.json' with { type: 'json' };
import type { ScenarioResult } from '../../src/scenario-table.ts';
import type { ChecksRun, StaticCheck } from './checks.ts';
import type { CheckResult, SavedConnector } from './connectors.ts';
import { DEFAULT_DECISIONS, type Decisions, type QuestionId } from './decisions.ts';
import type { LiveRead } from './live.ts';
import { matchApp, type AppEntry, type AppPack } from './pack.ts';

export const APPS = apps as AppEntry[];
export const STEPS = ['Source', 'Read docs', 'Decisions', 'Checks', 'Code', 'Run'];
export const [SOURCE, READ, DECIDE, CHECKS, CODE, RUN] = [0, 1, 2, 3, 4, 5];

export type Answer = 'recommended' | 'chosen';
export type Flow = {
  /** Null on the home screen. Set on a new or opened connector. */
  id: string | null;
  step: number; maxStep: number; slug: string; url: string;
  /** Set when slug names a live read rather than a corpus app. hash tells two reads of one app apart. */
  live: { url: string; hash: string } | null;
  read: LiveRead;
  audience: 'Developer' | 'Not a developer'; role: 'Viewer' | 'Builder' | 'Admin';
  decisions: Decisions; answers: Partial<Record<QuestionId, Answer>>; requests: Record<string, boolean>;
  checks: ChecksRun;
  /** Outlives the run in checks, which is never saved, so a reopened connector keeps its verdict. */
  result: CheckResult | null;
  codeReached: boolean;
};

export type Action =
  | { type: 'new'; id: string }
  | { type: 'open'; saved: SavedConnector; lost: boolean }
  | { type: 'home' }
  | { type: 'go'; step: number }
  | { type: 'pick'; app: AppEntry }
  | { type: 'url'; url: string }
  | { type: 'set'; patch: Partial<Pick<Flow, 'audience' | 'role'>> }
  | { type: 'read-start'; url: string }
  | { type: 'read-progress'; message: string }
  | { type: 'read-done'; pack: AppPack }
  | { type: 'read-stopped'; read: Exclude<LiveRead, { kind: 'idle' | 'reading' }> }
  | { type: 'read-clear' }
  | { type: 'decide'; patch: Partial<Decisions>; answer?: [QuestionId, Answer] }
  | { type: 'request'; key: string }
  | { type: 'checks-start'; replay: boolean }
  | { type: 'checks-result'; result: ScenarioResult }
  | { type: 'checks-done'; hash: string; fixed: StaticCheck['status'][] }
  | { type: 'checks-reset' }
  | { type: 'checks-abandon' }
  | { type: 'reset' };

const IDLE: ChecksRun = { kind: 'idle' };

const NOT_READING: LiveRead = { kind: 'idle' };

const CLEAN = { decisions: DEFAULT_DECISIONS, answers: {}, requests: {}, checks: IDLE, result: null, codeReached: false } satisfies Partial<Flow>;

const fresh = (app: AppEntry) => ({ ...CLEAN, slug: app.slug, live: null });

const START_APP = APPS.find(a => a.slug === 'slack') ?? APPS[0];
export const initial = (): Flow => ({
  id: null, step: SOURCE, maxStep: SOURCE, url: '', read: NOT_READING, audience: 'Developer', role: 'Builder', ...fresh(START_APP),
});

export const reducer = (s: Flow, a: Action): Flow => {
  switch (a.type) {
    case 'new': return { ...initial(), role: s.role, id: a.id };
    case 'open': {
      const { id, slug, step, flow } = a.saved;
      const opened = { ...initial(), role: s.role, id, slug, ...flow };
      return a.lost ? { ...opened, step: SOURCE, maxStep: SOURCE, live: null, result: null, codeReached: false } : { ...opened, step };
    }
    case 'home': return { ...initial(), role: s.role };
    case 'go': return { ...s, step: a.step, maxStep: Math.max(s.maxStep, a.step), codeReached: s.codeReached || a.step === CODE };
    case 'pick': return { ...s, ...fresh(a.app), url: a.app.docsUrl, maxStep: SOURCE };
    case 'url': {
      const app = matchApp(APPS, a.url);
      return app && app.slug !== s.slug ? { ...s, ...fresh(app), url: a.url, maxStep: SOURCE } : { ...s, url: a.url };
    }
    case 'set': return { ...s, ...a.patch };
    case 'read-start': return { ...s, url: a.url, step: READ, maxStep: READ, read: { kind: 'reading', messages: [] } };
    case 'read-progress': return s.read.kind === 'reading' ? { ...s, read: { ...s.read, messages: [...s.read.messages, a.message] } } : s;
    case 'read-done': return {
      ...s, ...CLEAN, slug: a.pack.manifest.app.slug, live: { url: s.url, hash: a.pack.hash }, read: NOT_READING,
      // What to generate was chosen on Source, before the read.
      decisions: { ...DEFAULT_DECISIONS, deliverables: s.decisions.deliverables },
    };
    case 'read-stopped': return a.read.kind === 'denied' ? { ...s, step: SOURCE, maxStep: SOURCE, read: a.read } : { ...s, read: a.read };
    case 'read-clear': return { ...s, read: NOT_READING, maxStep: SOURCE };
    // A changed decision invalidates the checks, so Code cannot be reached on stale results.
    // Viewers review decisions but never change them, whatever control fired.
    case 'decide': if (s.role === 'Viewer') return s; return {
      ...s, decisions: { ...s.decisions, ...a.patch }, checks: IDLE, result: null, codeReached: false, maxStep: Math.min(s.maxStep, DECIDE),
      answers: a.answer ? { ...s.answers, [a.answer[0]]: a.answer[1] } : s.answers,
    };
    case 'request': return { ...s, requests: { ...s.requests, [a.key]: true } };
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
