import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { connectorSource } from '../src/connector-source.ts';
import { htmlToText, specLinksIn } from '../src/ingest.ts';
import type { Manifest, Pagination } from '../src/manifest.ts';
import { assertPublicUrl, ConnectorError, PROBE_LIMITS, runConnector, type RunOptions } from '../src/runtime.ts';
import { isBlocked, verifyManifest, type Source } from '../src/verify.ts';
import { AUTHS, field, makeManifest } from './fixtures.ts';

const API = 'https://api.acme.test/v2/members';
const NO_USAGE = { kind: 'unavailable', reason: 'none' } as const;
const rows = (n: number, from = 0, extra: object = {}) => Array.from({ length: n }, (_, i) => ({ id: `u${from + i}`, profile: { email: `u${from + i}@acme.test` }, last_seen: 1_700_000_000, ...extra }));

const connector = (pagination: Pagination, overrides: Partial<Manifest> = {}, auth = AUTHS[0]) => {
  const m = makeManifest(pagination, auth, { context: [], usage: NO_USAGE, ...overrides });
  m.users.request.path = '/members';
  return m;
};

type Handler = (url: URL, init: RequestInit) => Response | object;

const run = async (m: Manifest, handler: Handler, opts: Partial<RunOptions> = {}) => {
  const original = globalThis.fetch;
  const calls: URL[] = [];
  globalThis.fetch = (async (input: URL, init: RequestInit) => {
    const url = new URL(input);
    calls.push(url);
    const out = handler(url, init);
    return out instanceof Response ? out : Response.json(out);
  }) as typeof fetch;
  try {
    const result = await runConnector(m, { credentials: { token: 'tok-secret-1234' }, skipDnsCheck: true, sleep: async () => {}, ...opts });
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
};

const docs = (corpus: string): Source => ({ kind: 'docs', origin: 'https://docs.vendor.com/', spec: null, promptText: '', corpus: `members me audit ${corpus}`, warnings: [] });
const codes = (m: Manifest, corpus = '') => verifyManifest(m, docs(corpus)).map(f => f.code);

test('text from the model cannot escape the generated file header', () => {
  const m = connector({ type: 'none' });
  m.app.name = 'Acme */ fetch("https://evil.example"); /*';
  const source = connectorSource(m, 'abc');
  assert.equal(source.slice(0, source.indexOf('import ')).split('*/').length, 2);
  assert.ok(!source.includes('*/ fetch('));
});

for (const baseUrl of ['https://{sub}.evil.com?.vendor.com', 'https://{sub}.evil.com#.vendor.com', 'https://user@{sub}.vendor.com', 'https://{{connection.sub}}.vendor.com']) {
  test(`verifier blocks the disguised host ${baseUrl}`, () => {
    const m = connector({ type: 'none' }, { baseUrl, connectionFields: [{ name: 'sub', label: 'Sub', example: 'acme' }] });
    assert.ok(codes(m, baseUrl).includes('bad_url'));
  });
}

for (const baseUrl of ['https://{sub}', 'https://{sub}vendor.com', 'https://vendor.com.{sub}']) {
  test(`verifier refuses a setting that picks the vendor domain in ${baseUrl}`, () => {
    const m = connector({ type: 'none' }, { baseUrl, connectionFields: [{ name: 'sub', label: 'Sub', example: 'acme' }] });
    assert.ok(codes(m, baseUrl).includes('host_is_variable'));
  });
}

test('a backslash cannot hide the real domain from the check', () => {
  const baseUrl = 'https://{sub}.evil.com\\.vendor.com';
  const m = connector({ type: 'none' }, { baseUrl, connectionFields: [{ name: 'sub', label: 'Sub', example: 'acme' }] });
  assert.ok(codes(m, baseUrl).includes('host_domain_mismatch'));
});

test('a subdomain template on the real vendor domain still passes', () => {
  const m = connector({ type: 'none' }, { baseUrl: 'https://{sub}.vendor.com/api', connectionFields: [{ name: 'sub', label: 'Sub', example: 'acme' }] });
  assert.ok(!codes(m, 'vendor.com').some(c => ['bad_url', 'host_is_variable', 'host_domain_mismatch'].includes(c)));
});

test('the runtime refuses a base URL that carries a query', async () => {
  const m = connector({ type: 'none' }, { baseUrl: 'https://{sub}.evil.com?.vendor.com', connectionFields: [{ name: 'sub', label: 'Sub', example: 'acme' }] });
  const { result, calls } = await run(m, () => ({ data: [] }), { connection: { sub: 'acme' } });
  assert.equal(result.streams.users.error?.kind, 'safety');
  assert.equal(calls.length, 0);
});

const cursor: Pagination = { type: 'cursor', cursorPath: 'meta.next', cursorParam: 'cursor', cursorIn: 'query', hasMorePath: null, sizeParam: null, pageSize: null };
const offset: Pagination = { type: 'offset', offsetParam: 'offset', limitParam: 'limit', pageSize: 100, totalPath: 'meta.total', hasMorePath: null };
const nextUrl: Pagination = { type: 'next_url', urlPath: 'links.next', sizeParam: null, pageSize: null };

const silentlyShort: [string, Pagination, Handler][] = [
  ['no pagination, vendor says has_more', { type: 'none' }, () => ({ data: rows(100), has_more: true })],
  ['no pagination, total is larger', { type: 'none' }, () => ({ data: rows(100), total: 5000 })],
  ['no pagination, next link present', { type: 'none' }, () => ({ data: rows(100), next_page_token: 'abc' })],
  ['cursor renamed while more is true', cursor, () => ({ data: rows(100), meta: { cursor_v2: 'abc', more: true } })],
  ['rows vanish while the total says more', offset, u => (u.searchParams.get('offset') === '0' ? { data: rows(100), meta: { total: 500 } } : { data: [], meta: { total: 500 } })],
];

for (const [name, pagination, handler] of silentlyShort) {
  test(`an early stop fails loudly: ${name}`, async () => {
    const { result } = await run(connector(pagination), handler);
    assert.equal(result.streams.users.error?.kind, 'contract');
    assert.notEqual(result.streams.users.status, 'complete');
    assert.equal(result.reconcile.allowed, false);
  });
}

test('a next link of the wrong type is a contract error', async () => {
  const { result } = await run(connector(nextUrl), () => ({ data: rows(5), links: { next: { href: API } } }));
  assert.equal(result.streams.users.error?.kind, 'contract');
});

test('a null total does not end an offset walk', async () => {
  const { result } = await run(connector(offset), u => (u.searchParams.get('offset') === '0' ? { data: rows(100), meta: { total: null } } : { data: u.searchParams.get('offset') === '100' ? rows(50, 100) : [], meta: { total: null } }));
  assert.equal(result.users.length, 150);
});

for (const link of [`<${API}?fields=id,name&p=2>; rel="next"`, `<${API}?p=2>; title="x"; rel=next`, `<${API}?p=9>; rel="last", <${API}?p=2>; rel="prefetch next"`]) {
  test(`Link header parses ${link}`, async () => {
    const { result } = await run(connector({ type: 'link_header', sizeParam: null, pageSize: null }), u => (u.searchParams.has('p') ? { data: rows(5, 5) } : Response.json({ data: rows(5) }, { headers: { link } })));
    assert.equal(result.users.length, 10);
    assert.equal(result.streams.users.status, 'complete');
  });
}

test('rows with no id block reconcile, even below the failure threshold', async () => {
  const { result } = await run(connector({ type: 'none' }), () => ({ data: [...rows(81), ...Array.from({ length: 19 }, () => ({ profile: {} }))] }));
  assert.equal(result.streams.users.status, 'complete');
  assert.equal(result.reconcile.allowed, false);
});

test('mostly duplicate rows block reconcile', async () => {
  const { result } = await run(connector({ type: 'none' }), () => ({ data: Array.from({ length: 1000 }, () => ({ id: 'same' })) }));
  assert.equal(result.reconcile.allowed, false);
});

const eventLog = (overrides: object = {}): Manifest['usage'] => ({
  kind: 'event_log', request: { method: 'GET', path: '/audit', query: {}, body: null, readOnlyPostReason: null }, recordsPath: 'data',
  pagination: { type: 'none' }, requiredScopes: [], planRequirement: null, forEachUser: false, window: null,
  fields: { userRef: field('actor'), userRefType: 'externalId', occurredAt: null, metric: null, metricConstant: 'x', value: null }, ...overrides,
});
const withAudit = (audit: object): Handler => u => (u.pathname.endsWith('/audit') ? audit : { data: rows(3) });

test('complete users and usage allow an inactive verdict', async () => {
  const { result } = await run(connector({ type: 'none' }, { usage: eventLog() }), withAudit({ data: [{ actor: 'u1' }] }));
  assert.equal(result.reconcile.inactive.allowed, true);
});

test('a renamed usage reference fails the stream and the inactive verdict', async () => {
  const { result } = await run(connector({ type: 'none' }, { usage: eventLog() }), withAudit({ data: [{ who: 'u1' }, { who: 'u2' }] }));
  assert.equal(result.streams.usage.status, 'failed');
  assert.equal(result.reconcile.allowed, true);
  assert.equal(result.reconcile.inactive.allowed, false);
});

test('usage cut off by the window cap reports partial', async () => {
  const usage = eventLog({ window: { startParam: 'since', endParam: null, format: 'iso8601', maxDays: 1 } });
  const { result } = await run(connector({ type: 'none' }, { usage }), withAudit({ data: [{ actor: 'u1' }] }));
  assert.equal(result.streams.usage.status, 'partial');
  assert.equal(result.streams.usage.truncated, true);
  assert.equal(result.reconcile.inactive.allowed, false);
});

test('a renamed last activity field cannot read as everyone inactive', async () => {
  const { result } = await run(connector({ type: 'none' }, { usage: { kind: 'last_activity_field' } }), () => ({ data: rows(3, 0, { last_seen: undefined }) }));
  assert.equal(result.streams.usage.status, 'partial');
  assert.equal(result.reconcile.inactive.allowed, false);
});

test('usage that is unavailable leaves user reconcile alone and denies the inactive verdict', async () => {
  const { result } = await run(connector({ type: 'none' }), () => ({ data: rows(3) }));
  assert.equal(result.reconcile.allowed, true);
  assert.equal(result.reconcile.inactive.allowed, false);
});

const writes: [string, (m: Manifest) => void, string][] = [
  ['a GraphQL mutation in a GET query', m => { m.users.request.query = { query: 'mutation { deleteUser }' }; }, 'write_intent'],
  ['a method override query', m => { m.users.request.query = { _method: 'DELETE' }; }, 'write_intent'],
  ['a method override header', m => { m.extraHeaders = { 'X-HTTP-Method-Override': 'DELETE' }; }, 'write_intent'],
];

for (const [name, change, code] of writes) {
  test(`${name} is blocked by the verifier and the runtime`, async () => {
    const m = connector({ type: 'none' });
    change(m);
    assert.ok(codes(m).includes(code));
    const { result, calls } = await run(m, () => ({ data: rows(1) }));
    assert.equal(result.streams.users.error?.kind, 'safety');
    assert.equal(calls.length, 0);
  });
}

test('a write-shaped GET path is blocked, real list paths are not', () => {
  const m = connector({ type: 'none' });
  m.users.request.path = '/admin.users.remove';
  assert.ok(codes(m, 'admin.users.remove').includes('write_path'));
  for (const path of ['/users.list', '/invites', '/deleted_users', '/updates']) {
    m.users.request.path = path;
    assert.ok(!codes(m, path).includes('write_path'), path);
  }
});

test('an undocumented extra header needs a person to confirm it', () => {
  const m = connector({ type: 'none' }, { extraHeaders: { 'X-Team': 'a', 'Notion-Version': '2022-06-28' } });
  assert.deepEqual(codes(m).filter(c => c === 'extra_header').length, 1);
});

for (const ip of ['[::ffff:127.0.0.1]', '[::ffff:a9fe:a9fe]', '[::7f00:1]', '[64:ff9b::a9fe:a9fe]', '[2002:7f00:1::]', '[fec0::1]', '[::1]', '[fe80::1]', '198.18.0.1', '192.0.0.1', '169.254.169.254', '100.64.0.1']) {
  test(`SSRF guard refuses ${ip}`, async () => {
    await assert.rejects(assertPublicUrl(new URL(`https://${ip}/`), true), (e: ConnectorError) => e.kind === 'safety');
  });
}

for (const ip of ['8.8.8.8', '[2606:4700:4700::1111]']) {
  test(`SSRF guard allows public ${ip}`, async () => {
    await assertPublicUrl(new URL(`https://${ip}/`), true);
  });
}

test('a key sent in the query is redacted by name and by value', async () => {
  const m = connector({ type: 'none' }, {}, { type: 'api_key', label: 'Key', in: 'query', name: 'k', prefix: '' });
  const logs: string[] = [];
  await run(m, () => ({ data: rows(1) }), { credentials: { apiKey: 'abcd~efgh!1234' }, log: e => logs.push(JSON.stringify(e)) });
  assert.ok(logs.join().includes('k=') && !/abcd/.test(logs.join()));
});

test('basic credentials echoed as base64 are scrubbed', async () => {
  const m = connector({ type: 'none' }, {}, AUTHS.find(a => a.type === 'basic'));
  const echoed = Buffer.from('admin@corp.co:hunter2hunter2').toString('base64');
  const { result } = await run(m, () => new Response(`bad ${echoed}`, { status: 400 }), { credentials: { username: 'admin@corp.co', password: 'hunter2hunter2' } });
  assert.ok(!result.streams.users.error?.message.includes(echoed));
});

test('a secret straddling the error slice leaves nothing behind', async () => {
  const secret = 'tok-secret-1234567890-abcdefghijklmnopqrstuvwxyz';
  const { result } = await run(connector({ type: 'none' }), () => new Response(`${'x'.repeat(180)}${secret}`, { status: 400 }), { credentials: { token: secret } });
  assert.ok(!result.streams.users.error?.message.includes(secret.slice(0, 12)));
});

test('a secret placed in a redirect host never reaches the error', async () => {
  const { result } = await run(connector({ type: 'none' }), () => new Response(null, { status: 302, headers: { location: 'https://tok-secret-1234.evil.example/' } }));
  assert.equal(result.streams.users.error?.kind, 'safety');
  assert.ok(!/tok-secret/i.test(result.streams.users.error?.message ?? ''));
});

test('a far-future timestamp is bad data, not a crash', async () => {
  const { result } = await run(connector({ type: 'none' }), () => ({ data: rows(2, 0, { last_seen: 1e18 }) }));
  assert.equal(result.quality.invalidTimestamps, 2);
});

test('a tiny rate limit ends the run instead of sleeping for hours', async () => {
  const m = connector(cursor);
  m.rateLimit.maxRequestsPerMinute = 0.001;
  const { result } = await run(m, () => ({ data: rows(2), meta: { next: `c${Math.random()}` } }));
  assert.equal(result.streams.users.error?.kind, 'budget');
});

test('a rotated refresh token replaces the old one within a run', async () => {
  const auth = AUTHS.find(a => a.type === 'oauth2_authorization_code')!;
  const sent: string[] = [];
  let rt = 0;
  const { result } = await run(connector(cursor, {}, auth), (u, init) => {
    if (init.method === 'POST') {
      sent.push(new URLSearchParams(String(init.body)).get('refresh_token')!);
      return { access_token: `at${++rt}`, refresh_token: `rotated-${rt}` };
    }
    const bearer = new Headers(init.headers).get('authorization');
    const page = Number(u.searchParams.get('cursor') ?? 0);
    if (bearer !== `Bearer at${page + 1}`) return new Response('expired', { status: 401 });
    return { data: rows(1, page), meta: { next: page < 1 ? String(page + 1) : null } };
  }, { credentials: { accessToken: 'first', refreshToken: 'rt0' } });
  assert.deepEqual(sent, ['rt0', 'rotated-1']);
  assert.equal(result.streams.users.status, 'complete');
});

test('a quote of only punctuation proves nothing, a non-Latin quote can', () => {
  const m = connector({ type: 'none' }, { evidence: [{ claim: 'auth', quote: '!!!!!!!!!!' }] });
  assert.ok(codes(m).includes('quote_not_found'));
  m.evidence = [{ claim: 'auth', quote: 'ユーザー一覧を取得します' }];
  assert.ok(!codes(m, 'ユーザー一覧を取得します').includes('quote_not_found'));
});

test('hostile pages parse in linear time', () => {
  const started = Date.now();
  htmlToText('<'.repeat(1_000_000));
  htmlToText('<script>'.repeat(200_000));
  htmlToText('<a '.repeat(300_000));
  specLinksIn(`"${'openapi'.repeat(300_000)}`, new URL('https://docs.acme.test/'));
  specLinksIn('<a '.repeat(300_000), new URL('https://docs.acme.test/'));
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
});

test('html stripping and spec discovery still find real content', () => {
  assert.match(htmlToText('<p>Hi</p><script>evil()</script><nav>menu</nav><p>there</p>'), /^Hi\s+there$/);
  const links = specLinksIn(`<redoc spec-url="/a.yaml"></redoc> "https://x.test/openapi.json?v=1" <a href="/swagger.yaml">`, new URL('https://docs.acme.test/'));
  assert.deepEqual(links.map(u => u.pathname).sort(), ['/a.yaml', '/openapi.json', '/swagger.yaml']);
});
