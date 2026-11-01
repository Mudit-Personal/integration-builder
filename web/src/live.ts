import type { ReadEvent } from '../../src/read-service.ts';
import type { AppPack } from './pack.ts';

export type LiveRead =
  | { kind: 'idle' }
  | { kind: 'reading'; messages: string[] }
  | { kind: 'paste'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'denied'; message: string };

export type ReadOutcome = { kind: 'done'; pack: AppPack } | { kind: 'denied' | 'failed' | 'paste'; message: string };

export const hostFrom = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

const outcomeOf = (e: Extract<ReadEvent, { type: 'done' | 'failed' }>): ReadOutcome => {
  if (e.type === 'done') return { kind: 'done', pack: e.pack };
  return { kind: e.code === 'needs_paste' || e.code === 'unreachable' ? 'paste' : 'failed', message: e.message };
};

export const readDocs = async (input: { url: string; text?: string; code: string }, onProgress: (message: string) => void, signal: AbortSignal): Promise<ReadOutcome> => {
  const res = await fetch('./api/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal });
  if (!res.ok || !res.body) {
    const message = await res.json().then((b: { error?: string }) => b.error, () => undefined) ?? "Live reading isn't available right now.";
    return { kind: res.status === 401 ? 'denied' : 'failed', message };
  }
  let rest = '';
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line) as ReadEvent;
      if (event.type === 'progress') onProgress(event.message);
      else return outcomeOf(event);
    }
  }
  return { kind: 'failed', message: 'The read stopped before it finished. Try again, or paste only the authentication, users and pagination pages.' };
};
