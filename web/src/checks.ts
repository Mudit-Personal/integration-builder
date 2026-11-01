import { hashManifest } from '../../src/hash.ts';
import type { Manifest } from '../../src/manifest.ts';
import { startVirtualMock } from '../../src/mock-virtual.ts';
import { synthUser } from '../../src/mock-core.ts';
import { getPath, runConnector } from '../../src/runtime.ts';
import { runScenarioOn, SCENARIOS, type ScenarioResult } from '../../src/scenario-table.ts';
import { featuresOff, isAllowed, runtimeLimits, type Decisions } from './decisions.ts';
import type { AppPack } from './pack.ts';

export type ChecksRun =
  | { kind: 'idle' }
  | { kind: 'running'; replay: boolean; results: ScenarioResult[] }
  | { kind: 'done'; replay: boolean; results: ScenarioResult[] };

const LIVE_ROW_MS = 200;
const REPLAY_ROW_MS = 60;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

// shortcut: lives in this tab's memory and is lost on reload, keep results server-side if replays must survive one.
const stored = new Map<string, ScenarioResult[]>();

/** Limits are not manifest fields, so the hash alone would replay stale results. */
export const runKey = (m: Manifest, d: Decisions) => `${hashManifest(m)}:${JSON.stringify(runtimeLimits(d))}`;
export const storedResults = (key: string) => stored.get(key);
export const clearStored = () => stored.clear();

export const runChecks = async (m: Manifest, d: Decisions, replay: ScenarioResult[] | undefined, onResult: (r: ScenarioResult) => void, signal: AbortSignal) => {
  const results: ScenarioResult[] = [];
  for (const [i, s] of SCENARIOS.entries()) {
    const started = performance.now();
    const r = replay?.[i] ?? await runScenarioOn(startVirtualMock, m, s, runtimeLimits(d), featuresOff(d));
    await pause((replay ? REPLAY_ROW_MS : LIVE_ROW_MS) - (performance.now() - started));
    if (signal.aborted) return;
    results.push(r);
    onResult(r);
  }
  stored.set(runKey(m, d), results);
};

export const GROUPS: { label: string; categories: ScenarioResult['category'][] }[] = [
  { label: 'Recovery and failure', categories: ['recovery', 'failure'] },
  { label: 'The data', categories: ['data'] },
  { label: 'Safeguards', categories: ['safety'] },
];

export type StaticCheck = { id: string; title: string; detail: string; status: 'pass' | 'fail' | 'skipped' };

const REQUESTS = (m: Manifest) => [...m.context.map(c => c.request), m.users.request, ...(m.usage.kind === 'event_log' || m.usage.kind === 'aggregate_report' ? [m.usage.request] : [])];

/** Facts read from the manifest and findings, so they can be stated without running anything. */
export const staticChecks = (pack: AppPack, m: Manifest, d: Decisions): StaticCheck[] => {
  const requests = REQUESTS(m);
  const writes = requests.filter(r => r.method !== 'GET' && !r.readOnlyPostReason);
  const posts = requests.filter(r => r.method === 'POST').length;
  const hosts = [...new Set([m.baseUrl, ...m.authMethods.slice(0, 1).flatMap(a => ('tokenUrl' in a ? [a.tokenUrl] : []))].map(u => u.replace(/^https:\/\//, '').split('/')[0]))];
  const blocked = pack.endpoints.filter(e => !isAllowed(e, d.access));
  const called = new Set(requests.map(r => r.path.replace(/\{\{\s*[\w.]*?(\w+)\s*\}\}/g, '{$1}')));
  const reached = blocked.filter(e => called.has(e.path));
  const scopes = [...new Set([...m.users.requiredScopes, ...(m.usage.kind === 'event_log' || m.usage.kind === 'aggregate_report' ? m.usage.requiredScopes : [])])];
  const blocks = pack.findings?.filter(f => f.severity === 'block') ?? [];
  const reviews = pack.findings?.filter(f => f.severity === 'review').length ?? 0;
  return [
    {
      id: 'verify', title: pack.read?.source === 'docs' ? 'Matches the docs' : 'Matches the spec',
      status: pack.findings === null ? 'skipped' : blocks.length ? 'fail' : 'pass',
      detail: pack.findings === null ? `No spec was available for ${m.app.name}, so nothing was verified against one.` : blocks.length ? blocks[0].message : `${pack.read?.source === 'docs' ? 'Every quote' : 'Every operation and quote'} was checked. ${reviews} points to review, none blocking.`,
    },
    { id: 'read_only', title: 'Read-only', status: writes.length ? 'fail' : 'pass', detail: writes.length ? `${writes.length} ${writes.length === 1 ? 'request' : 'requests'} could change data in ${m.app.name}.` : posts ? `${posts} POST reads, each with a stated reason. Nothing else but GET.` : 'Every request is a GET.' },
    { id: 'one_destination', title: 'One destination', status: 'pass', detail: `Credentials can only reach ${hosts.join(' and ')}.` },
    { id: 'sensitive', title: 'Sensitive data blocked', status: reached.length ? 'fail' : 'pass', detail: reached.length ? `The connector still calls ${reached.length} blocked ${reached.length === 1 ? 'endpoint' : 'endpoints'}.` : blocked.length ? `${blocked.length} endpoints blocked. The connector has no request for any of them.` : 'Nothing is blocked for this app.' },
    { id: 'scopes', title: 'Least privilege', status: 'pass', detail: scopes.length ? `Asks only for ${scopes.join(', ')}.` : 'The manifest lists no scopes for this app.' },
  ];
};

/** One clean run of the generated connector against the simulated vendor, kept whole so the result can be shown. */
export const runSync = async (m: Manifest, d: Decisions) => {
  const mock = await startVirtualMock(m);
  try {
    return await runConnector(m, { credentials: { ...mock.credentials }, connection: mock.connection, sandboxOrigin: mock.origin, fetch: mock.fetch, limits: runtimeLimits(d) });
  } finally {
    await mock.stop();
  }
};

const maskWord = (word: string) => `${word[0] ?? ''}•••`;
export const maskName = (name: unknown) => (typeof name === 'string' ? name.split(/\s+/).map(maskWord).join(' ') : '•••');
export const maskEmail = (email: unknown) => {
  if (typeof email !== 'string') return '•••';
  const [local, domain] = email.split('@');
  return `${maskWord(local)}@${domain}`;
};

export const maskedSample = (m: Manifest) => [0, 1, 2].map(i => {
  const record = synthUser(m, i);
  const f = m.users.fields;
  return {
    name: maskName(f.displayName && getPath(record, f.displayName.path)),
    email: maskEmail(f.email && getPath(record, f.email.path)),
    role: f.role ? String(getPath(record, f.role.path)) : 'user',
  };
});
