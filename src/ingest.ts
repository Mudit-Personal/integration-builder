import { assertPublicUrl, ConnectorError } from './runtime.ts';
import { parseStructured, specDigest, toApiSpec, type ApiSpec } from './spec.ts';
import type { Source } from './verify.ts';

export type IngestInput = { url?: string; text?: string };
export type Progress = (message: string) => void;

export class IngestError extends Error {
  code: 'bad_input' | 'unreachable' | 'needs_paste';
  constructor(code: IngestError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const MAX_BYTES = 30_000_000;
const MAX_DOC_PAGES = 14;
const MAX_DOC_CHARS = 110_000;
const MIN_USEFUL_CHARS = 800;
const WELL_KNOWN = ['/openapi.json', '/openapi.yaml', '/swagger.json', '/swagger.yaml', '/api-docs', '/v3/api-docs', '/api/openapi.json', '/docs/openapi.json'];
const DOC_KEYWORDS: [RegExp, number][] = [
  [/\b(users?|members?|people|accounts?|seats?|licen[cs]es?)\b/i, 5], [/\b(auth|authentication|authorization|oauth|tokens?|api.?keys?)\b/i, 5],
  [/\b(pagination|paging|rate.?limit|errors?)\b/i, 5], [/\b(audit|activity|usage|analytics|reports?|logs?)\b/i, 4],
  [/\b(getting.?started|introduction|overview|reference)\b/i, 1],
];
const INJECTION = /(ignore (all |any )?(previous|prior|above)|disregard (the|your|all)|system prompt|you are now|new instructions|\bact as (an? |the )?(ai|assistant|llm|model)\b|exfiltrate|send (the )?(token|credentials|api key) to)/i;

type Fetched = { text: string; contentType: string; url: URL };

const safeFetch = async (start: URL, accept = '*/*'): Promise<Fetched> => {
  let url = start;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(25_000), headers: { accept, 'user-agent': 'integration-builder/0.1' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new IngestError('unreachable', `${url.host} returned ${res.status}`);
    }
    let size = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.body ?? []) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new IngestError('bad_input', 'The document is over 30 MB');
      chunks.push(chunk);
    }
    return { text: Buffer.concat(chunks).toString('utf8'), contentType: res.headers.get('content-type') ?? '', url };
  }
  throw new IngestError('unreachable', 'Too many redirects');
};

/** A linear scan, because a lazy regex here goes quadratic on hostile pages and this server has one thread. */
const stripBlocks = (html: string) => {
  const lower = html.toLowerCase();
  const open = /<(script|style|noscript|svg|nav|footer|header)\b/gi;
  let out = '';
  let at = 0;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    out += `${html.slice(at, m.index)} `;
    const close = lower.indexOf(`</${m[1].toLowerCase()}>`, m.index);
    if (close < 0) return out;
    at = open.lastIndex = close + m[1].length + 3;
  }
  return out + html.slice(at);
};

export const htmlToText = (html: string) => stripBlocks(html)
  .replace(/<\/(p|div|h\d|li|tr|pre|section)>/gi, '\n')
  .replace(/<[^<>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

export const specLinksIn = (text: string, base: URL): URL[] => {
  const found = new Set<string>();
  const add = (raw: string) => { try { found.add(new URL(raw, base).toString()); } catch { /* not a URL */ } };
  for (const token of text.split(/["'()\s<>]+/)) {
    const spec = /^.*?\.(?:json|ya?ml)\b/i.exec(token)?.[0];
    if (spec && /openapi|swagger|api-docs|api-spec/i.test(spec)) add(spec);
  }
  for (const m of text.matchAll(/(?:spec-url|data-url|specUrl|spec_url)\s*[=:]\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of text.matchAll(/<a\b[^<>]*href=["']([^"']+\.(?:json|ya?ml))["']/gi)) add(m[1]);
  return [...found].map(u => new URL(u)).filter(u => u.protocol === 'https:');
};

const asSpec = (text: string) => {
  const spec = toApiSpec(parseStructured(text));
  return spec && spec.operations.length ? spec : null;
};

const scoreLink = (href: string, label: string) => DOC_KEYWORDS.reduce((sum, [re, w]) => sum + (re.test(`${label} ${href.replace(/[-_/]/g, ' ')}`) ? w : 0), 0);

const docLinks = (body: string, base: URL) => {
  const links = new Map<string, number>();
  const push = (raw: string, label: string) => {
    try {
      const url = new URL(raw, base);
      url.hash = '';
      if (url.origin === base.origin && !/\.(png|jpe?g|svg|css|js|ico|woff2?)$/i.test(url.pathname)) {
        links.set(url.toString(), Math.max(links.get(url.toString()) ?? 0, scoreLink(url.pathname, label)));
      }
    } catch { /* not a URL */ }
  };
  for (const m of body.matchAll(/<a\b[^<>]*href=["']([^"'#]+)["'][^<>]*>([\s\S]{0,120}?)<\/a>/gi)) push(m[1], m[2].replace(/<[^>]+>/g, ' '));
  for (const m of body.matchAll(/\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)/g)) push(m[2], m[1]);
  return [...links].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([u]) => new URL(u));
};

const sourceFromSpec = (spec: ApiSpec, raw: string, origin: string | null): Source => {
  const promptText = specDigest(spec);
  return { kind: 'spec', origin, spec, promptText, corpus: `${raw}\n${promptText}`, warnings: INJECTION.test(raw) ? ['The API description contains text that looks like instructions to an AI. It was treated as data, but review this connector closely.'] : [] };
};

const sourceFromDocs = (text: string, origin: string | null): Source => ({
  kind: 'docs', origin, spec: null, promptText: text.slice(0, MAX_DOC_CHARS), corpus: text,
  warnings: INJECTION.test(text) ? ['The documentation contains text that looks like instructions to an AI. It was treated as data, but review this connector closely.'] : [],
});

const trySpecUrls = async (urls: URL[], progress: Progress, depth = 0): Promise<{ spec: ApiSpec; raw: string; url: URL } | null> => {
  let best: { spec: ApiSpec; raw: string; url: URL } | null = null;
  const others: ApiSpec[] = [];
  const keep = (next: { spec: ApiSpec; raw: string; url: URL }) => {
    if (best && best.spec.operations.length >= next.spec.operations.length) others.push(next.spec);
    else {
      if (best) others.push(best.spec);
      best = next;
    }
  };
  for (const url of urls.slice(0, 8)) {
    const page = await safeFetch(url, 'application/json, application/yaml, */*').catch(() => null);
    if (!page) continue;
    const spec = asSpec(page.text);
    if (spec) {
      progress(`Found ${spec.format} spec at ${url.pathname} with ${spec.operations.length} operations`);
      keep({ spec, raw: page.text, url });
    } else if (depth === 0) {
      // Some sites serve an HTML index at /openapi.json that links to the real files.
      const nested = await trySpecUrls(specLinksIn(page.text, page.url), progress, depth + 1);
      if (nested) keep(nested);
    }
  }
  // Vendors often split auth into its own spec, as Calendly does for OAuth.
  const chosen = best as { spec: ApiSpec; raw: string; url: URL } | null;
  if (chosen) {
    const known = new Set(chosen.spec.authSchemes.map(a => JSON.stringify(a)));
    chosen.spec.authSchemes.push(...others.flatMap(o => o.authSchemes).filter(a => !known.has(JSON.stringify(a))));
  }
  return chosen;
};

export const ingest = async (input: IngestInput, progress: Progress = () => {}): Promise<Source> => {
  if (input.text?.trim()) {
    const text = input.text.trim();
    const spec = asSpec(text);
    progress(spec ? `Read pasted ${spec.format} spec with ${spec.operations.length} operations` : `Read ${text.length} characters of pasted docs`);
    if (spec) return sourceFromSpec(spec, text, input.url ?? null);
    if (text.length < MIN_USEFUL_CHARS) throw new IngestError('needs_paste', 'That is too little to work from. Paste the authentication, users and pagination pages.');
    return sourceFromDocs(text, input.url ?? null);
  }
  let start: URL;
  try {
    start = new URL(input.url ?? '');
  } catch {
    throw new IngestError('bad_input', 'Enter a full docs URL, or paste the docs.');
  }
  progress(`Fetching ${start.host}`);
  const entry = await safeFetch(start).catch((e: unknown) => {
    if (e instanceof IngestError) throw e;
    if (e instanceof ConnectorError && e.kind === 'safety') throw new IngestError('bad_input', e.message);
    throw new IngestError('unreachable', `Could not reach ${start.host}`);
  });
  const direct = asSpec(entry.text);
  if (direct) {
    progress(`That URL is a ${direct.format} spec with ${direct.operations.length} operations`);
    return sourceFromSpec(direct, entry.text, start.toString());
  }

  progress('Looking for a machine-readable spec behind the docs');
  const llms = await safeFetch(new URL('/llms.txt', start.origin)).catch(() => null);
  const llmsText = llms && !/^\s*</.test(llms.text) ? llms.text : '';
  const candidates = [
    ...specLinksIn(entry.text, entry.url), ...specLinksIn(llmsText, new URL(start.origin)),
    ...WELL_KNOWN.map(p => new URL(p, start.origin)),
  ];
  const unique = [...new Map(candidates.map(u => [u.toString(), u])).values()];
  const found = await trySpecUrls(unique, progress);
  if (found) return sourceFromSpec(found.spec, found.raw, start.toString());

  progress('No spec found, reading the docs pages');
  const pages = [htmlToText(entry.text)];
  const seen = new Set([entry.url.toString()]);
  const queue = docLinks(`${entry.text}\n${llmsText}`, entry.url);
  for (const url of queue.slice(0, MAX_DOC_PAGES * 2)) {
    if (pages.length >= MAX_DOC_PAGES || pages.join('').length > MAX_DOC_CHARS) break;
    if (seen.has(url.toString())) continue;
    seen.add(url.toString());
    const page = await safeFetch(url).catch(() => null);
    if (page) pages.push(`\n[Page: ${url.pathname}]\n${/html/i.test(page.contentType) ? htmlToText(page.text) : page.text}`);
  }
  const text = pages.join('\n');
  progress(`Read ${pages.length} docs pages, ${text.length} characters`);
  if (text.length < MIN_USEFUL_CHARS) {
    throw new IngestError('needs_paste', 'This site renders its docs in the browser, so nothing readable came back. Paste the authentication, users and pagination pages instead.');
  }
  return sourceFromDocs(text, start.toString());
};
