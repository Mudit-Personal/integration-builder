import Anthropic from '@anthropic-ai/sdk';
import { tmpdir } from 'node:os';

export type LlmRequest = { system: string; prompt: string; schema: object; signal?: AbortSignal };
export type LlmResult = { output: unknown; usage: { inputTokens: number; outputTokens: number; costUsd: number; ms: number; model: string } };
export type Llm = (req: LlmRequest) => Promise<LlmResult>;

export const DEFAULT_MODEL = process.env.BUILDER_MODEL ?? 'sonnet';

/**
 * Dev-only adapter over the local Claude CLI. Tools, MCP and settings are off, so a prompt injected
 * through vendor docs has nothing to act with. Hosted reads use claudeApi below.
 */
export const claudeCli = (model = DEFAULT_MODEL, timeoutMs = 300_000): Llm => async req => {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn('claude', [
      '-p', '--model', model, '--output-format', 'json', '--json-schema', JSON.stringify(req.schema),
      '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--system-prompt', req.system,
    ], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Model call timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out);
        if (parsed.is_error || parsed.structured_output === undefined) throw new Error(String(parsed.result ?? 'no structured output'));
        resolve({
          output: parsed.structured_output,
          usage: {
            inputTokens: (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.cache_read_input_tokens ?? 0) + (parsed.usage?.cache_creation_input_tokens ?? 0),
            outputTokens: parsed.usage?.output_tokens ?? 0, costUsd: parsed.total_cost_usd ?? 0, ms: Date.now() - started, model,
          },
        });
      } catch (e) {
        reject(new Error(`Model call failed (exit ${code}): ${(e as Error).message} ${err.slice(0, 300)}`));
      }
    });
    req.signal?.addEventListener('abort', () => child.kill());
    child.stdin.end(req.prompt);
  });
};

// Tools an injected prompt could use. Codex has no flag to turn every tool off at once.
const CODEX_OFF = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use', 'in_app_browser', 'image_generation', 'multi_agent', 'hooks'];

/**
 * Dev-only adapter over the local Codex CLI and its ChatGPT sign-in. Read-only sandbox in an empty temp dir, no user config.
 * The schema goes in the prompt: --output-schema is OpenAI strict mode, which rejects the manifest's oneOf. Zod and the repair loop validate.
 */
export const codexCli = (model = process.env.CODEX_MODEL, timeoutMs = 600_000): Llm => async req => {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'codex-read-'));
  const started = Date.now();
  try {
    const { out, err, code } = await new Promise<{ out: string; err: string; code: number | null }>((resolve, reject) => {
      const child = spawn('codex', [
        'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '-C', dir,
        '-o', join(dir, 'out.json'), ...CODEX_OFF.flatMap(f => ['--disable', f]),
        ...(model ? ['-m', model] : []), '-',
      ], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Model call timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
      let out = '';
      let err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => { clearTimeout(timer); resolve({ out, err, code }); });
      req.signal?.addEventListener('abort', () => child.kill());
      child.stdin.end(`${req.system}\n\nDo not run commands. Answer with one JSON object, no prose, matching this JSON Schema:\n${JSON.stringify(req.schema)}\n\n${req.prompt}`);
    });
    const events = out.split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
    const usage = events.findLast(e => e.type === 'turn.completed')?.usage ?? {};
    const failure = events.findLast(e => e.type === 'error' || e.type === 'turn.failed');
    const text = await readFile(join(dir, 'out.json'), 'utf8').catch(() => null);
    if (failure || text === null) throw new Error(`Model call failed (exit ${code}): ${JSON.stringify(failure ?? '').slice(0, 500)} ${err.slice(-300)}`);
    let output: unknown = null; // Not JSON. The repair loop asks again.
    try {
      output = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    } catch {}
    return { output, usage: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, costUsd: 0, ms: Date.now() - started, model: model ?? 'codex' } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** The model stopped without an answer. The message is written for the person who asked for the read. */
export class LlmStopped extends Error {
  code: 'refused' | 'too_long';
  constructor(code: LlmStopped['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const API_MODEL = 'claude-opus-5-5';
const TOOL = 'write_manifest';
const USD_PER_MTOK = { input: 4, output: 20 };

/**
 * Messages API adapter. The manifest schema has records, and strict tools need additionalProperties false on every object,
 * so this uses a plain tool with auto choice, the only choice Opus 5.5 accepts. Zod and the repair loop in generate.ts validate.
 */
export const claudeApi = (model = API_MODEL): Llm => {
  const client = new Anthropic();
  return async req => {
    const started = Date.now();
    const { $schema: _draft, ...schema } = req.schema as Anthropic.Tool.InputSchema & { $schema?: string };
    const stream = client.beta.messages.stream({
      model, max_tokens: 64000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'high' },
      system: `${req.system}\n\nDeliver the manifest by calling the ${TOOL} tool. Do not answer in text.`,
      tools: [{ name: TOOL, description: 'Submit the finished connector manifest.', input_schema: schema, eager_input_streaming: true }],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: req.prompt }],
    }, { signal: req.signal });
    const message = await stream.finalMessage().catch((e: unknown) => {
      if (e instanceof Anthropic.APIError) throw e;
      return null; // Eager tool input that never parsed. The repair loop asks again.
    });
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, ms: Date.now() - started, model };
    if (!message) return { output: null, usage };
    if (message.stop_reason === 'refusal') throw new LlmStopped('refused', 'The AI declined to read this content.');
    if (message.stop_reason === 'max_tokens') throw new LlmStopped('too_long', 'These docs produced more output than one read allows.');
    const u = message.usage;
    usage.inputTokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    usage.outputTokens = u.output_tokens;
    usage.costUsd = (usage.inputTokens * USD_PER_MTOK.input + usage.outputTokens * USD_PER_MTOK.output) / 1_000_000;
    // auto does not guarantee a call. Null fails schema review, so the next attempt starts over.
    const call = message.content.find(b => b.type === 'tool_use' && b.name === TOOL);
    return { output: call?.type === 'tool_use' ? call.input : null, usage };
  };
};
