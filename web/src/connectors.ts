import seed from './generated/seed.json' with { type: 'json' };
import { hashManifest } from '../../src/hash.ts';
import { applyDecisions } from './decisions.ts';
import type { AppPack } from './pack.ts';
import { APPS, CHECKS, initial, SOURCE, type Flow } from './state.ts';

export type CheckResult = { hash: string; passed: number; failed: number };

export type SavedConnector = {
  id: string; slug: string; name: string;
  status: 'draft' | 'ready'; step: number; hash: string; updatedAt: number;
  flow: Pick<Flow, 'maxStep' | 'url' | 'live' | 'audience' | 'decisions' | 'answers' | 'requests' | 'result' | 'codeReached'>;
};

/** Written by scripts/build-packs.ts, which runs the checks behind every ready one. */
export type SeedConnector = Omit<SavedConnector, 'id' | 'updatedAt'> & { minutesAgo: number };

const KEY = 'ib-connectors';
const ROLE_KEY = 'ib-role';
// Packs get their own keys: a full browser then costs one read, not the autosave of every connector.
const packKey = (id: string) => `ib-connector-pack:${id}`;
const OLD_FLOW = 'ibv2';
const OLD_PACK = 'ibv2-pack';

const read = <T>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
};

const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

const drop = (key: string) => {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing stored to clear.
  }
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
    answers: f.answers, requests: f.requests, result: f.result, codeReached: f.codeReached,
  },
});

/** Returns the same list when nothing changed, so a reopened connector keeps its place and its time. */
export const upsert = (list: SavedConnector[], f: Flow, pack: AppPack, now: number): SavedConnector[] => {
  const prev = list.find(c => c.id === f.id);
  if (!prev && f.step === SOURCE) return list;
  const next = toSaved(f, pack.manifest.app.name, hashManifest(applyDecisions(pack.manifest, f.decisions)), now);
  if (prev && JSON.stringify({ ...prev, updatedAt: now }) === JSON.stringify(next)) return list;
  return [next, ...list.filter(c => c.id !== f.id)];
};

const migrate = (): SavedConnector[] => {
  const old = read<Partial<Flow>>(OLD_FLOW);
  const pack = read<AppPack>(OLD_PACK);
  const app = APPS.find(a => a.slug === old?.slug);
  const name = old?.live ? (pack?.hash === old.live.hash ? pack.manifest.app.name : null) : app?.name;
  const list: SavedConnector[] = [];
  if (old && name && (old.step ?? SOURCE) > SOURCE) {
    const id = crypto.randomUUID();
    if (old.live) {
      // Free the old copy first, so the new copy always fits.
      drop(OLD_PACK);
      savePack(id, pack!);
    }
    list.push(toSaved({ ...initial(), ...old, id }, name, '', Date.now()));
  }
  // Left in place on failure, so the next visit tries again.
  if (write(KEY, list)) [OLD_FLOW, OLD_PACK].forEach(drop);
  return list;
};

const stored = (key: string) => {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return true;
  }
};

const sample = (now: number): SavedConnector[] => (seed as SeedConnector[]).map(({ minutesAgo, ...c }) => ({ ...c, id: crypto.randomUUID(), updatedAt: now - minutesAgo * 60_000 }));

/** A first visit opens on the sample workspace. Once anything is stored, even an empty list, it never comes back. */
export const loadConnectors = (now = Date.now()): SavedConnector[] => {
  if (!stored(KEY) && !stored(OLD_FLOW)) return sample(now);
  const list = read<SavedConnector[]>(KEY);
  return Array.isArray(list) ? list.filter(c => c?.id && c.flow) : migrate();
};

export const saveConnectors = (list: SavedConnector[]) => write(KEY, list);

// Memory first, so a read still works when the browser refuses storage.
const packs = new Map<string, AppPack>();

export const readPack = (id: string) => packs.get(id) ?? read<AppPack>(packKey(id));

export const savePack = (id: string, pack: AppPack) => {
  packs.set(id, pack);
  return write(packKey(id), pack);
};

export const dropPack = (id: string) => {
  packs.delete(id);
  drop(packKey(id));
};

export const packLost = (c: SavedConnector) => !!c.flow.live && readPack(c.id)?.hash !== c.flow.live.hash;

const ROLES: Flow['role'][] = ['Viewer', 'Builder', 'Admin'];
export const loadRole = (): Flow['role'] => ROLES.find(r => r === read(ROLE_KEY)) ?? 'Builder';
export const saveRole = (role: Flow['role']) => write(ROLE_KEY, role);
