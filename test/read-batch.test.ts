import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isRateLimit, nextUrl, pending, type Outcome } from '../scripts/read-batch.ts';
import type { TopApp } from '../scripts/build-packs.ts';
import { setPath } from '../src/mock.ts';
import { getPath } from '../src/runtime.ts';
import { toApiSpec } from '../src/spec.ts';

const app: TopApp = { slug: 'acme', name: 'Acme', docsUrl: 'https://docs.acme.test', why: '', readUrls: ['https://acme.test/spec.json'] };
const row = (status: Outcome['status'], readUrl: string) => ({ slug: 'acme', status, readUrl }) as Outcome;

test('an attempted app stays settled unless its latest status is retried', () => {
  assert.deepEqual(pending([app], [], []), [app]);
  assert.deepEqual(pending([app], [row('unreadable', 'a')], []), []);
  assert.deepEqual(pending([app], [row('unreadable', 'a')], ['unreadable']), [app]);
  assert.deepEqual(pending([app], [row('unreadable', 'a'), row('passed', 'b')], ['unreadable']), []);
});

test('a retry reads from a URL not tried yet, then wraps to the first', () => {
  assert.equal(nextUrl(app, []), 'https://acme.test/spec.json');
  assert.equal(nextUrl(app, [row('unreadable', 'https://acme.test/spec.json')]), 'https://docs.acme.test');
  assert.equal(nextUrl(app, [row('unreadable', 'https://acme.test/spec.json'), row('unreadable', 'https://docs.acme.test')]), 'https://acme.test/spec.json');
});

test('rate limits are told apart from other model failures', () => {
  assert.ok(isRateLimit("Model call failed (exit 1): You've hit your usage limit"));
  assert.ok(!isRateLimit('Model call failed (exit 1): no structured output'));
});

test('the top 50 list has 50 unique apps and covers every saved manifest', () => {
  const { apps } = JSON.parse(readFileSync('corpus/top50.json', 'utf8')) as { apps: TopApp[] };
  const slugs = new Set(apps.map(a => a.slug));
  assert.equal(slugs.size, 50);
  for (const f of readdirSync('corpus/manifests')) assert.ok(slugs.has(f.replace(/\.json$/, '')), f);
});

test('a security scheme that points into another file is skipped, not fatal', () => {
  const spec = toApiSpec({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {}, components: { securitySchemes: { ext: { $ref: './common.yaml#/x' } } } });
  assert.deepEqual(spec?.authSchemes, []);
});

test('the mock writes indexed paths the runtime can read back', () => {
  const body = {};
  setPath(body, 'organizations[0].id', 'x');
  assert.equal(getPath(body, 'organizations[0].id'), 'x');
});
