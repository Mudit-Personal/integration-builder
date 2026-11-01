import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateManifest } from '../src/generate.ts';
import { ingest } from '../src/ingest.ts';
import { claudeCli, codexCli, openaiApi, type Llm } from '../src/llm.ts';
import { Manifest } from '../src/manifest.ts';
import { runSandbox, sandboxPassed } from '../src/scenarios.ts';
import { isBlocked } from '../src/verify.ts';
import type { TopApp } from './build-packs.ts';

// Reads the docs saved by read-batch for every app with an accepted manifest, with another model, and scores the result
// against the same sandbox. It never writes corpus/manifests, so the shipped connectors stay as they are.
// Usage: npm run demo:compare -- --model=<provider>:<model> [--set=dev|holdout] [--only=slack,github] [--workers=3]
// Tune prompts and checks on dev only. Holdout says whether a change generalises.
// Providers: codex:gpt-5.6-luna@max (local Codex sign-in, @ sets the effort), claude:haiku (local Claude sign-in), openai:<id> (OPENAI_API_KEY).

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const spec = arg('model');
if (!spec?.includes(':')) throw new Error('Pass --model=codex:<model>[@effort], claude:<alias> or openai:<model id>.');
const [provider, model] = [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)];
if (provider === 'openai' && !process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY.');
const [name, effort] = model.split('@');
const llm: Llm = provider === 'openai' ? openaiApi(model) : provider === 'codex' ? codexCli(name || undefined, effort) : claudeCli(model);
const only = arg('only')?.split(',');
const set = arg('set');
// Mixed on purpose: specs and docs, tenant hosts, OAuth, GraphQL-free REST, plan-gated usage.
const DEV = ['slack', 'okta', 'github', 'jira', 'calendly', 'asana', 'sentry', 'box', 'hubspot', 'zoom', 'gitlab', 'auth0'];
const inSet = (slug: string) => (only ? only.includes(slug) : set === 'dev' ? DEV.includes(slug) : set === 'holdout' ? !DEV.includes(slug) : true);

/** What a read must get right for the connector to reach the right people. Compared with the accepted manifest. */
const facts = (m: Manifest) => ({
  baseUrl: m.baseUrl, usersPath: `${m.users.request.method} ${m.users.request.path.replace(/\{\{[^}]+\}\}/g, '{}')}`, recordsPath: m.users.recordsPath,
  pagination: m.users.pagination.type, auth: m.authMethods.map(a => a.type).sort().join(','), usage: m.usage.kind,
});

const sourceFile = (slug: string) => [`corpus/specs/${slug}.json`, `corpus/specs/${slug}.yaml`, `corpus/docs/${slug}.txt`].find(existsSync);
const { apps } = JSON.parse(readFileSync('corpus/top50.json', 'utf8')) as { apps: TopApp[] };
const queue = apps.filter(a => existsSync(`corpus/manifests/${a.slug}.json`) && sourceFile(a.slug) && inSet(a.slug));

const CORE = ['baseUrl', 'usersPath', 'recordsPath', 'pagination'] as const;
type Row = {
  slug: string; status: 'passed' | 'blocked' | 'sandbox_failed' | 'error'; correct: boolean; attempts: number; ms: number;
  tokens: { input: number; output: number }; scenarios: { passed: number; failed: number }; matches: number; of: number; differs: string[]; reason: string;
};
const rows: Row[] = [];
const label = `${spec.replace(/[^a-z0-9.-]+/gi, '_')}${set ? `.${set}` : ''}`;
const out = `corpus/evals/${label}.json`;
// Every attempt's blocking findings and the last manifest, so a failure can be read rather than guessed at.
const traces = `corpus/evals/${label}`;
mkdirSync(traces, { recursive: true });

const one = async (app: TopApp): Promise<Row> => {
  const row: Row = { slug: app.slug, status: 'error', correct: false, attempts: 0, ms: 0, tokens: { input: 0, output: 0 }, scenarios: { passed: 0, failed: 0 }, matches: 0, of: 0, differs: [], reason: '' };
  const started = Date.now();
  try {
    const source = await ingest({ text: readFileSync(sourceFile(app.slug)!, 'utf8'), url: app.docsUrl });
    const res = await generateManifest(source, llm, () => {}, { maxAttempts: 3, signal: AbortSignal.timeout(600_000) });
    row.attempts = res.attempts.length;
    writeFileSync(`${traces}/${app.slug}.json`, `${JSON.stringify({ attempts: res.attempts.map(a => ({ attempt: a.attempt, blocks: a.findings.filter(f => f.severity === 'block') })), last: res.attempts.at(-1)?.output }, null, 2)}\n`);
    for (const a of res.attempts) { row.tokens.input += a.usage.inputTokens; row.tokens.output += a.usage.outputTokens; }
    if (!res.manifest || isBlocked(res.findings)) {
      row.status = 'blocked';
      row.reason = res.findings.filter(f => f.severity === 'block').slice(0, 3).map(f => `${f.code} ${f.where}: ${f.message}`).join(' | ') || 'No manifest came back.';
      return row;
    }
    const results = await runSandbox(res.manifest);
    row.scenarios = { passed: results.filter(r => r.status === 'pass').length, failed: results.filter(r => r.status === 'fail').length };
    row.status = sandboxPassed(results) ? 'passed' : 'sandbox_failed';
    const want = facts(Manifest.parse(JSON.parse(readFileSync(`corpus/manifests/${app.slug}.json`, 'utf8'))));
    const got = facts(res.manifest);
    const keys = Object.keys(want) as (keyof typeof want)[];
    row.of = keys.length;
    row.differs = keys.filter(k => want[k] !== got[k]).map(k => `${k}: ${got[k]} (accepted: ${want[k]})`);
    row.matches = row.of - row.differs.length;
    // Auth and usage can differ and still be right. These four decide whether the right people come back.
    row.correct = row.status === 'passed' && CORE.every(k => want[k] === got[k]);
  } catch (e) {
    row.reason = (e as Error).message.slice(0, 300);
  } finally {
    row.ms = Date.now() - started;
  }
  return row;
};

const worker = async () => {
  for (let app = queue.shift(); app; app = queue.shift()) {
    const row = await one(app);
    rows.push(row);
    writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
    console.log(`${row.slug}: ${row.status}${row.correct ? ' correct' : ''} ${row.matches}/${row.of} facts ${row.scenarios.passed} checks passed ${row.attempts} attempts ${row.ms}ms ${row.differs.join('; ')} ${row.reason}`);
  }
};
await Promise.all(Array.from({ length: Number(arg('workers') ?? 3) }, worker));

const passed = rows.filter(r => r.status === 'passed');
const matched = rows.reduce((n, r) => n + r.matches, 0);
const total = rows.reduce((n, r) => n + r.of, 0);
const tokens = rows.reduce((n, r) => ({ input: n.input + r.tokens.input, output: n.output + r.tokens.output }), { input: 0, output: 0 });
console.log(`\n${spec}: ${rows.filter(r => r.correct).length}/${rows.length} correct, ${passed.length}/${rows.length} passed the sandbox. ${matched}/${total} key facts match the accepted manifests. ${tokens.input} input and ${tokens.output} output tokens. Written to ${out}.`);
