import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { bundleFrom } from '../src/connector-source.ts';
import { startMock } from '../src/mock.ts';
import { AUTHS, PAGINATIONS, makeManifest } from './fixtures.ts';

const SOURCES = { runtime: readFileSync('src/runtime.ts', 'utf8'), manifest: readFileSync('src/manifest.ts', 'utf8') };

test('the generated bundle runs on its own against the sandbox', async () => {
  const m = makeManifest(PAGINATIONS[1], AUTHS[0]);
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  for (const [name, text] of Object.entries(bundleFrom(m, 'abc', SOURCES))) writeFileSync(join(dir, name), text);
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const mock = await startMock(m);
  const script = `import { getAcmeUsers } from './acme.connector.ts';
const r = await getAcmeUsers({ credentials: ${JSON.stringify(mock.credentials)}, sandboxOrigin: '${mock.origin}' });
console.log(JSON.stringify({ count: r.users.length, complete: r.complete }));`;
  writeFileSync(join(dir, 'run.ts'), script);
  const child = await new Promise<string>((res) => {
    import('node:child_process').then(({ exec }) => exec('node --no-warnings run.ts', { cwd: dir }, (_e, out, err) => res(out + err)));
  });
  await mock.stop();
  assert.equal(child.trim(), '{"count":57,"complete":true}');
});

test('a bundle with settings applies limits, filters logs and caches a complete run', async () => {
  const m = makeManifest(PAGINATIONS[1], AUTHS[0]);
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  const settings = { limits: { maxRetries: 1 }, logLevel: 'warn' as const, cacheTtlMs: 60_000, approvedPaths: ['/me'], blockedPaths: ['/secrets'], skipAuth: false, exports: { users: true, usage: true } };
  const files = bundleFrom(m, 'abc', SOURCES, settings);
  assert.match(files['acme.connector.ts'], /Blocked +\/secrets/);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const mock = await startMock(m);
  writeFileSync(join(dir, 'run.ts'), `import { getAcmeUsers } from './acme.connector.ts';
const logged = [];
const options = { credentials: ${JSON.stringify(mock.credentials)}, sandboxOrigin: '${mock.origin}', log: e => logged.push(e.level) };
const first = await getAcmeUsers(options);
await getAcmeUsers(options);
console.log(JSON.stringify({ count: first.users.length, quiet: logged.every(l => l !== 'info') }));`);
  const out = await new Promise<string>((res) => {
    import('node:child_process').then(({ exec }) => exec('node --no-warnings run.ts', { cwd: dir }, (_e, o, err) => res(o + err)));
  });
  const requests = mock.requests();
  await mock.stop();
  assert.equal(out.trim(), '{"count":57,"quiet":true}');
  const once = await startMock(m);
  writeFileSync(join(dir, 'once.ts'), `import { getAcmeUsers } from './acme.connector.ts';
await getAcmeUsers({ credentials: ${JSON.stringify(once.credentials)}, sandboxOrigin: '${once.origin}' });`);
  await new Promise<void>((res) => {
    import('node:child_process').then(({ exec }) => exec('node --no-warnings once.ts', { cwd: dir }, () => res()));
  });
  assert.equal(requests, once.requests(), 'the second call was served from the cache');
  await once.stop();
});
