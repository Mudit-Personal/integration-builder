import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { LlmStopped, llmFromEnv, openaiApi } from '../src/llm.ts';

let seen: { body: Record<string, any>; auth: string | undefined };
let reply: { status: number; body: object };

const server = createServer(async (req, res) => {
  let text = '';
  for await (const c of req) text += c;
  seen = { body: JSON.parse(text), auth: req.headers.authorization };
  res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
});

before(async () => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const call = () => openaiApi('some-model', 'sk-test')({ system: 'sys', prompt: 'prompt', schema: { $schema: 'draft', type: 'object', properties: {} } });
const answer = (content: string | null, extra: object = {}) => ({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content }, ...extra }], usage: { prompt_tokens: 1200, completion_tokens: 300 } } });

test('sends the schema as a non-strict JSON schema and reads the JSON answer', async () => {
  reply = answer('{"app":"x"}');
  const { output, usage } = await call();
  assert.deepEqual(output, { app: 'x' });
  assert.equal(usage.inputTokens, 1200);
  assert.equal(usage.outputTokens, 300);
  assert.equal(seen.auth, 'Bearer sk-test');
  assert.equal(seen.body.model, 'some-model');
  assert.deepEqual(seen.body.messages.map((m: { role: string }) => m.role), ['system', 'user']);
  assert.deepEqual(seen.body.response_format.json_schema, { name: 'manifest', schema: { type: 'object', properties: {} }, strict: false });
});

test('unparsable JSON comes back as null so the repair loop asks again', async () => {
  reply = answer('{"app":');
  assert.equal((await call()).output, null);
});

test('a refusal and a cut-off answer stop the read with a plain reason', async () => {
  reply = { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'no' } }] } };
  await assert.rejects(call(), (e: unknown) => e instanceof LlmStopped && e.code === 'refused');
  reply = { status: 200, body: { choices: [{ finish_reason: 'length', message: { content: '{' } }] } };
  await assert.rejects(call(), (e: unknown) => e instanceof LlmStopped && e.code === 'too_long');
});

test('an API error keeps its status so rate limits are retried', async () => {
  reply = { status: 429, body: { error: { message: 'Rate limit reached' } } };
  await assert.rejects(call(), /OpenAI 429: Rate limit reached/);
});

test('an upstream error sent with status 200, or wrapped in an array, still fails the call', async () => {
  reply = { status: 200, body: { error: { message: 'Upstream error from Nvidia', code: 400 } } };
  await assert.rejects(call(), /OpenAI 400: Upstream error from Nvidia/);
  reply = { status: 503, body: [{ error: { code: 503, message: 'high demand' } }] };
  await assert.rejects(call(), /OpenAI 503: high demand/);
});

test('propertyNames and format are dropped from the schema because some providers reject them', async () => {
  reply = answer('{}');
  const schema = { type: 'object', properties: { format: { enum: ['iso8601'] } }, additionalProperties: { type: 'string', format: 'starts_with', pattern: '^/' }, propertyNames: { type: 'string' } };
  await openaiApi('some-model', 'sk-test')({ system: 's', prompt: 'p', schema });
  assert.deepEqual(seen.body.response_format.json_schema.schema, { type: 'object', properties: { format: { enum: ['iso8601'] } }, additionalProperties: { type: 'string', pattern: '^/' } });
});

test('OpenAI is used only when both its key and model are set', () => {
  const saved = { ...process.env };
  delete process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test';
  delete process.env.OPENAI_MODEL;
  assert.equal(llmFromEnv(), null);
  process.env.OPENAI_MODEL = 'some-model';
  assert.equal(typeof llmFromEnv(), 'function');
  process.env = saved;
});
