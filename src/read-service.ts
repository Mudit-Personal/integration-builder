import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { generateManifest } from './generate.ts';
import { ingest, IngestError } from './ingest.ts';
import { LlmStopped, type Llm } from './llm.ts';
import { assemblePack, type AppPack } from './pack-build.ts';
import { isBlocked, type Finding } from './verify.ts';

export type ReadDeps = { llm: Llm | null; accessCode: string | undefined; deadlineMs?: number };
export type ReadEvent = { type: 'progress'; message: string } | { type: 'done'; pack: AppPack } | { type: 'failed'; code: string; message: string };

const MAX_BODY = 2_000_000;
// Under Vercel's 300s limit, so the reader gets a clean failure instead of a cut stream.
const DEADLINE_MS = 285_000;
const HEARTBEAT_MS = 15_000;

const json = (res: ServerResponse, status: number, error: string) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
};

/** Resolves null past the limit. It reads to the end, because a client still sending can't receive the 413. */
export const readBody = (req: IncomingMessage, max = MAX_BODY) => new Promise<string | null>((resolve, reject) => {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size <= max) chunks.push(c);
  });
  req.on('end', () => resolve(size > max ? null : Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const digest = (s: string) => createHash('sha256').update(s).digest();
const sameCode = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

const parse = (raw: string): { url?: string; text?: string; code?: unknown } | null => {
  try {
    const body = JSON.parse(raw);
    const ok = body && typeof body === 'object' && ['url', 'text'].every(k => body[k] === undefined || typeof body[k] === 'string');
    return ok ? body : null;
  } catch {
    return null;
  }
};

const firstBlock = (findings: Finding[]) => findings.find(f => f.severity === 'block')?.message ?? 'No details.';

const failure = (e: unknown, timedOut: boolean): ReadEvent => {
  if (e instanceof IngestError) {
    return { type: 'failed', code: e.code, message: e.code === 'unreachable' ? `We couldn't open that page: ${e.message}. You can paste the docs text instead.` : e.message };
  }
  if (e instanceof LlmStopped) return { type: 'failed', code: e.code, message: e.message };
  if (timedOut) return { type: 'failed', code: 'timeout', message: 'This took longer than the time limit. Try again, or paste only the authentication, users and pagination pages.' };
  // The name only. Messages from a model call can carry docs text.
  console.error('read failed', (e as Error).name);
  return { type: 'failed', code: 'error', message: 'Something went wrong while reading these docs. Try again in a minute.' };
};

export const handleRead = async (req: IncomingMessage, res: ServerResponse, { llm, accessCode, deadlineMs = DEADLINE_MS }: ReadDeps) => {
  if (req.method !== 'POST') return json(res, 405, 'Use POST.');
  if (!llm || !accessCode) return json(res, 503, 'Live reading is not set up on this server.');
  // JSON only forces a preflight, so a page in another origin cannot post here.
  if (!String(req.headers['content-type']).includes('application/json')) return json(res, 415, 'Send JSON.');
  const raw = await readBody(req);
  if (raw === null) return json(res, 413, 'That is over the 2 MB limit.');
  const body = parse(raw);
  if (!body) return json(res, 400, 'That request could not be read.');
  if (typeof body.code !== 'string' || !sameCode(body.code, accessCode)) return json(res, 401, 'That access code is not right.');

  const gone = new AbortController();
  res.on('close', () => gone.abort());
  const deadline = AbortSignal.timeout(deadlineMs);
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  const emit = (event: ReadEvent) => res.write(`${JSON.stringify(event)}\n`);
  const progress = (message: string) => emit({ type: 'progress', message });
  // Model calls run for minutes in silence, and idle connections get closed. Readers skip blank lines.
  const heartbeat = setInterval(() => res.write('\n'), HEARTBEAT_MS);
  try {
    const source = await ingest({ url: body.url, text: body.text }, progress);
    const out = await generateManifest(source, llm, progress, { maxAttempts: 2, signal: AbortSignal.any([gone.signal, deadline]) });
    if (!out.manifest) {
      emit({ type: 'failed', code: 'unusable', message: "The AI couldn't produce a valid connector from these docs. Pasting the authentication, users and pagination pages may help." });
    } else if (isBlocked(out.findings)) {
      emit({ type: 'failed', code: 'blocked', message: `The result didn't pass its checks against the docs. ${firstBlock(out.findings)}` });
    } else {
      const sum = (key: 'inputTokens' | 'outputTokens' | 'ms') => out.attempts.reduce((n, a) => n + a.usage[key], 0);
      emit({
        type: 'done',
        pack: {
          ...assemblePack(out.manifest, source, body.url ?? '', out.findings),
          read: { source: source.kind, attempts: out.attempts.length, inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), ms: sum('ms') },
        },
      });
    }
  } catch (e) {
    emit(failure(e, deadline.aborted));
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
};
