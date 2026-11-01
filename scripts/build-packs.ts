import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ingest } from '../src/ingest.ts';
import { Manifest } from '../src/manifest.ts';
import { assemblePack, type AppPack } from '../src/pack-build.ts';
import { registrableDomain, verifyManifest, type Finding } from '../src/verify.ts';
import type { AppEntry } from '../web/src/pack.ts';

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync('web/public/packs', { recursive: true });
  mkdirSync('web/src/generated', { recursive: true });
  const entries: AppEntry[] = [];
  for (const file of readdirSync('corpus/manifests').sort()) {
    const { pack, entry } = await buildPack(file);
    writeFileSync(`web/public/packs/${entry.slug}.json`, JSON.stringify(pack));
    entries.push(entry);
    const blocks = pack.findings?.filter(f => f.severity === 'block') ?? [];
    console.log(`${entry.slug}: ${pack.endpoints.length} endpoints, ${pack.findings?.length ?? 'no spec,'} findings, ${blocks.length} blocking`);
    for (const f of blocks) console.log(`  BLOCK ${f.code} ${f.where}: ${f.message}`);
  }
  writeFileSync('web/src/generated/apps.json', `${JSON.stringify(entries, null, 2)}\n`);
}
