import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Manifest } from '../src/manifest.ts';
import { startVirtualMock } from '../src/mock-virtual.ts';
import { startMock } from '../src/mock.ts';
import { runScenarioOn, SCENARIOS } from '../src/scenarios.ts';
import { createHash as shimHash } from '../web/src/shims/crypto.ts';

const corpus = readdirSync('corpus/manifests').map(f => Manifest.parse(JSON.parse(readFileSync(`corpus/manifests/${f}`, 'utf8'))));

for (const m of corpus) {
  test(`${m.app.slug} passes the sandbox the same over HTTP and the virtual fetch`, async () => {
    for (const s of SCENARIOS) {
      const http = await runScenarioOn(startMock, m, s);
      const virtual = await runScenarioOn(startVirtualMock, m, s);
      assert.equal(virtual.status, http.status, `${s.id}: virtual ${virtual.detail}, http ${http.detail}`);
      assert.notEqual(http.status, 'fail', `${s.id}: ${http.detail}`);
    }
  });
}

test('the browser hash matches node:crypto', () => {
  for (const alg of ['sha1', 'sha256'] as const) {
    assert.equal(shimHash(alg).update('héllo').update(' wörld').digest('hex'), createHash(alg).update('héllo wörld').digest('hex'));
  }
});

test('the virtual mock refuses any origin that is not its own', async () => {
  const mock = await startVirtualMock(corpus[0]);
  await assert.rejects(mock.fetch!('https://example.com/'), /no route/);
});

test('the virtual mock honours an abort during a hang', async () => {
  const mock = await startVirtualMock(corpus[0], { intercept: () => ({ hangMs: 5000, body: '{}' }) });
  const started = Date.now();
  const path = corpus[0].users.request.path.replace(/\{\{connection\.(\w+)\}\}/g, (_, k: string) => mock.connection[k]);
  const url = corpus[0].baseUrl.replace(/^https:\/\/[^/]+/, mock.origin) + path;
  await assert.rejects(mock.fetch!(url, { signal: AbortSignal.timeout(20) }), { name: 'TimeoutError' });
  assert.ok(Date.now() - started < 1000);
});
