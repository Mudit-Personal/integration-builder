import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ingest } from '../src/ingest.ts';
import { Manifest } from '../src/manifest.ts';
import { assemblePack, type AppPack } from '../src/pack-build.ts';
import { registrableDomain, verifyManifest, type Finding } from '../src/verify.ts';
import { hashManifest } from '../src/hash.ts';
import { startVirtualMock } from '../src/mock-virtual.ts';
import { runScenarioOn, SCENARIOS } from '../src/scenario-table.ts';
import { staticChecks } from '../web/src/checks.ts';
import type { SeedConnector } from '../web/src/connectors.ts';
import { applyDecisions, decisionRows, DEFAULT_DECISIONS, runtimeLimits, type Decisions } from '../web/src/decisions.ts';
import type { AppEntry } from '../web/src/pack.ts';
import { CHECKS, DECIDE, type Flow } from '../web/src/state.ts';

export type TopApp = { slug: string; name: string; docsUrl: string; why: string; readUrls?: string[]; logo?: string };

const { apps } = JSON.parse(readFileSync('corpus/top50.json', 'utf8')) as { apps: TopApp[] };

/** The saved text a manifest was read from, or null for older docs-only reads whose pages were not kept. */
const savedSource = (key: string) => [`corpus/specs/${key}.json`, `corpus/specs/${key}.yaml`, `corpus/docs/${key}.txt`].find(existsSync) ?? null;

// The Calendly manifest was read from the docs site, but the corpus keeps only its OpenAPI file, so this quote can't be rechecked.
const recheckable = (slug: string, f: Finding): Finding => (slug === 'calendly' && f.code === 'quote_not_found'
  ? { ...f, severity: 'review', message: `${f.message} It came from the docs site, which isn't stored here.` } : f);

const hostOf = (m: Manifest) => m.baseUrl.replace(/^https:\/\//, '').split('/')[0];

export const buildPack = async (file: string): Promise<{ pack: AppPack; entry: AppEntry }> => {
  const key = file.replace(/\.json$/, '');
  const app = apps.find(a => a.slug === key);
  if (!app) throw new Error(`${file} has no row in corpus/top50.json`);
  const manifest = Manifest.parse(JSON.parse(readFileSync(`corpus/manifests/${file}`, 'utf8')));
  const saved = savedSource(key);
  const source = saved ? await ingest({ text: readFileSync(saved, 'utf8'), url: app.docsUrl }) : null;
  const host = hostOf(manifest);
  const domains = [...new Set([new URL(app.docsUrl).hostname, host.replace(/^\{\w+\}\./, '')].map(registrableDomain))];
  return {
    pack: assemblePack(manifest, source, app.docsUrl, source ? verifyManifest(manifest, source).map(f => recheckable(manifest.app.slug, f)) : null),
    entry: { slug: manifest.app.slug, name: manifest.app.name, docsUrl: app.docsUrl, host, domains, logo: app.logo ?? null },
  };
};

// The sample workspace a first visit opens on. Ready ones really pass their checks, run here.
type SeedRow = { slug: string; at: number; ready: boolean; minutesAgo: number };
const SEED: SeedRow[] = [
  { slug: 'jira-cloud', at: DECIDE, ready: false, minutesAgo: 12 },
  { slug: 'slack', at: CHECKS, ready: true, minutesAgo: 50 },
  { slug: 'zoom', at: CHECKS, ready: false, minutesAgo: 190 },
  { slug: 'okta', at: CHECKS, ready: true, minutesAgo: 60 * 26 },
  { slug: 'github', at: CHECKS, ready: true, minutesAgo: 60 * 24 * 3 },
];

const recommended = (pack: AppPack) => {
  let d: Decisions = DEFAULT_DECISIONS;
  const answers: Flow['answers'] = {};
  const next = () => decisionRows(pack, d).find(r => r.question && !answers[r.question.id])?.question;
  for (let q = next(); q; q = next()) {
    d = { ...d, ...q.patch(q.recommended) };
    answers[q.id] = 'recommended';
  }
  return { d, answers };
};

export const seedConnector = async (pack: AppPack, entry: AppEntry, { at, ready, minutesAgo }: SeedRow): Promise<SeedConnector> => {
  const { d, answers } = ready ? recommended(pack) : { d: DEFAULT_DECISIONS, answers: {} };
  const m = applyDecisions(pack.manifest, d);
  const hash = hashManifest(m);
  let result: Flow['result'] = null;
  if (ready) {
    const runs = await Promise.all(SCENARIOS.map(s => runScenarioOn(startVirtualMock, m, s, runtimeLimits(d))));
    const all = [...runs.map(r => r.status), ...staticChecks(pack, m, d).map(c => c.status)];
    result = { hash, passed: all.filter(x => x === 'pass').length, failed: all.filter(x => x === 'fail').length };
    if (result.failed) throw new Error(`${entry.slug} is seeded as ready but fails ${result.failed} checks`);
  }
  return {
    slug: entry.slug, name: entry.name, status: ready ? 'ready' : 'draft', step: at, hash, minutesAgo,
    flow: { maxStep: at, url: entry.docsUrl, live: null, audience: 'Developer', decisions: d, answers, requests: {}, result, codeReached: ready },
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const built = new Map<string, { pack: AppPack; entry: AppEntry }>();
  mkdirSync('web/public/packs', { recursive: true });
  mkdirSync('web/src/generated', { recursive: true });
  const entries: AppEntry[] = [];
  for (const file of readdirSync('corpus/manifests').sort()) {
    const { pack, entry } = await buildPack(file);
    built.set(entry.slug, { pack, entry });
    writeFileSync(`web/public/packs/${entry.slug}.json`, JSON.stringify(pack));
    entries.push(entry);
    const blocks = pack.findings?.filter(f => f.severity === 'block') ?? [];
    console.log(`${entry.slug}: ${pack.endpoints.length} endpoints, ${pack.findings?.length ?? 'no spec,'} findings, ${blocks.length} blocking`);
    for (const f of blocks) console.log(`  BLOCK ${f.code} ${f.where}: ${f.message}`);
  }
  writeFileSync('web/src/generated/apps.json', `${JSON.stringify(entries, null, 2)}\n`);
  const seed = await Promise.all(SEED.map(row => {
    const b = built.get(row.slug);
    if (!b) throw new Error(`The sample workspace names ${row.slug}, which has no pack`);
    return seedConnector(b.pack, b.entry, row);
  }));
  writeFileSync('web/src/generated/seed.json', `${JSON.stringify(seed, null, 2)}\n`);
  console.log(`sample workspace: ${seed.map(c => `${c.slug} ${c.status}${c.flow.result ? ` ${c.flow.result.passed} passed` : ''}`).join(', ')}`);
}
