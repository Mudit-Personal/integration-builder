import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashManifest } from '../src/hash.ts';
import { dropPack, packLost, savePack, upsert, type SavedConnector } from '../web/src/connectors.ts';
import { applyDecisions, DEFAULT_DECISIONS } from '../web/src/decisions.ts';
import type { AppPack } from '../web/src/pack.ts';
import type { Audience } from '../web/src/journey.ts';
import { CHECKS, CODE, DECIDE, initial, READ, reducer, type Action, type Flow } from '../web/src/state.ts';
import { AUTHS, makeManifest, PAGINATIONS } from './fixtures.ts';

const manifest = makeManifest(Object.values(PAGINATIONS)[0], Object.values(AUTHS)[0]);
const pack: AppPack = { manifest, hash: hashManifest(manifest), docsUrl: '', findings: null, readSteps: [], endpoints: [] };
const hash = hashManifest(applyDecisions(manifest, DEFAULT_DECISIONS));

const play = (flow: Flow, ...actions: Action[]) => actions.reduce(reducer, flow);
const started = (id = 'a', audience: Audience = 'developer') => ({ ...play(initial(), { type: 'new', id, audience }), slug: 'acme' });
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


test('a connector saved before every deliverable had a switch opens with the rest turned on', () => {
  const [c] = saved(atCode(started()));
  const old = { ...c, flow: { ...c.flow, decisions: { ...c.flow.decisions, deliverables: { usage: false, caching: true } as never } } };
  const opened = reducer(initial(), { type: 'open', saved: old, lost: false });
  assert.deepEqual(opened.decisions.deliverables, { ...DEFAULT_DECISIONS.deliverables, usage: false, caching: true });
});

test('a connector saved with the old Not a developer label opens in the business journey', () => {
  const [c] = saved(atRead(started()));
  const old = { ...c, flow: { ...c.flow, audience: 'Not a developer' as never } };
  assert.equal(reducer(initial(), { type: 'open', saved: old, lost: false }).audience, 'business');
  assert.equal(reducer(initial(), { type: 'open', saved: { ...c, flow: { ...c.flow, audience: 'Developer' as never } }, lost: false }).audience, 'developer');
});

test('a finished read lands on Decisions for business and stays on Read for developers', () => {
  const read = (audience: Audience) => play(started('a', audience), { type: 'read-start', url: 'https://x.test' }, { type: 'read-done', pack });
  assert.deepEqual([read('business').step, read('business').maxStep], [DECIDE, DECIDE]);
  assert.deepEqual([read('developer').step, read('developer').maxStep], [READ, READ]);
});

test('a new connector starts in the journey it is given', () => {
  assert.equal(started('a', 'business').audience, 'business');
  assert.equal(started('a').audience, 'developer');
});

test('switching to business puts the deliverables it hides back on their defaults', () => {
  const custom = play(started(), { type: 'decide', patch: { deliverables: { ...DEFAULT_DECISIONS.deliverables, logging: false, usage: false } } });
  const switched = reducer(custom, { type: 'audience', audience: 'business' });
  assert.deepEqual(switched.decisions.deliverables, { ...DEFAULT_DECISIONS.deliverables, usage: false });
  assert.equal(reducer(started(), { type: 'audience', audience: 'business' }).decisions, started().decisions);
});
