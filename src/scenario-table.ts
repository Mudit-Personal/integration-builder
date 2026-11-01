import type { Manifest } from './manifest.ts';
import type { Fault, Mock, StartMock } from './mock-core.ts';
import { runConnector, type Limits, type LogEvent, type RunResult } from './runtime.ts';

type Ctx = { m: Manifest; result: RunResult; mock: Mock; logs: LogEvent[] };
export type Scenario = {
  id: string; title: string; proves: string;
  category: 'recovery' | 'failure' | 'safety' | 'data';
  applies?: (m: Manifest) => string | null;
  fault?: (m: Manifest, origins: { offsite: () => string }) => Fault;
  limits?: Partial<Limits>;
  previousUserCount?: number;
  /** Returns the reason the scenario failed, or null when the behaviour was correct. */
  expect: (c: Ctx) => string | null;
};

const paginated = (m: Manifest) => (m.users.pagination.type === 'none' ? 'The users endpoint has no pagination' : null);
const needs = (m: Manifest, type: 'next_url' | 'link_header') => (['next_url', 'link_header'].includes(m.users.pagination.type) ? null : `Only for next-link pagination (${type})`);
const isOauth = (m: Manifest) => (m.authMethods[0].type.startsWith('oauth2') ? null : 'Only for OAuth');
const hasUsage = (m: Manifest) => (m.usage.kind === 'event_log' || m.usage.kind === 'aggregate_report' ? null : 'No usage endpoint');
const onUsers = (route: { stream: string }) => route.stream === 'users';

const check = (...rules: [boolean, string][]) => rules.find(([ok]) => !ok)?.[1] ?? null;
const usersIs = (r: RunResult, status: string) => [r.streams.users.status === status, `users ended ${r.streams.users.status}, wanted ${status}`] as [boolean, string];
const kindIs = (r: RunResult, kind: string) => [r.streams.users.error?.kind === kind, `error was ${r.streams.users.error?.kind}, wanted ${kind}`] as [boolean, string];
const noReconcile = (r: RunResult) => [!r.reconcile.allowed, 'a bad run was allowed to reconcile'] as [boolean, string];

export const SCENARIOS: Scenario[] = [
  {
    id: 'happy_path', title: 'Normal sync', category: 'recovery', proves: 'Auth, context steps, pagination and field mapping work together.',
    expect: ({ result: r }) => check(usersIs(r, 'complete'), [r.users.length === 57, `got ${r.users.length} users of 57`], [r.reconcile.allowed, 'clean run was not reconcilable']),
  },
  {
    id: 'rate_limit_then_ok', title: 'Throttled, then recovers', category: 'recovery', proves: '429 with Retry-After is honoured and the sync still finishes.',
    fault: () => ({ intercept: (rt, n) => (onUsers(rt) && n <= 2 ? { status: 429, headers: { 'retry-after': '0' }, body: '{}' } : undefined) }),
    expect: ({ result: r }) => check(usersIs(r, 'complete'), [r.stats.retries >= 2, 'no retries happened']),
  },
  {
    id: 'rate_limit_long', title: 'Told to wait a day', category: 'failure', proves: 'A huge Retry-After stops the run instead of hanging a worker.',
    fault: () => ({ intercept: rt => (onUsers(rt) ? { status: 429, headers: { 'retry-after': '86400' }, body: '{}' } : undefined) }),
    expect: ({ result: r }) => check(usersIs(r, 'failed'), kindIs(r, 'rate_limited'), [r.stats.retries === 0, 'it waited instead of stopping']),
  },
  {
    id: 'server_blip', title: 'Vendor 503, then recovers', category: 'recovery', proves: 'Transient vendor errors are retried with backoff.',
    fault: () => ({ intercept: (rt, n) => (onUsers(rt) && n <= 2 ? { status: 503, body: 'unavailable' } : undefined) }),
    expect: ({ result: r }) => check(usersIs(r, 'complete'), [r.stats.retries >= 2, 'no retries happened']),
  },
  {
    id: 'server_down', title: 'Vendor stays down', category: 'failure', proves: 'Retries are bounded, so an outage does not become a retry storm.',
    fault: () => ({ intercept: rt => (onUsers(rt) ? { status: 500, body: 'boom' } : undefined) }),
    expect: ({ result: r, mock }) => check(usersIs(r, 'failed'), kindIs(r, 'server'), [mock.requests() <= 10, `${mock.requests()} requests during an outage`], noReconcile(r)),
  },
  {
    id: 'token_revoked', title: 'Credential revoked', category: 'failure', proves: 'A 401 fails fast with a clear action and is not hammered.',
    fault: () => ({ intercept: rt => (onUsers(rt) ? { status: 401, body: '{"message":"revoked"}' } : undefined) }),
    expect: ({ result: r, mock }) => check(usersIs(r, 'failed'), kindIs(r, 'auth'), [mock.requests() <= 6, 'kept retrying a revoked credential']),
  },
  {
    id: 'token_expires_midway', title: 'Token expires mid-sync', category: 'recovery', applies: m => isOauth(m) ?? paginated(m), proves: 'The token refreshes once and the sync continues from the same page.',
    fault: () => ({ intercept: (rt, n) => (onUsers(rt) && n === 2 ? { status: 401, body: '{}' } : undefined) }),
    expect: ({ result: r }) => check(usersIs(r, 'complete'), [r.users.length === 57, `got ${r.users.length} users`]),
  },
  {
    id: 'missing_scope', title: 'Permission missing', category: 'failure', proves: 'A 403 tells the admin to grant a scope.',
    fault: () => ({ intercept: rt => (onUsers(rt) ? { status: 403, body: '{"message":"Insufficient scope"}' } : undefined) }),
    expect: ({ result: r }) => check(usersIs(r, 'failed'), [['forbidden', 'plan_gated'].includes(r.streams.users.error?.kind ?? ''), `error was ${r.streams.users.error?.kind}`]),
  },
  {
    id: 'usage_plan_gated', title: 'Usage needs a higher plan', category: 'recovery', applies: hasUsage, proves: 'A plan gate on usage leaves the user sync intact.',
    fault: () => ({ intercept: rt => (rt.stream === 'usage' ? { status: 403, body: '{"message":"This endpoint requires an Enterprise subscription"}' } : undefined) }),
    expect: ({ result: r }) => check(usersIs(r, 'complete'), [r.streams.usage.status === 'unavailable', `usage ended ${r.streams.usage.status}`], [r.reconcile.allowed, 'plan gate blocked user reconcile']),
  },
  {
    id: 'empty_account', title: 'Zero users returned', category: 'data', proves: 'An empty result never deprovisions everyone.',
    fault: () => ({ recordCount: 0 }),
    expect: ({ result: r }) => check(usersIs(r, 'complete'), noReconcile(r)),
  },
  {
    id: 'cursor_loop', title: 'Pagination never ends', category: 'failure', applies: paginated, proves: 'A stuck cursor or repeated page stops the run.',
    fault: () => ({ stuckPagination: true }),
    expect: ({ result: r }) => check([r.streams.users.status !== 'complete', 'loop reported as complete'], kindIs(r, 'contract'), noReconcile(r)),
  },
  {
    id: 'graphql_error_200', title: 'GraphQL error with status 200', category: 'failure', applies: m => (m.users.request.method === 'POST' ? null : 'Only for GraphQL or POST reads'), proves: 'An errors array is a failure, even with status 200.',
    fault: () => ({ intercept: rt => (onUsers(rt) ? { body: '{"errors":[{"message":"Field users is not available"}],"data":null}' } : undefined) }),
    expect: ({ result: r }) => check(usersIs(r, 'failed'), kindIs(r, 'contract')),
  },
  {
    id: 'empty_pages_forever', title: 'Empty pages that always say "more"', category: 'failure', applies: m => (['cursor', 'next_url', 'link_header'].includes(m.users.pagination.type) ? null : 'Only for cursor or link pagination'), proves: 'A repeating cursor stops even when pages carry no rows.',
    fault: () => ({ recordCount: 0, stuckPagination: true }),
    expect: ({ result: r }) => check([r.streams.users.status !== 'complete', 'loop reported as complete'], kindIs(r, 'contract'), noReconcile(r)),
  },
  {
    id: 'offsite_next_link', title: 'Next link points to another host', category: 'safety', applies: m => needs(m, 'next_url'), proves: 'A vendor response cannot steer credentials to a foreign host.',
    fault: (_, o) => ({ nextLinkOrigin: o.offsite }),
    expect: ({ result: r, mock }) => check(usersIs(r, 'partial'), kindIs(r, 'safety'), [mock.offsiteHits.length === 0, 'credentials reached the foreign host'], noReconcile(r)),
  },
  {
    id: 'offsite_redirect', title: 'Redirect to another host', category: 'safety', proves: 'Redirects cannot carry credentials off the allowlist.',
    fault: (_, o) => ({ intercept: rt => (onUsers(rt) ? { status: 302, headers: { location: `${o.offsite()}/steal` } } : undefined) }),
    expect: ({ result: r, mock }) => check(kindIs(r, 'safety'), [mock.offsiteHits.length === 0, 'the redirect was followed'], noReconcile(r)),
  },
  {
    id: 'html_with_200', title: 'Login page with status 200', category: 'failure', proves: 'A proxy or SSO page is not parsed as data.',
    fault: () => ({ intercept: rt => (onUsers(rt) ? { body: '<html>Please sign in</html>', headers: { 'content-type': 'text/html' } } : undefined) }),
    expect: ({ result: r }) => check(usersIs(r, 'failed'), kindIs(r, 'contract')),
  },
  {
    id: 'truncated_json', title: 'Broken JSON on page 2', category: 'failure', applies: paginated, proves: 'A cut-off page leaves the run partial, never complete.',
    fault: () => ({ intercept: (rt, n) => (onUsers(rt) && n === 2 ? { body: '{"data":[{"id' } : undefined) }),
    expect: ({ result: r }) => check(usersIs(r, 'partial'), kindIs(r, 'contract'), noReconcile(r), [r.users.length > 0, 'kept no users']),
  },
  {
    id: 'id_field_renamed', title: 'Vendor renames the ID field', category: 'data', proves: 'API drift stops the sync instead of writing blanks.',
    fault: m => ({ mutateRecords: (rows, rt) => (onUsers(rt) ? rows.map(() => ({ renamed: true, [`${m.app.slug}_id`]: 'x' })) : rows) }),
    expect: ({ result: r }) => check(usersIs(r, 'failed'), kindIs(r, 'contract'), [r.users.length === 0, 'junk users were returned']),
  },
  {
    id: 'records_field_renamed', title: 'Vendor renames the list field', category: 'data', applies: m => (m.users.recordsPath === '$' ? 'Records are at the top level' : null), proves: 'A missing list is an error, not an empty account.',
    fault: m => ({ intercept: rt => (onUsers(rt) ? { body: JSON.stringify(m.errorEnvelope ? { [m.errorEnvelope.successPath]: m.errorEnvelope.successValue, items_v2: [] } : { items_v2: [] }) } : undefined) }),
    expect: ({ result: r }) => check(usersIs(r, 'failed'), kindIs(r, 'contract')),
  },
  {
    id: 'null_emails', title: 'Some users have no email', category: 'data', applies: m => (m.users.fields.email ? null : 'No email field'), proves: 'Missing values stay null and show up in quality numbers.',
    fault: m => ({ mutateRecords: (rows, rt) => (onUsers(rt) ? rows.map((row, i) => (i % 3 === 0 ? blankEmail(row, m) : row)) : rows) }),
    expect: ({ result: r }) => check(usersIs(r, 'complete'), [r.quality.emailCoverage > 0.6 && r.quality.emailCoverage < 0.7, `email coverage ${r.quality.emailCoverage}`]),
  },
  {
    id: 'dirty_values', title: 'Unicode, odd case, unknown status', category: 'data', applies: m => (m.users.fields.status && m.users.fields.email ? null : 'Needs status and email fields'), proves: 'Values normalize and an unknown status becomes unknown, never active.',
    fault: m => ({ mutateRecords: (rows, rt) => (onUsers(rt) ? rows.map((row, i) => (i === 0 ? dirty(row, m) : row)) : rows) }),
    expect: ({ result: r }) => check(
      [r.users[0]?.email === 'ñandú.person@example.test', `email was ${r.users[0]?.email}`],
      [r.users[0]?.status === 'unknown', `status was ${r.users[0]?.status}`],
      [r.quality.unmappedStatuses.includes('LIMBO'), 'unknown status not reported'],
    ),
  },
  {
    id: 'duplicates', title: 'Record shifts between pages', category: 'data', applies: m => (['cursor', 'next_url', 'link_header'].includes(m.users.pagination.type) ? null : 'Only for cursor or link pagination'), proves: 'Rows that repeat across pages are counted once.',
    fault: () => ({ overlapPages: true }),
    expect: ({ result: r }) => check([r.users.length === 57, `got ${r.users.length} users`], [r.quality.duplicatesRemoved > 0, 'no duplicates seen']),
  },
  {
    id: 'slow_then_ok', title: 'Request hangs once', category: 'recovery', limits: { timeoutMs: 150 }, proves: 'A hung connection times out and is retried.',
    fault: () => ({ intercept: (rt, n) => (onUsers(rt) && n === 1 ? { hangMs: 500, body: '{}' } : undefined) }),
    expect: ({ result: r }) => check(usersIs(r, 'complete'), [r.stats.retries >= 1, 'no retry happened']),
  },
  {
    id: 'oversized_response', title: 'Response is huge', category: 'safety', limits: { maxResponseBytes: 50_000 }, proves: 'Memory is bounded by a response ceiling.',
    fault: () => ({ intercept: rt => (onUsers(rt) ? { body: JSON.stringify({ blob: 'x'.repeat(200_000) }) } : undefined) }),
    expect: ({ result: r }) => check(usersIs(r, 'failed'), kindIs(r, 'budget')),
  },
  {
    id: 'clamped_page_size', title: 'Vendor returns fewer rows than asked', category: 'data', applies: paginated, proves: 'A short page does not end the walk early.',
    fault: () => ({ vendorPageCap: 7 }),
    expect: ({ result: r }) => check(usersIs(r, 'complete'), [r.users.length === 57, `got ${r.users.length} users`]),
  },
  {
    id: 'secret_in_error', title: 'Vendor echoes the credential', category: 'safety', proves: 'A secret in an error body never reaches logs or results.',
    fault: () => ({ intercept: (rt, _n, url, req) => (onUsers(rt) ? { status: 500, body: JSON.stringify({ debug: req.headers, url: url.toString() }) } : undefined) }),
    expect: ({ result, logs, mock }) => {
      const dump = JSON.stringify({ result, logs });
      return check(...Object.values(mock.credentials).map(s => [!dump.includes(s), 'secret leaked into logs or results'] as [boolean, string]));
    },
  },
  {
    id: 'count_collapse', title: 'User count falls 90%', category: 'data', previousUserCount: 570, proves: 'A sudden drop needs a person before anything downstream acts.',
    expect: ({ result: r }) => check(usersIs(r, 'complete'), noReconcile(r)),
  },
  {
    id: 'page_ceiling', title: 'Run hits the page ceiling', category: 'safety', applies: paginated, limits: { maxPages: 1 }, proves: 'A truncated run reports partial and cannot reconcile.',
    expect: ({ result: r }) => check(usersIs(r, 'partial'), [r.streams.users.truncated, 'not marked truncated'], noReconcile(r)),
  },
  {
    id: 'outage_mid_sync', title: 'Outage on page 2', category: 'failure', applies: paginated, proves: 'Users already read are kept, but the run cannot reconcile.',
    fault: () => ({ intercept: (rt, n) => (onUsers(rt) && n >= 2 ? { status: 503, body: 'down' } : undefined) }),
    expect: ({ result: r }) => check(usersIs(r, 'partial'), kindIs(r, 'server'), noReconcile(r), [r.users.length > 0, 'kept no users']),
  },
];

const setAt = (row: Record<string, unknown>, path: string, value: unknown) => {
  const keys = path.split('.');
  let node = row;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[keys.at(-1)!] = value;
  return row;
};
const blankEmail = (row: Record<string, unknown>, m: Manifest) => setAt(row, m.users.fields.email!.path, null);
const dirty = (row: Record<string, unknown>, m: Manifest) => {
  setAt(row, m.users.fields.email!.path, '  ÑANDÚ.Person@Example.TEST ');
  setAt(row, m.users.fields.status!.path, 'LIMBO');
  return row;
};

export type ScenarioResult = { id: string; title: string; proves: string; category: Scenario['category']; status: 'pass' | 'fail' | 'skipped'; detail: string; requests: number };

/** extraLimits carry the user's decisions, and a scenario's own limits still win because it tests them. */
export const runScenarioOn = async (start: StartMock, m: Manifest, s: Scenario, extraLimits: Partial<Limits> = {}): Promise<ScenarioResult> => {
  const base = { id: s.id, title: s.title, proves: s.proves, category: s.category };
  const skip = s.applies?.(m);
  if (skip) return { ...base, status: 'skipped', detail: skip, requests: 0 };
  let offsite = '';
  const mock = await start(m, s.fault?.(m, { offsite: () => offsite }) ?? {});
  offsite = mock.offsiteOrigin;
  const logs: LogEvent[] = [];
  try {
    const result = await runConnector(m, {
      credentials: { ...mock.credentials }, connection: mock.connection, sandboxOrigin: mock.origin, fetch: mock.fetch,
      limits: { baseBackoffMs: 1, timeoutMs: 2000, ...extraLimits, ...s.limits }, log: e => logs.push(e), sleep: async () => {},
      previousUserCount: s.previousUserCount,
    });
    const failure = s.expect({ m, result, mock, logs });
    const summary = `${result.streams.users.status}, ${result.users.length} users, ${result.stats.requests} requests`;
    return { ...base, status: failure ? 'fail' : 'pass', detail: failure ?? summary, requests: result.stats.requests };
  } catch (e) {
    return { ...base, status: 'fail', detail: `Runtime threw: ${(e as Error).message}`, requests: mock.requests() };
  } finally {
    await mock.stop();
  }
};

export const sandboxPassed = (results: ScenarioResult[]) => results.every(r => r.status !== 'fail') && results.some(r => r.id === 'happy_path' && r.status === 'pass');
