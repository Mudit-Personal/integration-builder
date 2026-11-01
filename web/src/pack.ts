import type { AppPack } from '../../src/pack-build.ts';

export type { AppPack, Endpoint, ReadStep, Sensitivity } from '../../src/pack-build.ts';

export type AppEntry = { slug: string; name: string; docsUrl: string; host: string; domains: string[]; logo: string | null };

export const matchApp = (apps: AppEntry[], url: string): AppEntry | null => {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return apps.find(a => a.domains.some(d => host === d || host.endsWith(`.${d}`))) ?? null;
};

const loaded = new Map<string, Promise<AppPack>>();

export const loadPack = (slug: string) => {
  const pack = loaded.get(slug) ?? fetch(`./packs/${slug}.json`).then(r => {
    if (!r.ok) throw new Error(`Pack ${slug} returned ${r.status}`);
    return r.json() as Promise<AppPack>;
  });
  loaded.set(slug, pack);
  return pack;
};
