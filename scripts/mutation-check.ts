import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const MUTATIONS: [string, string, string, string?][] = [
  ['host allowlist removed', "if (!ctx.allowedHosts.has(url.host) && url.origin !== ctx.opts.sandboxOrigin) {", 'if (false) {'],
  ['partial marked complete', "status: failure ? (result.users.length ? 'partial' : 'failed') : sink.truncated ? 'partial' : 'complete',", "status: failure && !result.users.length ? 'failed' : 'complete',"],
  ['retries unbounded by wait', 'if (wait > ctx.limits.maxRetryWaitMs) throw', 'if (false) throw'],
  ['loop detection removed', "if (records.length && seenPages.has(pageHash)) throw", 'if (false) throw'],
  ['cursor loop check removed', "if (seenCursors.has(cursorKey)) throw", 'if (false) throw'],
  ['secret scrubbing removed', "ctx.secrets.reduce((acc, s) => (s.length >= 4 ? acc.replace(new RegExp(s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'), 'gi'), '[redacted]') : acc), text)", 'text'],
  ['short page ends walk', 'if (count === 0 || more === false || (Number.isFinite(total)', 'if (count < p.pageSize || more === false || (Number.isFinite(total)'],
  ['dedupe removed', 'const users = [...byId.values()];', "const users = raw.map((_, i) => [...byId.values()][i % byId.size]).filter(Boolean);"],
  ['id drift ignored', 'quality.droppedNoId / sink.records.length > MAX_DROPPED_ID_SHARE', 'false'],
  ['zero users reconciles', "if (count === 0) return", 'if (false) return'],
  ['count drop reconciles', 'if (previous && count < previous * 0.5) return', 'if (false) return'],
  ['size ceiling removed', 'if (size > cap) throw', 'if (false) throw'],
  ['usage gate fails users', "if (error.kind === 'plan_gated') return", 'if (false) return'],
  ['early stop goes unnoticed', "if (linkNext(page.headers.get('link')) || vendorSaysMore(page.json, name === 'users' ? sink.records.length : null)) {", 'if (false) {'],
  ['rows with no id reconcile', 'if (quality.droppedNoId) return', 'if (false) return'],
  ['duplicates reconcile', 'if (quality.duplicatesRemoved / rawRows > MAX_DUPLICATE_SHARE) return', 'if (false) return'],
  ['inactive ignores usage', "usage.status === 'complete' ? { allowed: true", 'true ? { allowed: true'],
  ['tunnelled IPv6 allowed', "(family === 'ipv6' && !GLOBAL_UNICAST.check(ip, 'ipv6'))", 'false'],
  ['write intent unchecked at runtime', 'if (write) throw', 'if (false) throw'],
  ['run errors not scrubbed', 'message: scrub(ctx, err.message)', 'message: err.message'],
  ['base URL may carry a query', 'if (base.search || base.hash || base.username || base.password) throw', 'if (false) throw'],
  ['rate limit can sleep for hours', 'if (at + wait - ctx.started > ctx.limits.maxRunMs) throw', 'if (false) throw'],
  ['generated header can close its comment', "header.replaceAll('*/', '* /')", 'header', 'src/connector-source.ts'],
  ['disguised host passes the verifier', 'if (parsed.search || parsed.hash || parsed.username || parsed.password) return add', 'if (false) return add', 'src/verify.ts'],
  ['write intent unchecked by the verifier', 'if (write) add', 'if (false) add', 'src/verify.ts'],
];

const dir = mkdtempSync(join(tmpdir(), 'mutants-'));
for (const d of ['src', 'test']) cpSync(join(root, d), join(dir, d), { recursive: true });
symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
cpSync(join(root, 'package.json'), join(dir, 'package.json'));

let survived = 0;
for (const [name, from, to, file = 'src/runtime.ts'] of MUTATIONS) {
  const target = join(dir, file);
  const original = readFileSync(target, 'utf8');
  if (!original.includes(from)) throw new Error(`Mutation target not found: ${name}`);
  writeFileSync(target, original.replace(from, to));
  const run = spawnSync('node', ['--no-warnings', '--test', 'test/runtime.test.ts', 'test/review.test.ts'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
  const killed = run.status !== 0;
  if (!killed) survived++;
  console.log(`${killed ? 'killed  ' : 'SURVIVED'} ${name}`);
  writeFileSync(target, original);
}
rmSync(dir, { recursive: true, force: true });
console.log(`${MUTATIONS.length - survived}/${MUTATIONS.length} mutants killed`);
process.exit(survived ? 1 : 0);
