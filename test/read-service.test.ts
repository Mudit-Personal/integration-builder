import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { buildPack } from '../scripts/build-packs.ts';
import { hashManifest } from '../src/hash.ts';
import { ingest } from '../src/ingest.ts';
import type { Llm } from '../src/llm.ts';
import { Manifest } from '../src/manifest.ts';
import { assemblePack, type AppPack } from '../src/pack-build.ts';
import { handleRead, type ReadDeps, type ReadEvent } from '../src/read-service.ts';

const SPEC = readFileSync('corpus/specs/slack.json', 'utf8');
const MANIFEST = JSON.parse(readFileSync('corpus/manifests/slack.json', 'utf8'));
const usage = { inputTokens: 1000, outputTokens: 200, costUsd: 0.01, ms: 5, model: 'fake' };
const replying = (output: unknown): Llm => async () => ({ output, usage });

const servers: Server[] = [];
const serve = async (deps: ReadDeps) => {
  const server = createServer((req, res) => void handleRead(req, res, deps));
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/read`;
};
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const events = async (res: Response) => (await res.text()).split('\n').filter(Boolean).map(l => JSON.parse(l) as ReadEvent);

test('a server with no model answers 503', async () => {
  assert.equal((await post(await serve({ llm: null }), { text: SPEC })).status, 503);
});

test('other methods, broken JSON, and foreign content types are rejected', async () => {
  const url = await serve({ llm: replying({}) });
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await post(url, { text: 7 })).status, 400);
});

test('an oversized body is rejected', async () => {
  const url = await serve({ llm: replying({}) });
  assert.equal((await post(url, { text: 'x'.repeat(5_000_000) })).status, 413);
});

test('a pasted spec streams progress, then a pack the web app can use', async () => {
  const url = await serve({ llm: replying(MANIFEST) });
  const res = await post(url, { text: SPEC, url: 'https://api.slack.com/web' });
  assert.equal(res.headers.get('content-type'), 'application/x-ndjson');
  const all = await events(res);
  assert.ok(all.slice(0, -1).length >= 2 && all.slice(0, -1).every(e => e.type === 'progress'));
  const last = all.at(-1)!;
  assert.equal(last.type, 'done', JSON.stringify(last).slice(0, 300));
  const pack = (last as { pack: AppPack }).pack;
  assert.equal(pack.hash, hashManifest(Manifest.parse(pack.manifest)));
  assert.equal(pack.readSteps.length, 7);
  assert.ok(pack.endpoints.some(e => e.key === 'users'));
  assert.ok(Array.isArray(pack.findings));
  assert.deepEqual(pack.read, { source: 'spec', attempts: 1, inputTokens: 1000, outputTokens: 200, ms: 5 });
});

test('a manifest that stays blocked fails in plain words after two attempts', async () => {
  let calls = 0;
  const bad = { ...MANIFEST, users: { ...MANIFEST.users, request: { ...MANIFEST.users.request, path: '/not/in/the/spec' } } };
  const url = await serve({ llm: async () => { calls++; return { output: bad, usage }; } });
  const last = (await events(await post(url, { text: SPEC }))).at(-1)!;
  assert.equal(last.type, 'failed');
  assert.equal((last as { code: string }).code, 'blocked');
  assert.equal(calls, 2);
});

test('output that is never a manifest fails without a pack', async () => {
  const url = await serve({ llm: replying(null) });
  const last = (await events(await post(url, { text: SPEC }))).at(-1)!;
  assert.equal((last as { code: string }).code, 'unusable');
});

test('thin pasted docs ask for more, a model crash stays generic, and the deadline reads as a timeout', async () => {
  const quiet = await serve({ llm: replying(MANIFEST) });
  assert.equal(((await events(await post(quiet, { text: 'too short' }))).at(-1) as { code: string }).code, 'needs_paste');
  const crash = await serve({ llm: async () => { throw new Error('secret docs text'); } });
  const failed = (await events(await post(crash, { text: SPEC }))).at(-1) as { code: string; message: string };
  assert.equal(failed.code, 'error');
  assert.ok(!failed.message.includes('secret'));
  const hang: Llm = ({ signal }) => new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted'))));
  const slow = await serve({ llm: hang, deadlineMs: 50 });
  assert.equal(((await events(await post(slow, { text: SPEC }))).at(-1) as { code: string }).code, 'timeout');
});

test('hanging up stops the model call', async () => {
  let stopped: () => void;
  const stoppedPromise = new Promise<void>(r => { stopped = r; });
  const hang: Llm = ({ signal }) => new Promise((_, reject) => signal!.addEventListener('abort', () => { stopped(); reject(new Error('aborted')); }));
  const url = await serve({ llm: hang });
  const ctrl = new AbortController();
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: SPEC }), signal: ctrl.signal });
  await res.body!.getReader().read();
  ctrl.abort();
  await stoppedPromise;
});

test('the shared pack code rebuilds a committed pack exactly', async () => {
  const committed = JSON.parse(readFileSync('web/public/packs/okta.json', 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify((await buildPack('okta.json')).pack)), committed);
});

test('read steps name a pasted source truthfully', async () => {
  const docs = await ingest({ text: 'Authentication uses an API key. '.repeat(40) });
  const pack = assemblePack(Manifest.parse(MANIFEST), docs, '', []);
  assert.match(pack.readSteps[0].description, /^Pasted docs for/);
  assert.ok(!/corpus|demo/i.test(JSON.stringify(pack.readSteps)));
});
