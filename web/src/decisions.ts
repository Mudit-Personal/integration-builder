import type { ConnectorSettings } from '../../src/connector-source.ts';
import { credentialFields, type AuthMethod, type Citation, type Manifest, type Pagination } from '../../src/manifest.ts';
import type { Limits } from '../../src/runtime.ts';
import type { Feature } from '../../src/scenario-table.ts';
import type { AppPack, Endpoint } from './pack.ts';

export const DELIVERABLES = ['client', 'auth', 'users', 'usage', 'errors', 'pagination', 'logging', 'caching'] as const;
export type Deliverable = typeof DELIVERABLES[number];

/** Everything a person can change. */
export type Decisions = {
  authIndex: number;
  deliverables: Record<Deliverable, boolean>;
  window: 7 | 30 | 90;
  /** Null keeps the size the docs gave. */
  pageSize: number | null;
  retries: 2 | 3 | 5;
  logLevel: 'debug' | 'info' | 'warn';
  cacheTtl: 1 | 5 | 15;
  /** Overrides on top of each endpoint's default, keyed by Endpoint.key. */
  access: Record<string, boolean>;
};

export const DEFAULT_DECISIONS: Decisions = {
  authIndex: 0, deliverables: { client: true, auth: true, users: true, usage: true, errors: true, pagination: true, logging: true, caching: false }, window: 30, pageSize: null,
  retries: 3, logLevel: 'info', cacheTtl: 5, access: {},
};

export const isRequired = (e: Endpoint) => e.key === 'users' || e.key.startsWith('context:');
export const isAllowed = (e: Endpoint, access: Decisions['access']) => isRequired(e) || (access[e.key] ?? e.sensitivity !== 'sensitive');

type Sized = Extract<Pagination, { pageSize: number | null }>;
const canSize = (p: Pagination): p is Sized & { pageSize: number } =>
  p.type !== 'none' && p.pageSize !== null && (p.type === 'offset' || p.sizeParam !== null);

export const pageSizeOptions = (p: Pagination): number[] =>
  (canSize(p) ? [...new Set([20, 50, 100, p.pageSize])].filter(n => n <= p.pageSize).sort((a, b) => a - b) : []);

/** The single place a decision changes the manifest. Everything downstream, hash included, follows from the result. */
export const applyDecisions = (m: Manifest, d: Decisions): Manifest => {
  const next = structuredClone(m);
  const chosen = next.authMethods[d.authIndex];
  next.authMethods = [chosen, ...next.authMethods.filter(a => a !== chosen)];
  if (d.pageSize !== null && canSize(next.users.pagination)) next.users.pagination.pageSize = d.pageSize;
  const usageBlocked = d.access.usage === false;
  if ((!d.deliverables.usage || usageBlocked) && next.usage.kind !== 'unavailable') {
    next.usage = { kind: 'unavailable', reason: usageBlocked ? 'Blocked in data access.' : 'Left out in the decisions step.' };
  }
  return next;
};

export const runtimeLimits = ({ deliverables: on, retries, window }: Decisions): Partial<Limits> => ({
  usageWindowDays: window,
  ...(on.errors ? { maxRetries: retries } : { maxRetries: 0, maxRetryWaitMs: 0 }),
  ...(on.pagination ? {} : { maxPages: 1 }),
});

/** Turned-off features whose sandbox checks would prove nothing. */
export const featuresOff = ({ deliverables: on }: Decisions): Feature[] => [...(on.errors ? [] : ['retries' as const]), ...(on.pagination ? [] : ['pagination' as const])];

export const connectorSettings = (d: Decisions, endpoints: Endpoint[]): ConnectorSettings => ({
  limits: runtimeLimits(d), logLevel: d.deliverables.logging ? d.logLevel : 'off', cacheTtlMs: d.deliverables.caching ? d.cacheTtl * 60_000 : 0,
  skipAuth: !d.deliverables.auth, exports: { users: d.deliverables.users, usage: d.deliverables.usage },
  approvedPaths: endpoints.filter(e => isAllowed(e, d.access)).map(e => e.path),
  blockedPaths: endpoints.filter(e => !isAllowed(e, d.access)).map(e => e.path),
});

export const envName = (m: Manifest, field: string) =>
  `${m.app.slug}_${field}`.replace(/[A-Z]/g, c => `_${c}`).replace(/\W/g, '_').toUpperCase();

export const quote = (m: Manifest, claim: Citation['claim']) =>
  m.evidence.find(e => e.claim === claim)?.quote.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

export type Source = 'docs' | 'default' | 'you' | 'off';
export type Choice = { current: string; options: string[]; patch: (value: string) => Partial<Decisions> };
export type QuestionId = 'auth' | 'usage';
/** The questions someone who isn't a developer is asked. The rest take the recommended answer. */
export const BUSINESS_QUESTIONS: QuestionId[] = ['usage'];
export type Question = { id: QuestionId; text: string; options: string[]; current: number; recommended: number; why: string; patch: (index: number) => Partial<Decisions> };
export type DecisionRow = {
  group: string; title: string; value: string; plain: string; source: Source;
  why?: string; choice?: Choice; question?: Question;
};

type AuthRow<A extends AuthMethod> = { value: (a: A) => string; plain: string; why: string; storage: string };
const AUTH: { [K in AuthMethod['type']]: AuthRow<Extract<AuthMethod, { type: K }>> } = {
  bearer: { value: a => `${a.prefix || 'Raw'} token in ${a.headerName || 'Authorization'}`, plain: 'One token, sent with every request.', why: 'One token for your own account is the simplest setup.', storage: 'Environment variable; never logged' },
  api_key: { value: a => `API key in the ${a.name} ${a.in}`, plain: 'One key, sent with every request.', why: 'One key for your own account is the simplest setup.', storage: 'Environment variable; never logged' },
  basic: { value: a => `Basic auth: ${a.usernameLabel} and ${a.passwordLabel}`, plain: 'A username and a secret.', why: 'It works without registering an app.', storage: 'Environment variables; never logged' },
  oauth2_client_credentials: { value: () => 'OAuth client credentials', plain: 'Your app signs in as itself.', why: 'No person has to stay signed in.', storage: 'Your secret store; the token is fetched at run time' },
  oauth2_authorization_code: { value: () => 'OAuth authorization code, with refresh', plain: 'Someone approves access once, then it renews itself.', why: 'The docs list it first, and it can be limited to the scopes you need.', storage: 'Your secret store; refreshed when rejected' },
};
const auth = <K extends AuthMethod['type']>(a: Extract<AuthMethod, { type: K }>) => AUTH[a.type as K] as unknown as AuthRow<typeof a>;

const PAGING: { [K in Pagination['type']]: (size: number | null) => { value: string; plain: string } } = {
  none: () => ({ value: 'None. One request returns everything', plain: 'Gets everything in one go.' }),
  cursor: n => ({ value: `Cursor${n ? `, ${n} per page` : ''}`, plain: `Fetches results in batches${n ? ` of ${n}` : ''} until it has them all.` }),
  next_url: n => ({ value: `Next link in the response${n ? `, ${n} per page` : ''}`, plain: `Follows each batch${n ? ` of ${n}` : ''} to the next.` }),
  link_header: n => ({ value: `Link header${n ? `, ${n} per page` : ''}`, plain: `Follows each batch${n ? ` of ${n}` : ''} to the next.` }),
  offset: n => ({ value: `Offset, ${n} per page`, plain: `Fetches results in batches of ${n} until it has them all.` }),
  page_number: n => ({ value: `Page number${n ? `, ${n} per page` : ''}`, plain: `Fetches page by page${n ? `, ${n} at a time` : ''}.` }),
};

const USAGE: { [K in Manifest['usage']['kind']]: (m: Manifest) => { value: string; plain: string } } = {
  event_log: () => ({ value: 'Event log, read per time window', plain: 'Reads the log of who did what.' }),
  aggregate_report: () => ({ value: 'Usage report, read per time window', plain: 'Reads a usage report.' }),
  last_activity_field: m => ({ value: `Last activity from ${m.users.fields.lastActiveAt?.path ?? 'the user record'}`, plain: 'Uses the last active date on each person.' }),
  unavailable: m => {
    const reason = m.usage.kind === 'unavailable' ? m.usage.reason : '';
    return { value: reason, plain: reason };
  },
};

const hostOf = (m: Manifest) => m.baseUrl.replace(/^https:\/\//, '');
const docs = (m: Manifest, claim: Citation['claim']): Pick<DecisionRow, 'source' | 'why'> => {
  const why = quote(m, claim);
  return { source: why ? 'docs' : 'default', why };
};
const literal = <T extends string | number>(options: readonly T[], value: string) => options.find(o => String(o) === value)!;

const usageRows = (m: Manifest, d: Decisions): DecisionRow[] => {
  const active = m.usage.kind === 'event_log' || m.usage.kind === 'aggregate_report' ? m.usage : null;
  const plan = active?.planRequirement;
  const { value, plain } = USAGE[m.usage.kind](m);
  const rows: DecisionRow[] = [plan
    ? {
      group: 'Usage data', title: 'What counts as usage', value, plain, source: 'you',
      question: {
        id: 'usage', text: `${value}. This needs the ${plan} plan.`, options: [`We have ${plan}`, 'Leave it out'],
        current: d.deliverables.usage ? 0 : 1, recommended: 1, why: `It only works on ${plan} plans. Users still sync without it.`,
        patch: i => ({ deliverables: { ...d.deliverables, usage: i === 0 } }),
      },
    }
    : {
      group: 'Usage data', title: 'What counts as usage', value, plain, ...docs(m, 'usage'),
      ...(m.usage.kind === 'unavailable' ? {} : { choice: { current: d.deliverables.usage ? 'On' : 'Off', options: ['On', 'Off'], patch: v => ({ deliverables: { ...d.deliverables, usage: v === 'On' } }) } }),
    }];
  if (active?.window) {
    rows.push({
      group: 'Usage data', title: 'Time window', value: `Last ${d.window} days`, plain: `Looks back ${d.window} days.`, source: 'default',
      choice: { current: `${d.window} days`, options: ['7 days', '30 days', '90 days'], patch: v => ({ window: literal([7, 30, 90] as const, v.split(' ')[0]) }) },
    });
  }
  return rows;
};

/** What leaving each one out means, in the words Source and Decisions both use. */
export const LEFT_OUT: Record<Deliverable, string> = {
  client: 'Manifest and README only. You write the client.',
  auth: 'Your code signs each request. We send no credentials.',
  users: 'No users function. Usage data still reads the list to work.',
  usage: 'Users only.',
  errors: 'One try per request. A rate limit or outage fails the run.',
  pagination: 'First page only. A longer list is reported as partial.',
  logging: 'No log events.',
  caching: 'Every call goes to the API.',
};
const GROUP_OF: Record<string, Deliverable> = {
  'API client': 'client', 'Auth setup': 'auth', Users: 'users', 'Usage data': 'usage',
  Pagination: 'pagination', 'Error handling': 'errors', Logging: 'logging', 'Response caching': 'caching',
};

/** Usage and caching keep their own on/off choice here. Any other group that was left out collapses to one row. */
export const decisionRows = (pack: AppPack, d: Decisions): DecisionRow[] => {
  const seen = new Set<string>();
  return allRows(pack, d).flatMap(r => {
    const key = GROUP_OF[r.group];
    if (d.deliverables[key] || key === 'usage' || key === 'caching') return [r];
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      group: r.group, title: 'Left out', value: LEFT_OUT[key], plain: LEFT_OUT[key], source: 'off' as const,
      choice: { current: 'Off', options: ['On', 'Off'], patch: v => ({ deliverables: { ...d.deliverables, [key]: v === 'On' } }) },
    }];
  });
};

const allRows = (pack: AppPack, d: Decisions): DecisionRow[] => {
  const m = pack.manifest;
  const name = m.app.name;
  const method = m.authMethods[d.authIndex];
  const paging = m.users.pagination;
  const size = d.pageSize ?? (paging.type === 'none' ? null : paging.pageSize);
  const sizes = pageSizeOptions(paging);
  const route = [...m.context.map(c => c.request.path), m.users.request.path].join(' → ').replace(/\{\{\s*[\w.]*?(\w+)\s*\}\}/g, '{$1}');
  const env = credentialFields(method).filter(f => !f.optional).map(f => envName(m, f.name)).join(', ');
  return [
    { group: 'API client', title: 'Base URL and runtime', value: `${hostOf(m)} · TypeScript, native fetch`, plain: `Talks to ${name} directly. One small dependency for validation.`, source: 'docs' },
    m.authMethods.length > 1
      ? {
        group: 'Auth setup', title: 'Sign-in method', value: auth(method).value(method), plain: auth(method).plain, source: 'you', why: quote(m, 'auth'),
        question: {
          id: 'auth', text: `How should this connect to ${name}?`, options: m.authMethods.map(a => a.label),
          current: d.authIndex, recommended: 0, why: auth(m.authMethods[0]).why, patch: i => ({ authIndex: i }),
        },
      }
      : { group: 'Auth setup', title: 'Sign-in method', value: auth(method).value(method), plain: auth(method).plain, ...docs(m, 'auth') },
    { group: 'Auth setup', title: 'Where the secret lives', value: `${auth(method).storage} (${env})`, plain: 'Kept in a secure setting. Never in the code, never in logs.', source: 'default' },
    { group: 'Users', title: 'How users are listed', value: `${m.users.request.method} ${route}`, plain: `Asks ${name} for everyone in your account.`, ...docs(m, 'users') },
    ...usageRows(m, d),
    {
      group: 'Pagination', title: 'Paging', ...PAGING[paging.type](size), ...docs(m, 'pagination'),
      ...(sizes.length > 1 ? { choice: { current: String(size), options: sizes.map(String), patch: (v: string) => ({ pageSize: Number(v) }) } } : {}),
    },
    {
      group: 'Error handling', title: 'Rate limits',
      value: `${m.rateLimit.maxRequestsPerMinute ? `${m.rateLimit.maxRequestsPerMinute} a minute. ` : 'Not stated in the docs. '}On 429, follows Retry-After`,
      plain: `If ${name} asks us to slow down, we wait and carry on.`, ...docs(m, 'rate_limit'),
    },
    {
      group: 'Error handling', title: 'Error format', value: m.errorEnvelope ? `Reads ${m.errorEnvelope.successPath} on status 200, then classifies` : 'HTTP status, classified by the runtime',
      plain: 'Problems are reported clearly instead of crashing your app.', ...docs(m, 'errors'),
    },
    {
      group: 'Error handling', title: 'Retries', value: `${d.retries} retries, exponential backoff, throttling and server errors only`, plain: `Tries again up to ${d.retries} times if ${name} has a hiccup.`, source: 'default',
      choice: { current: String(d.retries), options: ['2', '3', '5'], patch: v => ({ retries: literal([2, 3, 5] as const, v) }) },
    },
    {
      group: 'Logging', title: 'Log level', value: `JSON at ${d.logLevel}; secrets redacted`, plain: 'Keeps a record of every request, with secrets removed.', source: 'default',
      choice: { current: d.logLevel, options: ['debug', 'info', 'warn'], patch: v => ({ logLevel: literal(['debug', 'info', 'warn'] as const, v) }) },
    },
    {
      group: 'Response caching', title: 'Runtime cache', value: d.deliverables.caching ? `Results cached for ${d.cacheTtl} min` : 'Off', plain: d.deliverables.caching ? `Reuses a complete result for ${d.cacheTtl} minutes.` : 'Off', source: 'default',
      choice: {
        current: d.deliverables.caching ? `${d.cacheTtl} min` : 'Off', options: ['Off', '1 min', '5 min', '15 min'],
        patch: v => (v === 'Off' ? { deliverables: { ...d.deliverables, caching: false } } : { cacheTtl: literal([1, 5, 15] as const, v.split(' ')[0]), deliverables: { ...d.deliverables, caching: true } }),
      },
    },
  ];
};
