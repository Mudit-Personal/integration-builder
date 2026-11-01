import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { claudeApi, LlmStopped } from '../src/llm.ts';

type Seen = { body: Record<string, any>; beta: string | undefined };
let seen: Seen;
let reply: { stop: string; toolInput: string | null };

const sse = (events: object[]) => events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const stream = () => {
  const usage = { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 };
  const blocks = reply.toolInput === null
    ? [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }]
    : [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'write_manifest', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: reply.toolInput } }];
  return sse([
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage } },
    ...blocks, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reply.stop, stop_sequence: null }, usage: { output_tokens: 2000 } },
    { type: 'message_stop' },
  ]);
};

const read = async (req: IncomingMessage) => {
  let text = '';
  for await (const c of req) text += c;
  return JSON.parse(text);
};

const server = createServer(async (req, res) => {
  seen = { body: await read(req), beta: req.headers['anthropic-beta'] as string | undefined };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(stream());
});

before(async () => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = 'test';
});
after(() => server.close());

const call = () => claudeApi()({ system: 'sys', prompt: 'prompt', schema: { $schema: 'draft', type: 'object', properties: {} } });

test('sends the agreed request and reads the tool input', async () => {
  reply = { stop: 'tool_use', toolInput: '{"app":"x"}' };
  const { output, usage } = await call();
  assert.deepEqual(output, { app: 'x' });
  assert.equal(usage.inputTokens, 1500);
  assert.equal(usage.outputTokens, 2000);
  assert.ok(Math.abs(usage.costUsd - 0.046) < 1e-9);
  const b = seen.body;
  assert.equal(b.model, 'claude-opus-5-5');
  assert.equal(b.max_tokens, 64000);
  assert.equal(b.stream, true);
  assert.deepEqual(b.output_config, { effort: 'high' });
  assert.equal(b.fallbacks, 'default');
  assert.match(seen.beta!, /server-side-fallback-2026-07-01/);
  assert.deepEqual(b.tool_choice, { type: 'auto' });
  assert.equal(b.tools[0].strict, undefined);
  assert.equal(b.tools[0].input_schema.$schema, undefined);
  assert.match(b.system, /write_manifest/);
});

test('a refusal or a cut-off turn stops instead of reading partial input', async () => {
  reply = { stop: 'refusal', toolInput: '{"app":"x"}' };
  await assert.rejects(call(), (e: LlmStopped) => e.code === 'refused');
  reply = { stop: 'max_tokens', toolInput: '{"app":"x"}' };
  await assert.rejects(call(), (e: LlmStopped) => e.code === 'too_long');
});

test('an answer with no tool call gives null, so the repair loop retries', async () => {
  reply = { stop: 'end_turn', toolInput: null };
  assert.equal((await call()).output, null);
});
