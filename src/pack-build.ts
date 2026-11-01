import { describePagination } from './connector-source.ts';
import { hashManifest } from './hash.ts';
import type { Citation, Manifest } from './manifest.ts';
import type { Finding, Source } from './verify.ts';

export type Sensitivity = 'low' | 'personal' | 'sensitive';
export type Endpoint = { key: string; name: string; path: string; sensitivity: Sensitivity; note: string };
export type ReadStep = { title: string; description: string; meta: string };
export type ReadStats = { source: Source['kind']; attempts: number; inputTokens: number; outputTokens: number; ms: number };

/** One app, from the corpus or read live. findings is null when there was no source to verify against. read is set only on a live read. */
export type AppPack = {
  manifest: Manifest; hash: string; docsUrl: string;
  findings: Finding[] | null; readSteps: ReadStep[]; endpoints: Endpoint[]; read?: ReadStats;
};

/** Keyword table for GET paths the connector must not touch. One row in the UI per entry, so a huge spec cannot flood it. */
const SENSITIVE: [RegExp, string][] = [
  [/transcript|recording|recap/i, 'Recorded meeting content'],
  [/\bmessages?\b|conversations?\.|\/chat/i, 'Private message content'],
  [/invitee/i, 'People outside your company and their answers'],
  [/contact/i, 'External contact details'],
  [/submission|form_?response/i, 'Free-text answers'],
  [/attachment|\/files?(\/|\.|$)/i, 'File contents'],
  [/secret|credential|api.?key|token/i, 'Credentials'],
  [/billing|invoice|payment/i, 'Billing details'],
];

const MAX_QUOTE = 110;

export const cleanQuote = (quote: string) => {
  const text = quote.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_QUOTE) return text;
  return `${text.slice(0, text.lastIndexOf(' ', MAX_QUOTE))}…`;
};

const displayPath = (path: string) => path.replace(/\{\{\s*[\w.]*?(\w+)\s*\}\}/g, '{$1}');

const cite = (m: Manifest, claim: Citation['claim']) => {
  const hit = m.evidence.find(e => e.claim === claim);
  return hit ? ` "${cleanQuote(hit.quote)}"` : '';
};

const FROM_DOCS = 'Read from docs';
const NO_QUOTE = 'No quote, review it';
const meta = (m: Manifest, claim: Citation['claim']) => (m.evidence.some(e => e.claim === claim) ? FROM_DOCS : NO_QUOTE);

const USAGE_STEP: { [K in Manifest['usage']['kind']]: (m: Manifest) => string } = {
  event_log: m => `Event log at ${m.usage.kind === 'event_log' ? displayPath(m.usage.request.path) : ''}.`,
  aggregate_report: m => `Usage report at ${m.usage.kind === 'aggregate_report' ? displayPath(m.usage.request.path) : ''}.`,
  last_activity_field: () => 'No usage endpoint needed. Last activity is on the user record.',
  unavailable: m => (m.usage.kind === 'unavailable' ? `Not available. ${m.usage.reason}` : ''),
};

export const readSteps = (m: Manifest, source: Source | null): ReadStep[] => {
  const usersPath = [...m.context.map(c => c.request.path), m.users.request.path].map(displayPath).join(' → ');
  const plan = m.usage.kind === 'event_log' || m.usage.kind === 'aggregate_report' ? m.usage.planRequirement : null;
  return [
    {
      title: 'Fetch the documentation', meta: FROM_DOCS,
      description: source?.spec ? `${source.spec.title}, ${source.spec.operations.length} operations in the API spec.`
        : source ? `${source.origin ? 'Docs pages' : 'Pasted docs'} for ${m.app.name}.` : `Docs pages for ${m.app.name}. No machine-readable spec was available.`,
    },
    { title: 'Work out how to sign in', meta: meta(m, 'auth'), description: `${m.authMethods.map(a => a.label).join(' or ')}.${cite(m, 'auth')}` },
    { title: 'Find user endpoints', meta: meta(m, 'users'), description: `${m.users.request.method} ${usersPath}.${cite(m, 'users')}` },
    { title: 'Find usage endpoints', meta: meta(m, 'usage'), description: `${USAGE_STEP[m.usage.kind](m)}${cite(m, 'usage')}` },
    { title: 'Detect paging', meta: meta(m, 'pagination'), description: `${describePagination(m)}.${cite(m, 'pagination')}` },
    {
      title: 'Detect rate limits and errors', meta: meta(m, m.rateLimit.maxRequestsPerMinute ? 'rate_limit' : 'errors'),
      description: `${m.rateLimit.maxRequestsPerMinute ? `${m.rateLimit.maxRequestsPerMinute} requests a minute.` : 'No rate limit stated, so the runtime follows Retry-After.'}${cite(m, 'errors')}`,
    },
    {
      title: 'Flag what needs a person', meta: 'Marked for review',
      description: `${plan ? `Usage needs the ${plan} plan. ` : ''}${m.assumptions.length} assumptions recorded for review.`,
    },
  ];
};

export const endpointsFor = (m: Manifest, source: Source | null): Endpoint[] => {
  const usage = m.usage.kind === 'event_log' || m.usage.kind === 'aggregate_report' ? m.usage : null;
  const approved: Endpoint[] = [
    ...m.context.map(c => ({ key: `context:${c.name}`, name: `Lookup: ${c.name.replace(/_/g, ' ')}`, path: displayPath(c.request.path), sensitivity: 'low' as const, note: 'Needed before users can be listed' })),
    { key: 'users', name: 'Users', path: displayPath(m.users.request.path), sensitivity: 'personal', note: 'Names and emails, masked' },
    ...(usage ? [{ key: 'usage', name: 'Usage', path: displayPath(usage.request.path), sensitivity: 'personal' as const, note: 'Who did what and when, masked' }] : []),
  ];
  const taken = new Set(approved.map(e => e.path));
  const reads = (source?.spec?.operations ?? [])
    .filter(o => o.method === 'GET' && !o.deprecated && !taken.has(o.path))
    .sort((a, b) => a.path.split('{').length - b.path.split('{').length || a.path.length - b.path.length || a.path.localeCompare(b.path));
  const sensitive = SENSITIVE.flatMap(([re, note]): Endpoint[] => {
    const op = reads.find(o => re.test(o.path) && !taken.has(o.path));
    if (!op) return [];
    taken.add(op.path);
    const name = op.summary && op.summary.length <= 48 ? op.summary.replace(/\.$/, '') : note;
    return [{ key: `sensitive:${op.path}`, name, path: op.path, sensitivity: 'sensitive', note }];
  });
  return [...approved, ...sensitive];
};

export const assemblePack = (manifest: Manifest, source: Source | null, docsUrl: string, findings: Finding[] | null): AppPack => ({
  manifest, hash: hashManifest(manifest), docsUrl, findings,
  readSteps: readSteps(manifest, source), endpoints: endpointsFor(manifest, source),
});
