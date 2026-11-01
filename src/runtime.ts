import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { normalizePath, writeIntent } from './manifest.ts';
import type {
  ActiveUsageStream, AuthMethod, Field, Manifest, Pagination, RequestSpec, StreamConfig,
} from './manifest.ts';

export type ErrorKind =
  | 'auth' | 'forbidden' | 'plan_gated' | 'not_found' | 'rate_limited' | 'server'
  | 'network' | 'timeout' | 'contract' | 'safety' | 'budget' | 'config';

export const ERROR_POLICY: Record<ErrorKind, { retryable: boolean; action: string }> = {
  auth: { retryable: false, action: 'Check the credential, then reconnect.' },
  forbidden: { retryable: false, action: 'Grant the missing permission or scope, then retry.' },
  plan_gated: { retryable: false, action: 'This data needs a higher vendor plan. User sync can continue without it.' },
  not_found: { retryable: false, action: 'The endpoint may have moved. Regenerate the connector.' },
  rate_limited: { retryable: true, action: 'The vendor is throttling. Retry later or lower the sync frequency.' },
  server: { retryable: true, action: 'The vendor is failing. Retry later.' },
  network: { retryable: true, action: 'The vendor could not be reached. Retry later.' },
  timeout: { retryable: true, action: 'The vendor is too slow. Retry later.' },
  contract: { retryable: false, action: 'The response no longer matches the connector. Review and repair it.' },
  safety: { retryable: false, action: 'The run was stopped by a safety rule. Do not retry until reviewed.' },
  budget: { retryable: false, action: 'The run hit its request or record ceiling. Review the limits.' },
  config: { retryable: false, action: 'Fix the connection settings.' },
};

export class ConnectorError extends Error {
  kind: ErrorKind;
  status?: number;
  constructor(kind: ErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export const DEFAULT_LIMITS = {
  maxRequests: 2000, maxPages: 500, maxRecords: 200_000, maxRetries: 4,
  timeoutMs: 15_000, maxResponseBytes: 25_000_000, maxRetryWaitMs: 60_000, maxRunMs: 15 * 60_000,
  baseBackoffMs: 500, maxFanOutUsers: 200, usageWindowDays: 30, maxWindows: 12,
};
export type Limits = typeof DEFAULT_LIMITS;
export const PROBE_LIMITS: Partial<Limits> = {
  // Two pages, so the check proves pagination advances. The sandbox cannot prove that, because it follows the manifest.
  maxRequests: 14, maxPages: 2, maxRecords: 200, maxRetries: 1, maxFanOutUsers: 2, usageWindowDays: 1, maxWindows: 1, maxRetryWaitMs: 5000,
};

export type LogEvent = {
  ts: string; level: 'info' | 'warn' | 'error'; event: string; stream?: string;
  method?: string; url?: string; status?: number; ms?: number; attempt?: number; detail?: string;
};

export type RunOptions = {
  credentials: Record<string, string>;
  authMethodIndex?: number;
  connection?: Record<string, string>;
  /** Sandbox runs route every vendor origin to a local mock. It is the only way to reach http or loopback. */
  sandboxOrigin?: string;
  limits?: Partial<Limits>;
  log?: (e: LogEvent) => void;
  previousUserCount?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  skipDnsCheck?: boolean;
  /** Defaults to the global fetch. The hosted demo passes a virtual one, so no sandbox run touches the network. */
  fetch?: typeof fetch;
  /** The caller's fetch signs every request itself, so the runtime adds no credentials and fetches no tokens. */
  skipAuth?: boolean;
  /** Vendors that rotate refresh tokens invalidate the old one, so the caller must persist this or lose the connection. */
  onRefreshTokenRotated?: (token: string) => void;
};

export type NormalizedUser = {
  externalId: string; email: string | null; displayName: string | null;
  status: string; role: string | null; userType: string;
  lastActiveAt: string | null; createdAt: string | null;
};
export type NormalizedUsage = {
  userRef: string; userRefType: 'externalId' | 'email';
  occurredAt: string | null; metric: string; value: number | null;
};

export type StreamStatus = 'complete' | 'partial' | 'failed' | 'skipped' | 'unavailable';
export type StreamReport = {
  status: StreamStatus; records: number; pages: number; truncated: boolean;
  error?: { kind: ErrorKind; message: string; action: string };
  note?: string;
};
export type Quality = {
  emailCoverage: number; statusCoverage: number; lastActiveCoverage: number;
  duplicatesRemoved: number; droppedNoId: number; unmappedStatuses: string[];
  invalidEmails: number; invalidTimestamps: number;
};
export type RunResult = {
  users: NormalizedUser[]; usage: NormalizedUsage[];
  streams: { context: StreamReport; users: StreamReport; usage: StreamReport };
  quality: Quality;
  /** allowed: absent users may be treated as gone. inactive.allowed: no activity may be read as unused, which reclaiming a licence needs. */
  reconcile: { allowed: boolean; reason: string; inactive: { allowed: boolean; reason: string } };
  shapes: { users?: unknown; usage?: unknown };
  stats: { requests: number; retries: number; elapsedMs: number };
};

const SECRET_QUERY = /(key|token|secret|password|auth|signature|sig|code)$/i;
const SAFE_HOST_LABEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

export const getPath = (value: unknown, rawPath: string): unknown => {
  const path = normalizePath(rawPath);
  if (path === '$') return value;
  if (value === null || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (path in obj) return obj[path];
  // Longest key first, so vendor keys that contain dots, like "@odata.nextLink", resolve.
  for (let i = path.lastIndexOf('.'); i > 0; i = path.lastIndexOf('.', i - 1)) {
    const head = path.slice(0, i);
    if (head in obj) return getPath(obj[head], path.slice(i + 1));
  }
  return undefined;
};

const BLOCKED_ADDRESSES = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) {
  BLOCKED_ADDRESSES.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]] as const) BLOCKED_ADDRESSES.addSubnet(net, bits, 'ipv6');
const GLOBAL_UNICAST = new BlockList();
GLOBAL_UNICAST.addSubnet('2000::', 3, 'ipv6');

/** IPv6 is allow-listed, because mapped and tunnelled forms can hide any IPv4 address. */
const isPrivateAddress = (ip: string): boolean => {
  const family = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
  return BLOCKED_ADDRESSES.check(ip, family) || (family === 'ipv6' && !GLOBAL_UNICAST.check(ip, 'ipv6'));
};

/**
 * Rejects non-public destinations for a URL.
 * shortcut: checks DNS before connect, so a rebinding host can still race it. Pin the resolved IP in the production egress proxy.
 */
export const assertPublicUrl = async (url: URL, skipDns = false) => {
  if (url.protocol !== 'https:') throw new ConnectorError('safety', `Refused non-https URL ${url.protocol}//${url.hostname}`);
  if (url.username || url.password) throw new ConnectorError('safety', 'Refused URL with embedded credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new ConnectorError('safety', `Refused private address ${host}`);
    return;
  }
  if (/(^|\.)(localhost|local|internal|intranet|lan)$/i.test(host)) throw new ConnectorError('safety', `Refused internal host ${host}`);
  if (skipDns) return;
  const addresses = await lookup(host, { all: true }).catch(() => {
    throw new ConnectorError('network', `Could not resolve ${host}`);
  });
  if (addresses.some(a => isPrivateAddress(a.address))) throw new ConnectorError('safety', `Refused ${host}, it resolves to a private address`);
};

/** Fills {subdomain}-style host labels, on the base URL and on tenant token URLs alike. */
const fillHost = (template: string, connection: Record<string, string> = {}) => template.replace(/\{(\w+)\}/g, (_, name: string) => {
  const value = connection[name];
  if (!value) throw new ConnectorError('config', `Missing connection setting "${name}"`);
  // Fixed here, never taken from the manifest. A generated pattern could allow "evil.com#".
  if (!SAFE_HOST_LABEL.test(value)) throw new ConnectorError('safety', `"${name}" must be a single host label`);
  return value;
});

export const resolveBaseUrl = (m: Manifest, connection: Record<string, string> = {}): URL => {
  const url = fillHost(m.baseUrl, connection);
  const base = new URL(url.replace(/\/+$/, '') + '/');
  if (base.search || base.hash || base.username || base.password) throw new ConnectorError('safety', 'The base URL must not carry a query, fragment or login');
  return base;
};

const applyTemplate = (template: string, vars: Record<string, unknown>, encode: boolean): string =>
  template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, ref: string) => {
    const value = getPath(vars, ref);
    if (value === undefined || value === null) throw new ConnectorError('contract', `Template value "${ref}" is missing`);
    return encode ? encodeURIComponent(String(value)) : String(value);
  });

const toIso = (raw: unknown, format: Field['format']): string | null | undefined => {
  if (raw === null || raw === undefined || raw === '') return null;
  const ms = format === 'epoch_seconds' ? Number(raw) * 1000 : format === 'epoch_millis' ? Number(raw) : Date.parse(String(raw));
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : undefined;
};

const readField = (record: unknown, field: Field | null): unknown => {
  if (!field) return undefined;
  for (const path of [field.path, ...(field.fallbackPaths ?? [])]) {
    const value = getPath(record, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};

const asText = (value: unknown): string | null =>
  value === undefined || value === null || value === '' ? null : typeof value === 'object' ? JSON.stringify(value) : String(value);

/** Field names and types only. Values stay out, so this is safe to show or send to a model for repair. */
export const shapeOf = (value: unknown, depth = 0): unknown => {
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1)] : [];
  if (value && typeof value === 'object') {
    if (depth > 4) return 'object';
    return Object.fromEntries(Object.entries(value).slice(0, 60).map(([k, v]) => [k, shapeOf(v, depth + 1)]));
  }
  return value === null ? 'null' : typeof value;
};

type Ctx = {
  m: Manifest; opts: RunOptions; limits: Limits; auth: AuthMethod; base: URL; allowedHosts: Set<string>;
  secrets: string[]; log: (e: Omit<LogEvent, 'ts'>) => void; now: () => Date; sleep: (ms: number) => Promise<void>;
  started: number; requests: number; retries: number; accessToken?: string; refreshToken?: string; tokenExpiresAt?: number; nextSlot: number;
};

// Case-insensitive, because URL parsing lowercases a host that embeds a secret.
const scrub = (ctx: Pick<Ctx, 'secrets'>, text: string) =>
  ctx.secrets.reduce((acc, s) => (s.length >= 4 ? acc.replace(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[redacted]') : acc), text);

export const redactUrl = (raw: string, authParam?: string): string => {
  const url = new URL(raw);
  for (const key of [...url.searchParams.keys()]) if (SECRET_QUERY.test(key) || key === authParam) url.searchParams.set(key, '[redacted]');
  return url.toString();
};

const fetcher = (ctx: Ctx) => ctx.opts.fetch ?? fetch;

const toSandbox = (ctx: Ctx, url: URL): URL => {
  const origin = ctx.opts.sandboxOrigin;
  if (!origin || !ctx.allowedHosts.has(url.host)) return url;
  const mapped = new URL(url.pathname + url.search, origin);
  mapped.searchParams.set('__vendor_host', url.host);
  return mapped;
};

const guardDestination = async (ctx: Ctx, url: URL) => {
  if (!ctx.allowedHosts.has(url.host) && url.origin !== ctx.opts.sandboxOrigin) {
    throw new ConnectorError('safety', `Blocked request to undeclared host ${url.host}`);
  }
  if (!ctx.opts.sandboxOrigin) await assertPublicUrl(url, ctx.opts.skipDnsCheck);
};

const parseRetryAfter = (value: string | null, now: Date): number | null => {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now.getTime()) : null;
};

const parseReset = (ctx: Ctx, headers: Headers): number | null => {
  const { remainingHeader, resetHeader, resetFormat } = ctx.m.rateLimit;
  if (!remainingHeader || !resetHeader || !resetFormat) return null;
  if (headers.get(remainingHeader) !== '0') return null;
  const raw = Number(headers.get(resetHeader));
  if (!Number.isFinite(raw)) return null;
  if (resetFormat === 'delta_seconds') return raw * 1000;
  const at = resetFormat === 'epoch_seconds' ? raw * 1000 : raw;
  return Math.max(0, at - ctx.now().getTime());
};

const readCapped = async (res: Response, cap: number): Promise<string> => {
  const declared = Number(res.headers.get('content-length'));
  if (declared > cap) {
    await res.body?.cancel();
    throw new ConnectorError('budget', `Response of ${declared} bytes is over the ${cap} byte ceiling`);
  }
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > cap) throw new ConnectorError('budget', `Response is over the ${cap} byte ceiling`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const pace = async (ctx: Ctx) => {
  const rpm = ctx.m.rateLimit.maxRequestsPerMinute;
  if (!rpm) return;
  const at = Date.now();
  const wait = ctx.nextSlot - at;
  ctx.nextSlot = Math.max(at, ctx.nextSlot) + 60_000 / rpm;
  if (at + wait - ctx.started > ctx.limits.maxRunMs) throw new ConnectorError('budget', 'The rate limit would take this run past its time ceiling');
  if (wait > 0) await ctx.sleep(wait);
};

const postToken = async (ctx: Ctx, tokenUrl: string, form: Record<string, string>, basicAuth?: string) => {
  const url = toSandbox(ctx, new URL(fillHost(tokenUrl, ctx.opts.connection)));
  await guardDestination(ctx, url);
  ctx.requests++;
  const res = await fetcher(ctx)(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(ctx.limits.timeoutMs),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(basicAuth ? { authorization: basicAuth } : {}) },
    body: new URLSearchParams(form),
  }).catch(() => { throw new ConnectorError('network', 'Token endpoint could not be reached'); });
  const text = await readCapped(res, 1_000_000);
  ctx.log({ level: res.ok ? 'info' : 'error', event: 'token', method: 'POST', url: redactUrl(tokenUrl), status: res.status });
  if (!res.ok) throw new ConnectorError('auth', `Token request was rejected with ${res.status}`, res.status);
  let body: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    body = JSON.parse(text);
  } catch {
    throw new ConnectorError('auth', 'Token response was not JSON');
  }
  if (!body.access_token) throw new ConnectorError('auth', 'Token response had no access token');
  ctx.secrets.push(body.access_token);
  if (body.refresh_token) {
    ctx.secrets.push(body.refresh_token);
    ctx.refreshToken = body.refresh_token;
    ctx.opts.onRefreshTokenRotated?.(body.refresh_token);
  }
  ctx.accessToken = body.access_token;
  ctx.tokenExpiresAt = body.expires_in ? Date.now() + body.expires_in * 1000 : undefined;
  return body;
};

const ensureToken = async (ctx: Ctx, force = false) => {
  const { auth, opts: { credentials: c } } = ctx;
  if (ctx.opts.skipAuth) return false;
  if (auth.type === 'oauth2_authorization_code') {
    ctx.accessToken ??= c.accessToken;
    if (!force) return false;
    const refreshToken = ctx.refreshToken ?? c.refreshToken;
    if (!refreshToken) return false;
    await postToken(ctx, auth.tokenUrl, {
      grant_type: 'refresh_token', refresh_token: refreshToken,
      ...(c.clientId ? { client_id: c.clientId } : {}), ...(c.clientSecret ? { client_secret: c.clientSecret } : {}),
    });
    return true;
  }
  if (auth.type !== 'oauth2_client_credentials') return false;
  const expiring = ctx.tokenExpiresAt !== undefined && ctx.tokenExpiresAt - Date.now() < 30_000;
  if (ctx.accessToken && !force && !expiring) return false;
  const scope: Record<string, string> = auth.scopes.length ? { scope: auth.scopes.join(' ') } : {};
  if (auth.clientAuth === 'basic') {
    await postToken(ctx, auth.tokenUrl, { grant_type: 'client_credentials', ...scope },
      `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`);
  } else {
    await postToken(ctx, auth.tokenUrl, { grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret, ...scope });
  }
  return true;
};

const withPrefix = (prefix: string, secret: string) =>
  !prefix || /[=:\s]$/.test(prefix) ? `${prefix}${secret}` : `${prefix} ${secret}`;

const applyAuth = (ctx: Ctx, url: URL, headers: Record<string, string>) => {
  const { auth, opts: { credentials: c } } = ctx;
  if (ctx.opts.skipAuth) return;
  const handlers: { [K in AuthMethod['type']]: (a: Extract<AuthMethod, { type: K }>) => void } = {
    bearer: a => { headers[a.headerName || 'Authorization'] = withPrefix(a.prefix, c.token); },
    api_key: a => {
      const value = withPrefix(a.prefix, c.apiKey);
      if (a.in === 'header') headers[a.name] = value;
      else url.searchParams.set(a.name, value);
    },
    basic: () => { headers.Authorization = `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`; },
    oauth2_client_credentials: () => { headers.Authorization = `Bearer ${ctx.accessToken}`; },
    oauth2_authorization_code: () => { headers.Authorization = `Bearer ${ctx.accessToken}`; },
  };
  (handlers[auth.type] as (a: AuthMethod) => void)(auth);
};

const classify = (ctx: Ctx, status: number, headers: Headers, body: string, stream?: StreamConfig): ErrorKind => {
  const throttled = headers.get('retry-after') !== null || (ctx.m.rateLimit.remainingHeader && headers.get(ctx.m.rateLimit.remainingHeader) === '0');
  if (status === 429 || (status === 403 && throttled)) return 'rate_limited';
  if (status === 401) return 'auth';
  if (status === 402) return 'plan_gated';
  if (status === 403) {
    const planWords = /\b(upgrade|enterprise|subscription|premium|paid plan|your plan|plan does not|not available on)\b/i;
    return stream?.planRequirement || planWords.test(body) ? 'plan_gated' : 'forbidden';
  }
  if (status === 404 || status === 410) return 'not_found';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  return 'contract';
};

const assertSafeMethod = (req: RequestSpec, headers: Record<string, string>) => {
  const write = writeIntent(req, headers);
  if (write) throw new ConnectorError('safety', `Blocked request. ${write}`);
  if (req.method !== 'GET' && (req.method !== 'POST' || !req.readOnlyPostReason)) throw new ConnectorError('safety', `Blocked ${req.method} ${req.path}, connectors are read only`);
};

type Sent = { json: unknown; headers: Headers };

const send = async (ctx: Ctx, req: RequestSpec, target: URL, stream?: StreamConfig, streamName?: string): Promise<Sent> => {
  assertSafeMethod(req, ctx.m.extraHeaders);
  await ensureToken(ctx);
  let refreshed = false;
  let attempt = 0;
  let url = target;
  let redirects = 0;

  for (;;) {
    if (ctx.requests >= ctx.limits.maxRequests) throw new ConnectorError('budget', `Reached the ${ctx.limits.maxRequests} request ceiling`);
    if (Date.now() - ctx.started > ctx.limits.maxRunMs) throw new ConnectorError('budget', 'Reached the run time ceiling');
    const outbound = new URL(url);
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'integration-builder/0.1', ...ctx.m.extraHeaders };
    applyAuth(ctx, outbound, headers);
    await guardDestination(ctx, outbound);
    await pace(ctx);
    ctx.requests++;
    const startedAt = Date.now();
    const logged = { stream: streamName, method: req.method, url: scrub(ctx, redactUrl(outbound.toString(), ctx.auth.type === 'api_key' && ctx.auth.in === 'query' ? ctx.auth.name : undefined)), attempt };
    const retry = async (kind: ErrorKind, message: string, status: number | undefined, waitHint: number | null) => {
      if (attempt >= ctx.limits.maxRetries) throw new ConnectorError(kind, `${message} after ${attempt + 1} attempts`, status);
      const backoff = ctx.limits.baseBackoffMs * 2 ** attempt;
      const wait = waitHint ?? Math.round(backoff / 2 + Math.random() * backoff / 2);
      if (wait > ctx.limits.maxRetryWaitMs) throw new ConnectorError(kind, `${message}, the vendor asked to wait ${Math.round(wait / 1000)}s`, status);
      ctx.log({ level: 'warn', event: 'retry', ...logged, status, detail: `${kind}, waiting ${wait}ms` });
      attempt++;
      ctx.retries++;
      await ctx.sleep(wait);
    };

    let res: Response;
    try {
      res = await fetcher(ctx)(outbound, {
        method: req.method, headers, redirect: 'manual', signal: AbortSignal.timeout(ctx.limits.timeoutMs),
        ...(req.body ? { body: JSON.stringify(req.body), headers: { ...headers, 'content-type': 'application/json' } } : {}),
      });
    } catch (e) {
      const timedOut = (e as Error).name === 'TimeoutError';
      const kind: ErrorKind = timedOut ? 'timeout' : 'network';
      ctx.log({ level: 'warn', event: 'request_failed', ...logged, ms: Date.now() - startedAt, detail: kind });
      await retry(kind, timedOut ? 'Request timed out' : 'Network request failed', undefined, null);
      continue;
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      const next = new URL(res.headers.get('location')!, outbound);
      ctx.log({ level: 'info', event: 'redirect', ...logged, status: res.status });
      // Credentials are attached per hop, so a redirect off the allowlist must fail before the next send.
      if (next.origin !== outbound.origin) throw new ConnectorError('safety', `Blocked redirect to ${next.host}`);
      if (++redirects > 3) throw new ConnectorError('contract', 'Too many redirects');
      url = next;
      continue;
    }

    const text = await readCapped(res, ctx.limits.maxResponseBytes).catch((e: unknown) => {
      if (e instanceof ConnectorError) throw e;
      throw new ConnectorError('network', 'Connection dropped while reading the response');
    });
    ctx.log({ level: res.ok ? 'info' : 'warn', event: 'response', ...logged, status: res.status, ms: Date.now() - startedAt });

    if (!res.ok) {
      const kind = classify(ctx, res.status, res.headers, text, stream);
      if (kind === 'auth' && !refreshed) {
        refreshed = true;
        if (await ensureToken(ctx, true)) continue;
      }
      const message = `Vendor returned ${res.status}: ${scrub(ctx, text).slice(0, 200)}`;
      if (!ERROR_POLICY[kind].retryable) throw new ConnectorError(kind, message, res.status);
      await retry(kind, message, res.status, parseRetryAfter(res.headers.get('retry-after'), ctx.now()) ?? parseReset(ctx, res.headers));
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ConnectorError('contract', `Expected JSON but got: ${scrub(ctx, text).slice(0, 80)}`, res.status);
    }

    const gqlErrors = (json as { errors?: unknown } | null)?.errors;
    if (req.method === 'POST' && Array.isArray(gqlErrors) && gqlErrors.length) {
      const detail = scrub(ctx, JSON.stringify(gqlErrors[0])).slice(0, 200);
      if (/rate.?limit|throttl/i.test(detail)) {
        await retry('rate_limited', `Vendor said ${detail}`, res.status, parseRetryAfter(res.headers.get('retry-after'), ctx.now()));
        continue;
      }
      throw new ConnectorError(/forbidden|permission|scope|unauth/i.test(detail) ? 'forbidden' : 'contract', `Vendor said ${detail}`, res.status);
    }

    const envelope = ctx.m.errorEnvelope;
    if (envelope && getPath(json, envelope.successPath) !== envelope.successValue) {
      const code = String(envelope.messagePath ? getPath(json, envelope.messagePath) : 'unknown');
      if (envelope.rateLimitedCodes.includes(code)) {
        await retry('rate_limited', `Vendor said ${code}`, res.status, parseRetryAfter(res.headers.get('retry-after'), ctx.now()));
        continue;
      }
      throw new ConnectorError(envelope.authCodes.includes(code) ? 'auth' : 'contract', `Vendor said ${scrub(ctx, code)}`, res.status);
    }
    return { json, headers: res.headers };
  }
};

const buildUrl = (ctx: Ctx, req: RequestSpec, vars: Record<string, unknown>, extraQuery: Record<string, string> = {}): URL => {
  const path = applyTemplate(req.path, vars, true).replace(/^\/+/, '');
  const url = new URL(path, ctx.base);
  // ".." in a path template or a vendor value must not climb out of the API base.
  if (url.origin !== ctx.base.origin || !url.pathname.startsWith(ctx.base.pathname)) {
    throw new ConnectorError('safety', 'Blocked a path that leaves the API base');
  }
  for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, applyTemplate(v, vars, false));
  for (const [k, v] of Object.entries(extraQuery)) url.searchParams.set(k, v);
  return toSandbox(ctx, url);
};

const linkNext = (header: string | null): string | null => {
  for (const [, target, params] of (header ?? '').matchAll(/<([^>]*)>([^<]*)/g)) {
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(params);
    if ((rel?.[1] ?? rel?.[2])?.toLowerCase().split(/\s+/).includes('next')) return target;
  }
  return null;
};

const MORE_FLAG = /^(has_?more|has_?next(_?page)?|more(_?(items|results|records))?)$/i;
const NEXT_VALUE = /^(@odata\.)?next(_?(page|link|url|cursor|token|marker|offset|href|start)|$)/i;
const TOTAL = /^total(_?(count|results|records|users|items))?$/i;

/** A wrong manifest ends a walk early with no error, so any sign of more rows has to fail the run. */
const vendorSaysMore = (json: unknown, seen: number | null, depth = 0): boolean => {
  if (!json || typeof json !== 'object' || Array.isArray(json) || depth > 2) return false;
  const entries = Object.entries(json);
  if (entries.some(([k, v]) => MORE_FLAG.test(k) && v === false)) return false;
  return entries.some(([k, v]) => (MORE_FLAG.test(k) && v === true)
    || (NEXT_VALUE.test(k) && (typeof v === 'number' || (typeof v === 'string' && v !== '')))
    || (seen !== null && TOTAL.test(k) && typeof v === 'number' && v > seen)
    || vendorSaysMore(v, seen, depth + 1));
};

const asCount = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN);

type PageState = { query: Record<string, string>; absolute?: URL; offset: number; page: number; variables?: Record<string, string> };

const firstPage = (p: Pagination): PageState => {
  const state: PageState = { query: {}, offset: 0, page: 0 };
  if (p.type === 'cursor' || p.type === 'next_url' || p.type === 'link_header') {
    if (p.sizeParam && p.pageSize) state.query[p.sizeParam] = String(p.pageSize);
  } else if (p.type === 'offset') {
    state.query = { [p.offsetParam]: '0', [p.limitParam]: String(p.pageSize) };
  } else if (p.type === 'page_number') {
    state.page = p.startAt;
    state.query = { [p.pageParam]: String(p.startAt), ...(p.sizeParam && p.pageSize ? { [p.sizeParam]: String(p.pageSize) } : {}) };
  }
  return state;
};

const nextAbsolute = (ctx: Ctx, raw: string, current: URL): URL => {
  const next = new URL(raw, current);
  if (ctx.opts.sandboxOrigin && ctx.allowedHosts.has(next.host)) return toSandbox(ctx, next);
  if (next.origin === current.origin) {
    next.searchParams.delete('__vendor_host');
    return ctx.opts.sandboxOrigin ? toSandbox(ctx, new URL(next.pathname + next.search, ctx.base)) : next;
  }
  return next;
};

/** One entry per pagination style, so a new style adds a row and no branch elsewhere. */
const advance: { [K in Pagination['type']]: (ctx: Ctx, p: Extract<Pagination, { type: K }>, s: PageState, page: Sent, count: number, url: URL) => PageState | null } = {
  none: () => null,
  cursor: (_, p, s, page) => {
    const cursor = getPath(page.json, p.cursorPath);
    if (cursor === undefined || cursor === null || cursor === '') return null;
    if (typeof cursor === 'object') throw new ConnectorError('contract', `"${p.cursorPath}" is not a cursor value`);
    // GraphQL keeps a real endCursor on the last page, so only hasNextPage ends the walk.
    if (p.hasMorePath && getPath(page.json, p.hasMorePath) === false) return null;
    return p.cursorIn === 'graphql_variable'
      ? { ...s, variables: { [p.cursorParam]: String(cursor) } }
      : { ...s, query: { ...s.query, [p.cursorParam]: String(cursor) } };
  },
  next_url: (ctx, p, s, page, _n, url) => {
    const next = getPath(page.json, p.urlPath);
    if (next !== undefined && next !== null && typeof next !== 'string') throw new ConnectorError('contract', `"${p.urlPath}" is not a URL`);
    return next ? { ...s, absolute: nextAbsolute(ctx, next, url) } : null;
  },
  link_header: (ctx, _p, s, page, _n, url) => {
    const next = linkNext(page.headers.get('link'));
    return next ? { ...s, absolute: nextAbsolute(ctx, next, url) } : null;
  },
  offset: (_, p, s, page, count) => {
    const offset = s.offset + count;
    const total = p.totalPath ? asCount(getPath(page.json, p.totalPath)) : NaN;
    const more = p.hasMorePath ? getPath(page.json, p.hasMorePath) : undefined;
    // A short page proves nothing, vendors clamp limits silently. Only empty, total or an explicit flag ends the walk.
    if (count === 0 || more === false || (Number.isFinite(total) && offset >= total)) return null;
    return { ...s, offset, query: { ...s.query, [p.offsetParam]: String(offset) } };
  },
  page_number: (_, p, s, page, count) => {
    const totalPages = p.totalPagesPath ? asCount(getPath(page.json, p.totalPagesPath)) : NaN;
    const more = p.hasMorePath ? getPath(page.json, p.hasMorePath) : undefined;
    const lastIndex = p.startAt === 1 ? s.page : s.page + 1;
    if (count === 0 || more === false || (Number.isFinite(totalPages) && lastIndex >= totalPages)) return null;
    return { ...s, page: s.page + 1, query: { ...s.query, [p.pageParam]: String(s.page + 1) } };
  },
};

type Walk = { records: unknown[]; pages: number; truncated: boolean; firstRecord?: unknown };

/** Walks every page. A failure after the first page keeps what was read and reports it, so callers see partial as partial. */
const walk = async (ctx: Ctx, stream: StreamConfig, name: string, vars: Record<string, unknown>, extraQuery: Record<string, string>, sink: Walk) => {
  const pagination = stream.pagination;
  let state = firstPage(pagination);
  const seenPages = new Set<string>();
  const seenCursors = new Set<string>();
  for (;;) {
    if (sink.pages >= ctx.limits.maxPages) { sink.truncated = true; return; }
    const url = state.absolute ?? buildUrl(ctx, stream.request, vars, { ...extraQuery, ...state.query });
    const body = stream.request.body as { variables?: object } | null;
    const req = state.variables ? { ...stream.request, body: { ...body, variables: { ...body?.variables, ...state.variables } } } : stream.request;
    const page = await send(ctx, req, url, stream, name);
    const raw = getPath(page.json, stream.recordsPath);
    if (raw === undefined) throw new ConnectorError('contract', `Response has no "${stream.recordsPath}" field`);
    if (raw !== null && !Array.isArray(raw)) throw new ConnectorError('contract', `"${stream.recordsPath}" is not a list`);
    const records = (raw ?? []) as unknown[];
    sink.pages++;

    const pageHash = createHash('sha1').update(JSON.stringify(records)).digest('hex');
    if (records.length && seenPages.has(pageHash)) throw new ConnectorError('contract', `Pagination returned the same page twice on ${name}`);
    seenPages.add(pageHash);
    sink.firstRecord ??= records[0];
    const room = ctx.limits.maxRecords - sink.records.length;
    sink.records.push(...records.slice(0, room));
    if (records.length > room) { sink.truncated = true; return; }

    const advanceFn = advance[pagination.type] as (ctx: Ctx, p: Pagination, s: PageState, page: Sent, n: number, url: URL) => PageState | null;
    const next = advanceFn(ctx, pagination, state, page, records.length, url);
    if (!next) {
      if (linkNext(page.headers.get('link')) || vendorSaysMore(page.json, name === 'users' ? sink.records.length : null)) {
        throw new ConnectorError('contract', `The vendor says there are more ${name} records, but the connector stopped reading. Pagination may be wrong.`);
      }
      return;
    }
    const cursorKey = next.absolute?.toString() ?? JSON.stringify([next.query, next.variables]);
    if (seenCursors.has(cursorKey)) throw new ConnectorError('contract', `Pagination cursor repeated on ${name}`);
    seenCursors.add(cursorKey);
    state = next;
  }
};

const emptyWalk = (): Walk => ({ records: [], pages: 0, truncated: false });

const reportError = (ctx: Pick<Ctx, 'secrets'>, e: unknown) => {
  const err = e instanceof ConnectorError ? e : new ConnectorError('contract', String((e as Error)?.message ?? e));
  return { kind: err.kind, message: scrub(ctx, err.message), action: ERROR_POLICY[err.kind].action };
};

const normalizeUsers = (raw: unknown[], m: Manifest) => {
  const f = m.users.fields;
  const byId = new Map<string, NormalizedUser>();
  const quality: Quality = {
    emailCoverage: 0, statusCoverage: 0, lastActiveCoverage: 0, duplicatesRemoved: 0, droppedNoId: 0,
    unmappedStatuses: [], invalidEmails: 0, invalidTimestamps: 0,
  };
  const unmapped = new Set<string>();
  const time = (record: unknown, field: Field | null) => {
    const value = toIso(readField(record, field), field?.format ?? 'iso8601');
    if (value === undefined) { quality.invalidTimestamps++; return null; }
    return value;
  };
  const mapped = (record: unknown, field: Field | null, allowed: readonly string[]) => {
    const value = asText(readField(record, field));
    if (value === null) return 'unknown';
    const hit = field?.map?.[value] ?? field?.map?.[value.toLowerCase()] ?? value.toLowerCase();
    if (allowed.includes(hit)) return hit;
    unmapped.add(value);
    return 'unknown';
  };
  for (const record of raw) {
    const id = asText(readField(record, f.externalId));
    if (id === null) { quality.droppedNoId++; continue; }
    if (byId.has(id)) quality.duplicatesRemoved++;
    const rawEmail = asText(readField(record, f.email))?.trim().toLowerCase() ?? null;
    const validEmail = rawEmail && /^[^\s@]+@[^\s@]+$/.test(rawEmail) ? rawEmail : null;
    if (rawEmail && !validEmail) quality.invalidEmails++;
    byId.set(id, {
      externalId: id, email: validEmail, displayName: asText(readField(record, f.displayName)),
      status: mapped(record, f.status, ['active', 'inactive', 'suspended', 'pending', 'deleted', 'unknown']),
      role: asText(readField(record, f.role)),
      userType: mapped(record, f.userType, ['member', 'guest', 'service', 'unknown']),
      lastActiveAt: time(record, f.lastActiveAt), createdAt: time(record, f.createdAt),
    });
  }
  const users = [...byId.values()];
  const share = (pick: (u: NormalizedUser) => boolean) => (users.length ? users.filter(pick).length / users.length : 0);
  quality.emailCoverage = share(u => u.email !== null);
  quality.statusCoverage = share(u => u.status !== 'unknown');
  quality.lastActiveCoverage = share(u => u.lastActiveAt !== null);
  quality.unmappedStatuses = [...unmapped].slice(0, 20);
  return { users, quality };
};

const MAX_DROPPED_ID_SHARE = 0.2;
const MAX_DUPLICATE_SHARE = 0.05;

const formatWindow = (date: Date, format: NonNullable<ActiveUsageStream['window']>['format']) => ({
  iso8601: date.toISOString(), date: date.toISOString().slice(0, 10),
  epoch_seconds: String(Math.floor(date.getTime() / 1000)), epoch_millis: String(date.getTime()),
}[format]);

const windows = (ctx: Ctx, stream: ActiveUsageStream): { list: { query: Record<string, string>; vars: Record<string, string> }[]; truncated: boolean } => {
  const w = stream.window;
  if (!w) return { list: [{ query: {}, vars: {} }], truncated: false };
  const end = ctx.now();
  const days = ctx.limits.usageWindowDays;
  const chunk = Math.min(w.maxDays ?? days, days);
  const wanted = Math.ceil(days / chunk);
  const list = [];
  for (let i = 0; i < Math.min(wanted, ctx.limits.maxWindows); i++) {
    const to = new Date(end.getTime() - i * chunk * 86_400_000);
    const from = new Date(to.getTime() - chunk * 86_400_000);
    const start = formatWindow(from, w.format);
    const stop = formatWindow(to, w.format);
    list.push({ query: { [w.startParam]: start, ...(w.endParam ? { [w.endParam]: stop } : {}) }, vars: { start, end: stop } });
  }
  return { list, truncated: wanted > ctx.limits.maxWindows };
};

const normalizeUsage = (raw: unknown[], s: ActiveUsageStream, q: Quality): NormalizedUsage[] => {
  const out: NormalizedUsage[] = [];
  for (const record of raw) {
    const ref = asText(readField(record, s.fields.userRef));
    if (ref === null) continue;
    const when = toIso(readField(record, s.fields.occurredAt), s.fields.occurredAt?.format ?? 'iso8601');
    if (when === undefined) q.invalidTimestamps++;
    const value = Number(readField(record, s.fields.value));
    out.push({
      userRef: s.fields.userRefType === 'email' ? ref.trim().toLowerCase() : ref, userRefType: s.fields.userRefType,
      occurredAt: when ?? null, metric: asText(readField(record, s.fields.metric)) ?? s.fields.metricConstant ?? 'activity',
      value: Number.isFinite(value) ? value : null,
    });
  }
  return out;
};

const runUsage = async (ctx: Ctx, vars: Record<string, unknown>, users: NormalizedUser[], quality: Quality, truncatedUsers: boolean) => {
  const s = ctx.m.usage;
  if (s.kind === 'unavailable') return { report: { status: 'unavailable' as const, records: 0, pages: 0, truncated: false, note: s.reason }, usage: [], first: undefined };
  if (s.kind === 'last_activity_field') {
    const records = users.filter(u => u.lastActiveAt).length;
    return { report: { status: records ? 'complete' as const : 'partial' as const, records, pages: 0, truncated: false, note: records ? 'Taken from the user record' : 'No user had a last activity value. The vendor may have renamed the field.' }, usage: [], first: undefined };
  }
  const sink = emptyWalk();
  const targets = s.forEachUser ? users.slice(0, ctx.limits.maxFanOutUsers) : [null];
  const plan = windows(ctx, s);
  sink.truncated = plan.truncated || (s.forEachUser && (users.length > targets.length || truncatedUsers));
  try {
    for (const target of targets) {
      for (const w of plan.list) {
        await walk(ctx, s, 'usage', { ...vars, window: w.vars, user: target }, w.query, sink);
      }
    }
  } catch (e) {
    const error = reportError(ctx, e);
    const usage = normalizeUsage(sink.records, s, quality);
    if (error.kind === 'plan_gated') return { report: { status: 'unavailable' as const, records: 0, pages: sink.pages, truncated: false, error }, usage: [], first: undefined };
    return { report: { status: sink.records.length ? 'partial' as const : 'failed' as const, records: usage.length, pages: sink.pages, truncated: sink.truncated, error }, usage, first: sink.firstRecord };
  }
  const usage = normalizeUsage(sink.records, s, quality);
  if (sink.records.length && (sink.records.length - usage.length) / sink.records.length > MAX_DROPPED_ID_SHARE) {
    const error = reportError(ctx, new ConnectorError('contract', `${sink.records.length - usage.length} of ${sink.records.length} usage rows had no "${s.fields.userRef.path}". The API may have changed.`));
    return { report: { status: 'failed' as const, records: 0, pages: sink.pages, truncated: sink.truncated, error }, usage: [], first: sink.firstRecord };
  }
  return { report: { status: sink.truncated ? 'partial' as const : 'complete' as const, records: usage.length, pages: sink.pages, truncated: sink.truncated }, usage, first: sink.firstRecord };
};

const judgeMissing = (users: StreamReport, count: number, previous: number | undefined, quality: Quality, rawRows: number) => {
  if (users.status !== 'complete') return { allowed: false, reason: `The user sync was ${users.status}, so missing users prove nothing.` };
  if (count === 0) return { allowed: false, reason: 'Zero users came back, which is more likely a fault than a real empty account.' };
  if (previous && count < previous * 0.5) return { allowed: false, reason: `User count fell from ${previous} to ${count}. A person must confirm this.` };
  if (quality.droppedNoId) return { allowed: false, reason: `${quality.droppedNoId} records had no ID, so those people are invisible to this run.` };
  if (quality.duplicatesRemoved / rawRows > MAX_DUPLICATE_SHARE) return { allowed: false, reason: `${quality.duplicatesRemoved} of ${rawRows} records were duplicates, so pagination may not be advancing.` };
  return { allowed: true, reason: 'Complete sync, count is consistent.' };
};

const judgeReconcile = (missing: { allowed: boolean; reason: string }, usage: StreamReport): RunResult['reconcile'] => ({
  ...missing,
  inactive: !missing.allowed ? missing
    : usage.status === 'complete' ? { allowed: true, reason: 'Users and usage are both complete.' }
    : { allowed: false, reason: `Usage was ${usage.status}, so no activity does not prove a person is inactive.` },
});

export const collectSecrets = (c: Record<string, string>) => [
  ...Object.values(c).flatMap(v => [v, encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2), Buffer.from(v).toString('base64')]),
  ...[[c.username, c.password], [c.clientId, c.clientSecret]].filter(([a, b]) => a && b).map(([a, b]) => Buffer.from(`${a}:${b}`).toString('base64')),
];

export const runConnector = async (m: Manifest, opts: RunOptions): Promise<RunResult> => {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const started = Date.now();
  const emptyReport = (status: StreamStatus): StreamReport => ({ status, records: 0, pages: 0, truncated: false });
  const result: RunResult = {
    users: [], usage: [],
    streams: { context: emptyReport('skipped'), users: emptyReport('skipped'), usage: emptyReport('skipped') },
    quality: { emailCoverage: 0, statusCoverage: 0, lastActiveCoverage: 0, duplicatesRemoved: 0, droppedNoId: 0, unmappedStatuses: [], invalidEmails: 0, invalidTimestamps: 0 },
    reconcile: { allowed: false, reason: 'The run did not finish.', inactive: { allowed: false, reason: 'The run did not finish.' } }, shapes: {},
    stats: { requests: 0, retries: 0, elapsedMs: 0 },
  };

  let ctx: Ctx | undefined;
  const secrets = collectSecrets(opts.credentials);
  const emit = (e: Omit<LogEvent, 'ts'>) => opts.log?.({ ts: new Date().toISOString(), ...e });
  try {
    const auth = m.authMethods[opts.authMethodIndex ?? 0];
    if (!auth) throw new ConnectorError('config', 'That auth method does not exist');
    const base = resolveBaseUrl(m, opts.connection);
    const allowedHosts = new Set([base.host]);
    if (auth.type === 'oauth2_client_credentials' || auth.type === 'oauth2_authorization_code') allowedHosts.add(new URL(fillHost(auth.tokenUrl, opts.connection)).host);
    ctx = {
      m, opts, limits, auth, base, allowedHosts, secrets, log: e => emit({ ...e, detail: e.detail && scrub(ctx!, e.detail) }),
      now: opts.now ?? (() => new Date()),
      sleep: opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms))),
      started, requests: 0, retries: 0, nextSlot: 0,
    };
  } catch (e) {
    result.streams.users = { ...emptyReport('failed'), error: reportError({ secrets }, e) };
    return result;
  }

  const run = ctx;
  const vars: Record<string, unknown> = { connection: opts.connection ?? {}, context: {} };
  try {
    for (const step of m.context) {
      const page = await send(run, step.request, buildUrl(run, step.request, vars), undefined, `context:${step.name}`);
      const values: Record<string, unknown> = {};
      for (const [key, path] of Object.entries(step.extract)) {
        values[key] = getPath(page.json, path);
        if (values[key] === undefined || values[key] === null) throw new ConnectorError('contract', `Context "${step.name}" has no "${path}"`);
      }
      Object.assign(vars.context as object, values);
      result.streams.context.pages++;
    }
    result.streams.context.status = m.context.length ? 'complete' : 'skipped';
  } catch (e) {
    result.streams.context = { ...result.streams.context, status: 'failed', error: reportError(run, e) };
    result.streams.users = { ...emptyReport('skipped'), error: result.streams.context.error };
    result.stats = { requests: run.requests, retries: run.retries, elapsedMs: Date.now() - started };
    run.log({ level: 'error', event: 'context_failed', detail: result.streams.context.error?.message });
    return result;
  }

  const sink = emptyWalk();
  let failure: ReturnType<typeof reportError> | undefined;
  try {
    await walk(run, m.users, 'users', vars, {}, sink);
  } catch (e) {
    failure = reportError(run, e);
    run.log({ level: 'error', event: 'users_failed', detail: failure.message });
  }
  const { users, quality } = normalizeUsers(sink.records, m);
  result.users = users;
  result.quality = quality;
  result.shapes.users = sink.firstRecord === undefined ? undefined : shapeOf(sink.firstRecord);
  if (!failure && sink.records.length && quality.droppedNoId / sink.records.length > MAX_DROPPED_ID_SHARE) {
    failure = reportError(run, new ConnectorError('contract', `${quality.droppedNoId} of ${sink.records.length} users had no "${m.users.fields.externalId.path}". The API may have changed.`));
    result.users = [];
  }
  result.streams.users = {
    status: failure ? (result.users.length ? 'partial' : 'failed') : sink.truncated ? 'partial' : 'complete',
    records: result.users.length, pages: sink.pages, truncated: sink.truncated, ...(failure ? { error: failure } : {}),
  };

  // Usage still runs after a partial user sync, because a plan or scope gate on one must not hide the other.
  if (result.streams.users.status !== 'failed') {
    const usage = await runUsage(run, vars, result.users, quality, sink.truncated);
    result.streams.usage = usage.report;
    result.usage = usage.usage;
    result.shapes.usage = usage.first === undefined ? undefined : shapeOf(usage.first);
  }

  result.reconcile = judgeReconcile(judgeMissing(result.streams.users, result.users.length, opts.previousUserCount, quality, sink.records.length), result.streams.usage);
  result.stats = { requests: run.requests, retries: run.retries, elapsedMs: Date.now() - started };
  run.log({ level: 'info', event: 'run_finished', detail: `${result.streams.users.status}, ${result.users.length} users, ${result.usage.length} usage rows` });
  return result;
};
