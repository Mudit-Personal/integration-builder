import { hashManifest } from '../../src/hash.ts';
import { applyDecisions } from './decisions.ts';
import type { AppPack } from './pack.ts';
import { CHECKS, SOURCE, type Flow } from './state.ts';

export type CheckResult = { hash: string; passed: number; failed: number };

export type SavedConnector = {
  id: string; slug: string; name: string;
  status: 'draft' | 'ready'; step: number; hash: string; updatedAt: number;
  flow: Pick<Flow, 'maxStep' | 'url' | 'live' | 'audience' | 'decisions' | 'answers' | 'result' | 'codeReached'>;
};

export const statusOf = (f: Pick<Flow, 'result' | 'codeReached'>, hash: string): SavedConnector['status'] =>
  (f.codeReached && f.result?.failed === 0 && f.result.hash === hash ? 'ready' : 'draft');

const toSaved = (f: Flow, name: string, hash: string, updatedAt: number): SavedConnector => ({
  id: f.id!, slug: f.slug, name,
  status: statusOf(f, hash), hash, updatedAt,
  // Check runs are not saved, so a reopened connector cannot land on Code without them.
  step: Math.min(f.step, CHECKS),
  flow: {
    maxStep: Math.min(f.maxStep, CHECKS), url: f.url, live: f.live, audience: f.audience, decisions: f.decisions,
    answers: f.answers, result: f.result, codeReached: f.codeReached,
  },
});

const hashOf = (f: Flow, pack: AppPack) => hashManifest(applyDecisions(pack.manifest, f.decisions));

/** True when the checks behind a saved status no longer cover this pack. */
export const isStale = (f: Flow, pack: AppPack) => statusOf(f, hashOf(f, pack)) === 'draft';

/** Returns the same list when nothing changed, so a reopened connector keeps its place and its time. */
export const upsert = (list: SavedConnector[], f: Flow, pack: AppPack, now: number): SavedConnector[] => {
  const prev = list.find(c => c.id === f.id);
  if (!prev && f.step === SOURCE) return list;
  const next = toSaved(f, pack.manifest.app.name, hashOf(f, pack), now);
  if (prev && JSON.stringify({ ...prev, updatedAt: now }) === JSON.stringify(next)) return list;
  return [next, ...list.filter(c => c.id !== f.id)];
};

// The workspace's reads, loaded with its connectors. A new read is saved to the server with its connector.
const packs = new Map<string, AppPack>();

export const holdPacks = (held: Record<string, AppPack>) => {
  packs.clear();
  Object.entries(held).forEach(([id, pack]) => packs.set(id, pack));
};
export const readPack = (id: string) => packs.get(id) ?? null;
export const savePack = (id: string, pack: AppPack) => { packs.set(id, pack); };
export const dropPack = (id: string) => { packs.delete(id); };

export const packLost = (c: SavedConnector) => !!c.flow.live && readPack(c.id)?.hash !== c.flow.live.hash;
