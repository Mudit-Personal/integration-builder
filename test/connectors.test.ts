import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { hashManifest } from '../src/hash.ts';
import { dropPack, loadConnectors, loadRole, packLost, readPack, saveConnectors, savePack, saveRole, statusOf, upsert, type SavedConnector } from '../web/src/connectors.ts';
import { applyDecisions, DEFAULT_DECISIONS } from '../web/src/decisions.ts';
import type { AppPack } from '../web/src/pack.ts';
import { APPS, CHECKS, CODE, initial, READ, reducer, type Action, type Flow } from '../web/src/state.ts';
import { AUTHS, makeManifest, PAGINATIONS } from './fixtures.ts';

const manifest = makeManifest(Object.values(PAGINATIONS)[0], Object.values(AUTHS)[0]);
const pack: AppPack = { manifest, hash: hashManifest(manifest), docsUrl: '', findings: null, readSteps: [], endpoints: [] };
const hash = hashManifest(applyDecisions(manifest, DEFAULT_DECISIONS));

let items: Map<string, string>;
let full: boolean;
const fakeStorage = {
  getItem: (k: string) => items.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (full) throw new DOMException('quota', 'QuotaExceededError');
    items.set(k, v);
  },
  removeItem: (k: string) => { items.delete(k); },
};
Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage, configurable: true });

beforeEach(() => {
  items = new Map();
  full = false;
});

const play = (flow: Flow, ...actions: Action[]) => actions.reduce(reducer, flow);
const started = (id = 'a') => ({ ...play(initial(), { type: 'new', id }), slug: 'acme' });
const passing = (flow: Flow) => play(flow, { type: 'checks-start', replay: false }, { type: 'checks-done', hash, fixed: ['pass', 'pass', 'skipped'] });
const failing = (flow: Flow) => play(flow, { type: 'checks-start', replay: false }, { type: 'checks-done', hash, fixed: ['pass', 'fail'] });
const atRead = (flow: Flow) => play(flow, { type: 'go', step: READ });
const atCode = (flow: Flow) => play(passing(atRead(flow)), { type: 'go', step: CODE });
const saved = (flow: Flow, list: SavedConnector[] = [], now = 1, p = pack) => upsert(list, flow, p, now);
const changeDecision: Action = { type: 'decide', patch: { logLevel: 'debug' } };

test('a connector is not saved until it leaves Source', () => {
  assert.deepEqual(saved(started()), []);
  assert.equal(saved(atRead(started()))[0].name, 'Acme');
});

test('ready needs passed checks on the current hash and the Code step', () => {
  assert.equal(saved(atRead(started()))[0].status, 'draft');
  assert.equal(saved(passing(atRead(started())))[0].status, 'draft');
  assert.equal(saved(atCode(started()))[0].status, 'ready');
});

test('failed checks stay draft even after Code was reached', () => {
  assert.equal(saved(failing(atCode(started())))[0].status, 'draft');
  assert.equal(failing(atRead(started())).result?.failed, 1);
});

test('the check result counts passes across scenarios and fixed checks, not skips', () => {
  assert.deepEqual(passing(atRead(started())).result, { hash, passed: 2, failed: 0 });
});

test('a changed decision returns a ready connector to draft, even one that leaves the hash alone', () => {
  const after = play(atCode(started()), changeDecision);
  assert.equal(hashManifest(applyDecisions(manifest, after.decisions)), hash);
  assert.equal(saved(after)[0].status, 'draft');
});

test('a pack that changed underneath a ready connector returns it to draft', () => {
  const changed = { ...manifest, baseUrl: 'https://api.acme.test/v3' };
  assert.equal(saved(atCode(started()), [], 1, { ...pack, manifest: changed })[0].status, 'draft');
});

test('reopening restores decisions and stays ready, on Checks rather than Code', () => {
  const flow = play(started(), { type: 'decide', patch: { retries: 5 } });
  const [c] = saved(atCode(flow));
  assert.equal(c.step, CHECKS);
  const opened = reducer(initial(), { type: 'open', saved: c, lost: false });
  assert.equal(opened.step, CHECKS);
  assert.equal(opened.decisions.retries, 5);
  assert.equal(opened.checks.kind, 'idle');
  assert.equal(saved(opened, [c])[0].status, 'ready');
});

test('reopening without changes keeps the list and its time', () => {
  const list = saved(atCode(started()), [], 1);
  const opened = reducer(initial(), { type: 'open', saved: list[0], lost: false });
  assert.equal(saved(opened, list, 2), list);
});

test('a change bumps the time and moves the connector to the top', () => {
  const list = saved(atRead(started('b')), saved(atRead(started('a')), [], 1), 2);
  const next = saved(play(atRead(started('a')), changeDecision), list, 3);
  assert.deepEqual(next.map(c => [c.id, c.updatedAt]), [['a', 3], ['b', 2]]);
});

test('start over keeps the connector and its app, and clears its progress', () => {
  const reset = reducer(atCode(started()), { type: 'reset' });
  const [c] = saved(reset, saved(atCode(started())));
  assert.equal(c.id, 'a');
  assert.equal(c.slug, 'acme');
  assert.equal(c.step, 0);
  assert.equal(c.status, 'draft');
});

test('the list survives a reload', () => {
  const list = saved(atRead(started()));
  assert.equal(saveConnectors(list), true);
  assert.deepEqual(loadConnectors(), list);
});

test('corrupt storage reads as an empty list', () => {
  items.set('ib-connectors', '{not json');
  assert.deepEqual(loadConnectors(), []);
  items.set('ib-connectors', '[{"id":"x"},null]');
  assert.deepEqual(loadConnectors(), []);
});

test('a full browser reports failure and keeps the pack for this visit', () => {
  full = true;
  assert.equal(savePack('quota', pack), false);
  assert.equal(readPack('quota')?.hash, pack.hash);
  assert.equal(saveConnectors([]), false);
  dropPack('quota');
  assert.equal(readPack('quota'), null);
});

test('a live connector whose pack is gone or replaced is reported lost', () => {
  const flow = { ...atRead(started('live')), live: { url: 'https://x.test', hash: pack.hash } };
  const [c] = saved(flow);
  assert.equal(packLost(c), true);
  savePack('live', { ...pack, hash: 'other' });
  assert.equal(packLost(c), true);
  savePack('live', pack);
  assert.equal(packLost(c), false);
  dropPack('live');
  assert.equal(packLost(saved(atRead(started()))[0]), false);
});

test('opening a lost connector goes to Source with its link, ready to read again', () => {
  const flow = { ...atCode(started('live')), url: 'https://x.test', live: { url: 'https://x.test', hash: pack.hash } };
  const opened = reducer(initial(), { type: 'open', saved: saved(flow)[0], lost: true });
  assert.deepEqual([opened.step, opened.live, opened.url, opened.result], [0, null, 'https://x.test', null]);
});

const app = APPS[0];

test('an old flow migrates to one connector, once', () => {
  items.set('ibv2', JSON.stringify({ step: 2, maxStep: 2, slug: app.slug, url: app.docsUrl, live: null, decisions: { ...DEFAULT_DECISIONS, retries: 5 } }));
  const [c, ...rest] = loadConnectors();
  assert.deepEqual([c.slug, c.name, c.step, c.status, c.flow.decisions.retries, rest.length], [app.slug, app.name, 2, 'draft', 5, 0]);
  assert.equal(items.has('ibv2'), false);
  assert.deepEqual(loadConnectors().map(x => x.id), [c.id]);
});

test('an old live read migrates with its pack', () => {
  items.set('ibv2', JSON.stringify({ step: 2, maxStep: 2, slug: 'acme', url: 'https://x.test', live: { url: 'https://x.test', hash: pack.hash } }));
  items.set('ibv2-pack', JSON.stringify(pack));
  const [c] = loadConnectors();
  assert.equal(c.name, 'Acme');
  assert.equal(packLost(c), false);
  assert.equal(items.has('ibv2-pack'), false);
});

test('an old flow still on Source migrates to nothing', () => {
  items.set('ibv2', JSON.stringify({ step: 0, maxStep: 0, slug: app.slug }));
  assert.deepEqual(loadConnectors(), []);
  assert.equal(items.has('ibv2'), false);
});

test('an old flow stays put when the new list cannot be written', () => {
  items.set('ibv2', JSON.stringify({ step: 2, maxStep: 2, slug: app.slug }));
  full = true;
  assert.equal(loadConnectors().length, 1);
  assert.equal(items.has('ibv2'), true);
});

test('role survives a reload and ignores junk', () => {
  saveRole('Viewer');
  assert.equal(loadRole(), 'Viewer');
  items.set('ib-role', '"Root"');
  assert.equal(loadRole(), 'Builder');
});

test('a first visit opens on the sample workspace, and its ready connectors hold up on reopening', () => {
  const list = loadConnectors(10_000_000);
  assert.ok(list.length >= 3);
  assert.ok(list.some(c => c.status === 'draft'));
  for (const c of list.filter(x => x.status === 'ready')) {
    const p = JSON.parse(readFileSync(`web/public/packs/${c.slug}.json`, 'utf8')) as AppPack;
    assert.equal(c.hash, hashManifest(applyDecisions(p.manifest, c.flow.decisions)), `${c.slug} hash`);
    assert.equal(statusOf(c.flow, c.hash), 'ready', `${c.slug} status`);
    assert.ok(c.updatedAt < 10_000_000);
  }
});

test('the sample workspace never comes back once the list is stored, even empty', () => {
  saveConnectors([]);
  assert.deepEqual(loadConnectors(), []);
});

test('a viewer cannot change a decision, so a ready connector stays ready', () => {
  const ready = atCode(started());
  const viewing = play(ready, { type: 'set', patch: { role: 'Viewer' } }, changeDecision);
  assert.deepEqual(viewing.decisions, ready.decisions);
  assert.equal(saved(viewing)[0].status, 'ready');
});
