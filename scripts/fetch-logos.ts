import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { TopApp } from './build-packs.ts';

// Full-color marks from SVGL (MIT) first, then Simple Icons (CC0) glyphs filled with the brand's own hex.
const DIR = 'web/public/apps';
const FILE = 'corpus/top50.json';
const SI = 'https://cdn.jsdelivr.net/npm/simple-icons@latest';
const SI_ALIAS: Record<string, string> = { monday: 'mondaydotcom', 'google-workspace': 'google' };
// SVGL files these under their parent brand.
const SVGL_ALIAS: Record<string, string> = { 'microsoft-365': 'Microsoft', sendgrid: 'Twilio' };

type SvglEntry = { title: string; route: string | { light: string; dark: string } };
type SiEntry = { title: string; hex: string; slug?: string };

const siSlug = (title: string) => title.toLowerCase().replace(/\+/g, 'plus').replace(/\./g, 'dot').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

const get = async (url: string) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  return r.ok ? r.text() : null;
};

const fromSvgl = async (app: TopApp) => {
  const name = SVGL_ALIAS[app.slug] ?? app.name;
  const body = await get(`https://api.svgl.app?search=${encodeURIComponent(name.split(' ')[0])}`);
  if (!body?.startsWith('[')) return null;
  const hit = (JSON.parse(body) as SvglEntry[]).find(e => [name, app.slug].some(n => siSlug(e.title.trim()) === siSlug(n)));
  if (!hit) return null;
  return get(typeof hit.route === 'string' ? hit.route : hit.route.light);
};

const fromSimpleIcons = async (app: TopApp, data: SiEntry[]) => {
  const slug = SI_ALIAS[app.slug] ?? app.slug.replace(/-/g, '');
  const svg = await get(`${SI}/icons/${slug}.svg`);
  const hex = data.find(e => (e.slug ?? siSlug(e.title)) === slug)?.hex;
  return svg && hex ? svg.replace('<svg ', `<svg fill="#${hex}" `) : null;
};

const doc = JSON.parse(readFileSync(FILE, 'utf8')) as { apps: TopApp[] };
const data = JSON.parse((await get(`${SI}/data/simple-icons.json`)) ?? '[]') as SiEntry[];
const missed: string[] = [];
for (const app of doc.apps) {
  if (app.logo && existsSync(`${DIR}/${app.logo}`)) continue;
  if (existsSync(`${DIR}/${app.slug}.png`)) {
    app.logo = `${app.slug}.png`;
    continue;
  }
  const svg = (await fromSvgl(app)) ?? (await fromSimpleIcons(app, data));
  if (!svg?.includes('<svg')) {
    missed.push(app.slug);
    continue;
  }
  writeFileSync(`${DIR}/${app.slug}.svg`, svg);
  app.logo = `${app.slug}.svg`;
}
writeFileSync(FILE, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`${doc.apps.filter(a => a.logo).length} of ${doc.apps.length} apps have a logo. Missed: ${missed.join(', ') || 'none'}`);
