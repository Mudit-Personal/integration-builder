import { credentialFields, type Manifest } from './manifest.ts';
import type { Limits } from './runtime.ts';

/** What a person decided on top of the manifest. Limits and logging are not manifest fields, so they travel in the generated code. */
export type ConnectorSettings = {
  limits: Partial<Limits>; logLevel: 'debug' | 'info' | 'warn' | 'off'; cacheTtlMs: number;
  approvedPaths: string[]; blockedPaths: string[];
  /** The caller's fetch signs requests, so the connector sends no credentials. */
  skipAuth: boolean;
  exports: { users: boolean; usage: boolean };
};

const settingsCode = (s: ConnectorSettings) => {
  const { limits, logLevel, cacheTtlMs } = s;
  const pass = `const LOG_RANK = { debug: 0, info: 1, warn: 2, error: 3, off: 4 };
const settings = ${JSON.stringify({ limits, logLevel, cacheTtlMs })};

const withSettings = (options: RunOptions): RunOptions => ({
  ...options,${s.skipAuth ? '\n  skipAuth: true,' : ''}
  limits: { ...settings.limits, ...options.limits },
  log: options.log && (e => { if (LOG_RANK[e.level] >= LOG_RANK[settings.logLevel as keyof typeof LOG_RANK]) options.log!(e); }),
});
`;
  return cacheTtlMs ? `${pass}
// In memory, per credential. Only complete runs are kept, so a failure is never replayed.
const cache = new Map<string, { at: number; result: RunResult }>();

const run = async (options: RunOptions): Promise<RunResult> => {
  const key = JSON.stringify([options.credentials, options.connection]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < settings.cacheTtlMs) return hit.result;
  const result = await runConnector(manifest, withSettings(options));
  if (result.streams.users.status === 'complete') cache.set(key, { at: Date.now(), result });
  return result;
};
` : `${pass}
const run = (options: RunOptions) => runConnector(manifest, withSettings(options));
`;
};

const settingsHeader = (s: ConnectorSettings) => `
 * Retries      ${s.limits.maxRetries ?? 'default'} after the first attempt
 * Log level    ${s.logLevel === 'off' ? 'off, no events' : s.logLevel}
 * Cache        ${s.cacheTtlMs ? `${s.cacheTtlMs / 60_000} min, in memory` : 'off'}
 * Approved     ${s.approvedPaths.join(', ') || 'none'}
 * Blocked      ${s.blockedPaths.join(', ') || 'none'}`;

export const describePagination = (m: Manifest) => {
  const p = m.users.pagination;
  return {
    none: 'none, one request returns everything',
    cursor: p.type === 'cursor' ? `cursor, reads ${p.cursorPath} and sends it as ?${p.cursorParam}=` : '',
    next_url: p.type === 'next_url' ? `next link in ${p.urlPath}, followed only on the API host` : '',
    link_header: 'Link response header, followed only on the API host',
    offset: p.type === 'offset' ? `offset ?${p.offsetParam}= and ?${p.limitParam}=` : '',
    page_number: p.type === 'page_number' ? `page number ?${p.pageParam}=` : '',
  }[p.type];
};

const authSummary = (m: Manifest) => m.authMethods.map((a, i) => {
  const fields = credentialFields(a).map(f => f.name).join(', ');
  return ` *   ${i}: ${a.label} (${a.type}), needs ${fields}`;
}).join('\n');

export const connectorSource = (m: Manifest, hash: string, settings?: ConnectorSettings) => {
  const name = m.app.slug.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
  const usage = m.usage.kind === 'unavailable' ? `unavailable, ${m.usage.reason}`
    : m.usage.kind === 'last_activity_field' ? 'read from the user record'
    : `${m.usage.kind}, ${m.usage.request.method} ${m.usage.request.path}${m.usage.planRequirement ? `, needs ${m.usage.planRequirement}` : ''}`;
  const header = `/**
 * ${m.app.name} connector. Generated from manifest ${hash}. Do not edit by hand.
 * Regenerate from the manifest so the tests, approval and audit trail stay valid.
 *
 * API client   ${m.baseUrl}, read only, this host only
 * Auth setup${settings?.skipAuth ? '   left out, pass a fetch that signs every request' : `\n${authSummary(m)}`}
 * Users        ${m.users.request.method} ${m.users.request.path}${settings && !settings.exports.users ? ', read for usage only' : ''}
 * Usage        ${usage}
 * Pagination   ${describePagination(m)}
 * Rate limits  ${m.rateLimit.maxRequestsPerMinute ? `${m.rateLimit.maxRequestsPerMinute} requests a minute, ` : ''}Retry-After honoured, exponential backoff with jitter
 * Errors       classified by ERROR_POLICY in runtime.ts, partial runs are reported as partial
 * Logging      structured events through options.log, secrets redacted${settings ? settingsHeader(settings) : ''}`;
  // Every value above came from the model, so none of them may close the comment and become code.
  return `${header.replaceAll('*/', '* /')}
 */
import { readFileSync } from 'node:fs';
import { runConnector, type RunOptions, type RunResult } from './runtime.ts';
import type { Manifest } from './manifest.ts';

const manifest: Manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));

${settings ? settingsCode(settings) : 'const run = (options: RunOptions) => runConnector(manifest, options);\n'}
export const run${name}Sync = (options: RunOptions): Promise<RunResult> => run(options);

${!settings || settings.exports.users ? `export const get${name}Users = async (options: RunOptions) => {
  const result = await run(options);
  if (result.streams.users.status === 'failed') {
    const error = result.streams.users.error ?? result.streams.context.error;
    throw new Error(\`\${error?.kind}: \${error?.message}. \${error?.action}\`);
  }
  return { users: result.users, complete: result.streams.users.status === 'complete', reconcile: result.reconcile };
};
` : ''}${!settings || settings.exports.usage ? `
export const get${name}Usage = async (options: RunOptions) => {
  const result = await run(options);
  return { usage: result.usage, status: result.streams.usage.status, note: result.streams.usage.note ?? result.streams.usage.error?.action };
};
` : ''}`;
};

export const bundleFrom = (m: Manifest, hash: string, sources: { runtime: string; manifest: string }, settings?: ConnectorSettings) => ({
  [`${m.app.slug}.connector.ts`]: connectorSource(m, hash, settings),
  'manifest.json': JSON.stringify(m, null, 2),
  'runtime.ts': sources.runtime,
  'manifest.ts': sources.manifest,
});
