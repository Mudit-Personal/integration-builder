import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSandbox, SCENARIOS, runScenario } from '../src/scenarios.ts';
import { runConnector, assertPublicUrl, ConnectorError, getPath } from '../src/runtime.ts';
import { startMock } from '../src/mock.ts';
import { AUTHS, PAGINATIONS, makeManifest } from './fixtures.ts';

for (const pagination of PAGINATIONS) {
  const name = `${pagination.type} ${JSON.stringify(pagination).slice(0, 70)}`;
  test(`every fault scenario holds with ${name}`, async () => {
    const results = await runSandbox(makeManifest(pagination, AUTHS[0]));
    assert.deepEqual(results.filter(r => r.status === 'fail').map(r => `${r.id}: ${r.detail}`), []);
  });
}

for (const auth of AUTHS) {
  test(`every fault scenario holds with ${auth.type} ${JSON.stringify(auth).slice(0, 60)}`, async () => {
    const results = await runSandbox(makeManifest(PAGINATIONS[1], auth));
    assert.deepEqual(results.filter(r => r.status === 'fail').map(r => `${r.id}: ${r.detail}`), []);
  });
}

test('GraphQL pagination moves through variables and stops on hasNextPage', async () => {
  const query = 'query Users($after: String) { users(after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }';
  const m = makeManifest({
    type: 'cursor', cursorPath: 'data.users.pageInfo.endCursor', cursorParam: 'after', cursorIn: 'graphql_variable',
    hasMorePath: 'data.users.pageInfo.hasNextPage', sizeParam: null, pageSize: null,
  }, AUTHS[0], { context: [] });
  Object.assign(m.users.request, { method: 'POST', path: '/graphql', query: {}, body: { query }, readOnlyPostReason: 'GraphQL read' });
  m.users.recordsPath = 'data.users.nodes';
  const results = await runSandbox(m);
  assert.deepEqual(results.filter(r => r.status === 'fail').map(r => `${r.id}: ${r.detail}`), []);
  assert.equal(results.find(r => r.id === 'graphql_error_200')?.status, 'pass');
});

test('list-index paths read through arrays', () => {
  assert.equal(getPath({ actors: [{ id: 'a' }] }, 'actors[0].id'), 'a');
  assert.equal(getPath({ '@odata.nextLink': 'x' }, '@odata.nextLink'), 'x');
});

test('a wrong credential fails as auth, proving the mock really checks it', async () => {
  const m = makeManifest(PAGINATIONS[1], AUTHS[0]);
  const mock = await startMock(m);
  const r = await runConnector(m, { credentials: { token: 'wrong-value' }, sandboxOrigin: mock.origin, sleep: async () => {} });
  await mock.stop();
  assert.equal(r.streams.context.error?.kind, 'auth');
});

test('a manifest that claims POST without a read-only reason cannot run', async () => {
  const m = makeManifest({ type: 'none' }, AUTHS[0], { context: [] });
  Object.assign(m.users.request, { method: 'POST', path: '/members' });
  const mock = await startMock(m);
  const r = await runConnector(m, { ...mock, credentials: mock.credentials, sandboxOrigin: mock.origin, sleep: async () => {} });
  await mock.stop();
  assert.equal(r.streams.users.error?.kind, 'safety');
  assert.equal(mock.requests(), 0);
});

test('a GraphQL mutation cannot run even with a read-only reason', async () => {
  const m = makeManifest({ type: 'none' }, AUTHS[0], { context: [] });
  Object.assign(m.users.request, { method: 'POST', path: '/members', body: { query: 'mutation { deleteUser(id: 1) }' }, readOnlyPostReason: 'search' });
  const mock = await startMock(m);
  const r = await runConnector(m, { credentials: mock.credentials, sandboxOrigin: mock.origin, sleep: async () => {} });
  await mock.stop();
  assert.equal(r.streams.users.error?.kind, 'safety');
});

test('a connection value cannot change the host', async () => {
  const m = makeManifest({ type: 'none' }, AUTHS[0], {
    baseUrl: 'https://{sub}.acme.test', connectionFields: [{ name: 'sub', label: 'Sub', example: 'x' }],
  });
  for (const sub of ['evil.com#', 'a.b', 'evil.com/', '169.254.169.254', '']) {
    const r = await runConnector(m, { credentials: { token: 't' }, connection: { sub } });
    assert.ok(['safety', 'config'].includes(r.streams.users.error?.kind ?? ''), `${sub} got ${r.streams.users.error?.kind}`);
  }
});

test('private and metadata destinations are refused', async () => {
  for (const url of ['https://127.0.0.1/', 'https://169.254.169.254/latest', 'https://[::1]/', 'https://10.0.0.1/', 'https://2130706433/', 'https://localhost/', 'http://example.com/', 'https://u:p@example.com/']) {
    await assert.rejects(assertPublicUrl(new URL(url), true), (e: ConnectorError) => e.kind === 'safety', url);
  }
  await assertPublicUrl(new URL('https://api.calendly.com/'), true);
});

test('a vendor value stays one encoded path segment', async () => {
  const m = makeManifest({ type: 'none' }, AUTHS[0]);
  const paths: string[] = [];
  const mock = await startMock(m, {
    intercept: (rt, _n, url) => {
      paths.push(url.pathname);
      return rt.stream === 'context' ? { body: JSON.stringify({ resource: { org: '../../admin' } }) } : undefined;
    },
  });
  await runConnector(m, { credentials: mock.credentials, sandboxOrigin: mock.origin, sleep: async () => {} });
  await mock.stop();
  assert.ok(paths.includes('/v2/orgs/..%2F..%2Fadmin/members'), paths.join(' '));
});

test('rotated refresh tokens reach the caller', async () => {
  const m = makeManifest(PAGINATIONS[1], AUTHS[7]);
  const rotated: string[] = [];
  const s = SCENARIOS.find(x => x.id === 'token_expires_midway')!;
  const mock = await startMock(m, s.fault!(m, { offsite: () => '' }));
  const r = await runConnector(m, { credentials: mock.credentials, sandboxOrigin: mock.origin, sleep: async () => {}, onRefreshTokenRotated: t => rotated.push(t) });
  await mock.stop();
  assert.equal(r.streams.users.status, 'complete');
  assert.equal(rotated.length, 1);
});

test('scenario runner fails when the behaviour is wrong', async () => {
  const m = makeManifest(PAGINATIONS[1], AUTHS[0]);
  const broken = { ...SCENARIOS[0], expect: () => 'forced failure' };
  assert.equal((await runScenario(m, broken)).status, 'fail');
});
