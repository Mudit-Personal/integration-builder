import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateManifest } from '../src/generate.ts';
import { ingest } from '../src/ingest.ts';
import { claudeCli, type Llm } from '../src/llm.ts';
import { Manifest } from '../src/manifest.ts';
import { runSandbox, sandboxPassed } from '../src/scenarios.ts';
import { isBlocked } from '../src/verify.ts';
import type { TopApp } from './build-packs.ts';

type Status = 'passed' | 'blocked' | 'sandbox_failed' | 'unreadable' | 'timeout';
export type Outcome = {
  slug: string; name: string; docsUrl: string; readUrl: string; status: Status;
  sourceKind: 'spec' | 'docs' | null; sourceChars: number; attempts: number; tokens: { input: number; output: number }; ms: number;
  scenarios: { passed: number; failed: number; skipped: number }; usageKind: string | null; reason: string;
};

const REPORT = 'corpus/top50-report.json';
const CONCURRENCY = 3;
const APP_TIMEOUT_MS = 360_000;
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 900_000;
const MAX_BACKOFFS = 12;

export const isRateLimit = (message: string) => /rate.?limit|\b429\b|overloaded|usage limit|hit your .*limit|session limit/i.test(message);

/** An attempted app is settled unless its latest outcome has a status the caller asked to retry. */
export const pending = (apps: TopApp[], report: Outcome[], retry: string[]) => apps.filter(app => {
  const last = report.findLast(r => r.slug === app.slug);
  return !last || retry.includes(last.status);
});

/** The first URL this app was not unreadable from. Once all have failed, the first again. */
export const nextUrl = (app: TopApp, report: Outcome[]) => {
  const urls = [...(app.readUrls ?? []), app.docsUrl];
  return urls.find(u => !report.some(r => r.slug === app.slug && r.status === 'unreadable' && r.readUrl === u)) ?? urls[0];
};

const blank = (app: TopApp, readUrl: string): Outcome => ({
  slug: app.slug, name: app.name, docsUrl: app.docsUrl, readUrl, status: 'unreadable', sourceKind: null, sourceChars: 0, attempts: 0,
  tokens: { input: 0, output: 0 }, ms: 0, scenarios: { passed: 0, failed: 0, skipped: 0 }, usageKind: null, reason: '',
});

const sandbox = async (m: Manifest, out: Outcome) => {
  const results = await runSandbox(m);
  const count = (s: string) => results.filter(r => r.status === s).length;
  out.scenarios = { passed: count('pass'), failed: count('fail'), skipped: count('skipped') };
  return results;
};

/** Writes source files first and generates from the reloaded text, so build-packs reruns verification on exactly what the model saw. */
const read = async (app: TopApp, out: Outcome, llm: Llm, signal: AbortSignal) => {
  const found = await ingest({ url: out.readUrl });
  const raw = found.kind === 'spec' ? found.corpus.slice(0, -found.promptText.length - 1) : found.corpus;
  const path = found.kind === 'spec' ? `corpus/specs/${app.slug}.${raw.trimStart().startsWith('{') ? 'json' : 'yaml'}` : `corpus/docs/${app.slug}.txt`;
  writeFileSync(path, raw);
  const source = await ingest({ text: raw, url: app.docsUrl });
  out.sourceKind = source.kind;
  out.sourceChars = raw.length;
  const { manifest, findings } = await generateManifest(source, llm, () => {}, { maxAttempts: 3, signal });
  out.usageKind = manifest?.usage.kind ?? null;
  const blocks = findings.filter(f => f.severity === 'block');
  if (!manifest || isBlocked(findings)) {
    out.status = 'blocked';
    out.reason = blocks.slice(0, 3).map(f => `${f.code} ${f.where}: ${f.message}`).join(' | ').slice(0, 500) || 'No manifest came back.';
    return;
  }
  // shortcut: lives here, not in verifyManifest, so live reads are unchanged. A manifest with no users quote can be all placeholders.
  if (!manifest.evidence.some(e => e.claim === 'users')) {
    out.status = 'blocked';
    out.reason = 'No quote from the source supports the users endpoint.';
    return;
  }
  const results = await sandbox(manifest, out);
  if (!sandboxPassed(results)) {
    out.status = 'sandbox_failed';
    out.reason = results.filter(r => r.status === 'fail').map(r => `${r.id}: ${r.detail}`).join(' | ').slice(0, 500);
    return;
  }
  writeFileSync(`corpus/manifests/${app.slug}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  out.status = 'passed';
  out.reason = `${findings.filter(f => f.severity === 'review').length} findings to review`;
};

class RateLimited extends Error {}

const attempt = async (app: TopApp, readUrl: string, llm: Llm): Promise<Outcome> => {
  const out = blank(app, readUrl);
  const counted: Llm = async req => {
    const res = await llm(req);
    out.attempts++;
    out.tokens.input += res.usage.inputTokens;
    out.tokens.output += res.usage.outputTokens;
    return res;
  };
  const started = Date.now();
  const stop = new AbortController();
  let timer!: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { stop.abort(); reject(new Error('timed out')); }, APP_TIMEOUT_MS);
  });
  try {
    await Promise.race([read(app, out, counted, stop.signal), deadline]);
  } catch (e) {
    const message = (e as Error).message;
    if (isRateLimit(message)) throw new RateLimited(message);
    out.status = /timed out/.test(message) ? 'timeout' : 'unreadable';
    out.reason = message.slice(0, 500);
  } finally {
    clearTimeout(timer);
  }
  out.ms = Date.now() - started;
  return out;
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const run = async () => {
  const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',');
  const retry = process.argv.find(a => a.startsWith('--retry='))?.slice(8).split(',') ?? [];
  const { apps } = JSON.parse(readFileSync('corpus/top50.json', 'utf8')) as { apps: TopApp[] };
  const report: Outcome[] = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : [];
  const record = (out: Outcome) => {
    report.push(out);
    writeFileSync(`${REPORT}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
    renameSync(`${REPORT}.tmp`, REPORT);
    console.log(`${out.slug}: ${out.status} ${out.sourceKind ?? '-'} ${out.attempts} attempts ${out.ms}ms ${out.scenarios.passed}/${out.scenarios.failed}/${out.scenarios.skipped} ${out.reason.slice(0, 160)}`);
  };
  mkdirSync('corpus/docs', { recursive: true });

  const queue = pending(apps, report, retry).filter(a => !only || only.includes(a.slug));
  const llm = claudeCli(undefined, 300_000);
  let backoffs = 0;
  let resumeAt = 0;
  const worker = async () => {
    for (let app = queue.shift(); app; app = queue.shift()) {
      for (;;) {
        if (Date.now() < resumeAt) await sleep(resumeAt - Date.now());
        const manifestPath = `corpus/manifests/${app.slug}.json`;
        if (existsSync(manifestPath) && !report.some(r => r.slug === app!.slug)) {
          const out = blank(app, app.docsUrl);
          const started = Date.now();
          const results = await sandbox(Manifest.parse(JSON.parse(readFileSync(manifestPath, 'utf8'))), out);
          out.status = sandboxPassed(results) ? 'passed' : 'sandbox_failed';
          out.reason = 'Existing manifest. Sandbox rerun, no new model call.';
          out.ms = Date.now() - started;
          out.sourceKind = existsSync(`corpus/specs/${app.slug}.json`) || existsSync(`corpus/specs/${app.slug}.yaml`) ? 'spec' : 'docs';
          out.usageKind = (JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest).usage.kind;
          record(out);
          break;
        }
        try {
          record(await attempt(app, nextUrl(app, report), llm));
          backoffs = 0;
          break;
        } catch (e) {
          if (!(e instanceof RateLimited)) throw e;
          if (++backoffs > MAX_BACKOFFS) throw new Error(`Still rate limited after ${MAX_BACKOFFS} waits. Rerun to resume. ${e.message}`);
          const wait = Math.min(BACKOFF_START_MS * 2 ** (backoffs - 1), BACKOFF_MAX_MS);
          resumeAt = Date.now() + wait;
          console.log(`${app.slug}: rate limited, waiting ${wait / 1000}s (${backoffs}/${MAX_BACKOFFS}) ${e.message.slice(0, 160)}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await run();
