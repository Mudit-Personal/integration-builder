import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hashManifest } from '../src/hash.ts';
import { Manifest } from '../src/manifest.ts';
import { startVirtualMock } from '../src/mock-virtual.ts';
import { runScenarioOn, SCENARIOS } from '../src/scenarios.ts';
import { buildPack } from '../scripts/build-packs.ts';
import { endpointsFor, type AppPack } from '../src/pack-build.ts';
import { applyDecisions, decisionRows, DEFAULT_DECISIONS, isAllowed, pageSizeOptions, runtimeLimits, type Decisions } from '../web/src/decisions.ts';
import { buildFiles, buildPrompt } from '../web/src/handover.ts';
import { makeManifest, PAGINATIONS, AUTHS } from './fixtures.ts';

const corpus = readdirSync('corpus/manifests').map(f => Manifest.parse(JSON.parse(readFileSync(`corpus/manifests/${f}`, 'utf8'))));
const packOf = (manifest: Manifest, endpoints: AppPack['endpoints'] = []): AppPack => ({ manifest, hash: hashManifest(manifest), docsUrl: '', findings: null, readSteps: [], endpoints });
const decide = (patch: Partial<Decisions>) => ({ ...DEFAULT_DECISIONS, ...patch });

test('default decisions leave every corpus manifest and its hash untouched', () => {
  for (const m of corpus) assert.equal(hashManifest(applyDecisions(m, DEFAULT_DECISIONS)), hashManifest(m));
});

test('the chosen auth method moves first and the input is not mutated', () => {
  const m = corpus.find(c => c.authMethods.length === 3)!;
  const before = JSON.stringify(m);
  const next = applyDecisions(m, decide({ authIndex: 2 }));
  assert.equal(next.authMethods[0].label, m.authMethods[2].label);
  assert.equal(next.authMethods.length, 3);
  assert.equal(JSON.stringify(m), before);
  assert.notEqual(hashManifest(next), hashManifest(m));
});

test('page size applies only where the pagination type has one', () => {
  const offset = PAGINATIONS.find(p => p.type === 'offset')!;
  const sized = applyDecisions(makeManifest(offset, AUTHS[0]), decide({ pageSize: 20 }));
  assert.equal(sized.users.pagination.type === 'offset' && sized.users.pagination.pageSize, 20);
  const none = PAGINATIONS.find(p => p.type === 'none')!;
  assert.deepEqual(applyDecisions(makeManifest(none, AUTHS[0]), decide({ pageSize: 20 })).users.pagination, none);
  assert.deepEqual(pageSizeOptions(none), []);
  assert.deepEqual(pageSizeOptions({ type: 'next_url', urlPath: 'n', sizeParam: null, pageSize: null }), []);
});

test('turning usage off or blocking its endpoint makes usage unavailable', () => {
  const m = makeManifest(PAGINATIONS[1], AUTHS[0]);
  assert.equal(applyDecisions(m, decide({ deliverables: { usage: false, caching: false } })).usage.kind, 'unavailable');
  assert.equal(applyDecisions(m, decide({ access: { usage: false } })).usage.kind, 'unavailable');
});

test('every corpus app has rows with a stated source and quotes from its evidence', () => {
  for (const m of corpus) {
    for (const row of decisionRows(packOf(m), DEFAULT_DECISIONS)) {
      assert.ok(row.value && row.plain, `${m.app.slug} ${row.title}`);
      if (row.source === 'docs' && row.why) {
        const words = (t: string) => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        assert.ok(m.evidence.some(e => words(e.quote) === row.why), `${m.app.slug} ${row.title}`);
      }
    }
  }
});

test('a plan-gated usage stream asks the person, and recommends leaving it out', () => {
  const m = makeManifest(PAGINATIONS[1], AUTHS[0]);
  const q = decisionRows(packOf(m), DEFAULT_DECISIONS).find(r => r.question)!.question!;
  assert.equal(q.id, 'usage');
  assert.deepEqual(q.patch(q.recommended).deliverables?.usage, false);
});

test('every auth method and decision set still passes the sandbox', async () => {
  for (const m of corpus) {
    for (const authIndex of m.authMethods.keys()) {
      const d = decide({ authIndex, retries: 2, pageSize: pageSizeOptions(m.users.pagination)[0] ?? null, deliverables: { usage: authIndex === 0, caching: true } });
      const applied = applyDecisions(m, d);
      for (const s of SCENARIOS) {
        const r = await runScenarioOn(startVirtualMock, applied, s, runtimeLimits(d));
        assert.notEqual(r.status, 'fail', `${m.app.slug} auth ${authIndex} ${s.id}: ${r.detail}`);
      }
    }
  }
});

test('sensitive reads come from the spec, and approved paths stay out of that list', () => {
  const m = makeManifest(PAGINATIONS[1], AUTHS[0]);
  const op = (path: string, extra = {}) => ({ method: 'GET', path, summary: '', description: '', parameters: [], responseSchema: null, scopes: [], deprecated: false, ...extra });
  const operations = [op('/contacts'), op('/contacts/{id}'), op('/orgs/{{context.orgId}}/members'), op('/billing', { method: 'POST' }), op('/invoices', { deprecated: true }), op('/widgets')];
  const source = { kind: 'spec', origin: null, spec: { title: '', version: '', format: 'openapi3', servers: [], authSchemes: [], operations, description: '' }, promptText: '', corpus: '', warnings: [] } as Parameters<typeof endpointsFor>[1];
  const rows = endpointsFor(m, source);
  assert.deepEqual(rows.filter(e => e.sensitivity === 'sensitive').map(e => e.path), ['/contacts']);
  assert.deepEqual(rows.filter(e => e.sensitivity !== 'sensitive').map(e => e.key), ['context:org', 'users', 'usage']);
  assert.ok(!isAllowed(rows.at(-1)!, {}), 'sensitive starts blocked');
  assert.ok(isAllowed(rows[1], { users: false }), 'the users endpoint cannot be blocked');
});

test('a pack carries real findings, and none for an app with no spec', async () => {
  const { pack, entry } = await buildPack('okta.json');
  assert.equal(pack.hash, hashManifest(pack.manifest));
  assert.ok(pack.findings?.length);
  assert.ok(entry.domains.includes('okta.com'));
  assert.equal((await buildPack('notion.json')).pack.findings, null);
});

test('access decisions reach the prompt and the code header', () => {
  const m = makeManifest(PAGINATIONS[1], AUTHS[0]);
  const endpoint = { key: 'sensitive:/contacts', name: 'Contacts', path: '/contacts', sensitivity: 'sensitive' as const, note: '' };
  const pack = packOf(m, [endpoint]);
  const sources = { runtime: 'r', manifest: 'm' };
  const blocked = buildFiles(pack, DEFAULT_DECISIONS, sources, 20);
  assert.match(buildPrompt(pack, DEFAULT_DECISIONS, blocked, 20), /Never call: \/contacts/);
  assert.match(blocked[0].code, /Blocked +\/contacts/);
  const allowed = decide({ access: { [endpoint.key]: true } });
  const files = buildFiles(pack, allowed, sources, 20);
  assert.match(buildPrompt(pack, allowed, files, 20), /only these paths: \/contacts/);
  assert.match(files[0].code, /Approved +\/contacts/);
  assert.deepEqual(files.map(f => f.name), ['acme.connector.ts', 'manifest.json', 'runtime.ts', 'manifest.ts', 'README.md']);
});
