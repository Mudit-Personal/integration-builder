import { credentialFields, type ActiveUsageStream, type AuthMethod, type Manifest, type Pagination, type RequestSpec, type StreamConfig } from './manifest.ts';

export type Reply = { status?: number; headers?: Record<string, string>; body?: string; hangMs?: number };
/** A request stripped of its transport, so the same vendor answers over HTTP and through a virtual fetch. Header names are lower case. */
export type PlainRequest = { method: string; url: URL; headers: Record<string, string>; body: string | null };
export type Route = { stream: 'context' | 'users' | 'usage'; step?: number; config: StreamConfig | null };

export type Fault = {
  /** Return a reply to replace the normal response. n counts calls to this route, starting at 1. */
  intercept?: (route: Route, n: number, url: URL, req: PlainRequest) => Reply | undefined;
  mutateRecords?: (records: Record<string, unknown>[], route: Route) => Record<string, unknown>[];
  recordCount?: number;
  vendorPageCap?: number;
  /** Page offset ignored and "next" always present, like a vendor stuck on one cursor. */
  stuckPagination?: boolean;
  overlapPages?: boolean;
  /** Serves next links on this origin, like a compromised or misconfigured vendor response. */
  nextLinkOrigin?: () => string;
};

export type Mock = {
  origin: string; offsiteOrigin: string; offsiteHits: { url: string; authorization?: string }[];
  requests: () => number; credentials: Record<string, string>; connection: Record<string, string>; stop: () => Promise<void>;
  /** Only the virtual mock has one. The HTTP mock is reached by the real fetch. */
  fetch?: typeof fetch;
};

export type StartMock = (m: Manifest, fault?: Fault, authIndex?: number) => Promise<Mock>;

const DEFAULT_RECORDS = 57;
const DEFAULT_PAGE_CAP = 20;

export const setPath = (target: Record<string, unknown>, path: string, value: unknown) => {
  if (path === '$') return;
  const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let node = target;
  for (const [i, key] of keys.slice(0, -1).entries()) node = (node[key] ??= /^\d+$/.test(keys[i + 1]) ? [] : {}) as Record<string, unknown>;
  node[keys.at(-1)!] = value;
};

const hasDot = (p: string) => p.startsWith('@');
const assign = (t: Record<string, unknown>, path: string, v: unknown) => (hasDot(path) ? (t[path] = v) : setPath(t, path, v));

const timestamp = (format: string | null, i: number) => {
  const at = Date.UTC(2026, 8, 1 + (i % 28));
  return format === 'epoch_seconds' ? at / 1000 : format === 'epoch_millis' ? at : new Date(at).toISOString();
};

const fromMap = (map: Record<string, string> | null, want: string, fallback: unknown) => {
  const key = Object.entries(map ?? {}).find(([, v]) => v === want)?.[0];
  if (key === undefined) return fallback;
  return key === 'true' ? true : key === 'false' ? false : key;
};

export const synthUser = (m: Manifest, i: number) => {
  const f = m.users.fields;
  const rec: Record<string, unknown> = {};
  assign(rec, f.externalId.path, `user-${i}`);
  if (f.email) assign(rec, f.email.path, `person${i}@example.test`);
  if (f.displayName) assign(rec, f.displayName.path, `Person ${i}`);
  if (f.status) assign(rec, f.status.path, fromMap(f.status.map, 'active', 'active'));
  if (f.role) assign(rec, f.role.path, 'user');
  if (f.userType) assign(rec, f.userType.path, fromMap(f.userType.map, 'member', 'member'));
  if (f.lastActiveAt) assign(rec, f.lastActiveAt.path, timestamp(f.lastActiveAt.format, i));
  if (f.createdAt) assign(rec, f.createdAt.path, timestamp(f.createdAt.format, i + 3));
  return rec;
};

const synthUsage = (s: ActiveUsageStream, i: number) => {
  const rec: Record<string, unknown> = {};
  assign(rec, s.fields.userRef.path, s.fields.userRefType === 'email' ? `person${i}@example.test` : `user-${i}`);
  if (s.fields.occurredAt) assign(rec, s.fields.occurredAt.path, timestamp(s.fields.occurredAt.format, i));
  if (s.fields.metric) assign(rec, s.fields.metric.path, 'login');
  if (s.fields.value) assign(rec, s.fields.value.path, i);
  return rec;
};

const expectedAuth = (a: AuthMethod, creds: Record<string, string>, req: PlainRequest, accessToken: string): boolean => {
  const { url } = req;
  const header = (n: string) => req.headers[n.toLowerCase()];
  const checks: Record<AuthMethod['type'], () => boolean> = {
    bearer: () => !!a && a.type === 'bearer' && !!header(a.headerName || 'Authorization')?.includes(creds.token),
    api_key: () => a.type === 'api_key' && (a.in === 'header' ? header(a.name) : url.searchParams.get(a.name))?.includes(creds.apiKey) === true,
    basic: () => header('authorization') === `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`,
    oauth2_client_credentials: () => header('authorization') === `Bearer ${accessToken}`,
    oauth2_authorization_code: () => header('authorization') === `Bearer ${accessToken}`,
  };
  return checks[a.type]();
};

const pathRegex = (base: string, path: string) => {
  const escaped = (base.replace(/\/+$/, '') + path).split(/(?:\{\{[^}]+\}\})+/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('[^/]+')}/?$`);
};

const pageParams = (p: Pagination, url: URL, cap: number, stuck: boolean, overlap: boolean) => {
  const q = url.searchParams;
  const num = (name: string | null | undefined, fallback: number) => (name && q.get(name) !== null ? Number(q.get(name)) : fallback);
  const size = (requested: number) => Math.min(requested, cap);
  if (p.type === 'offset') return { start: stuck ? 0 : num(p.offsetParam, 0), size: size(p.pageSize) };
  if (p.type === 'page_number') {
    const s = size(p.pageSize ?? cap);
    return { start: stuck ? 0 : (num(p.pageParam, p.startAt) - p.startAt) * s, size: s };
  }
  if (p.type === 'cursor') {
    const raw = q.get(p.cursorParam);
    const at = raw ? Number(raw.replace('c', '')) : 0;
    return { start: stuck ? 0 : Math.max(0, at - (overlap && at ? 1 : 0)), size: size(num(p.sizeParam, cap)), resume: at };
  }
  if (p.type === 'next_url' || p.type === 'link_header') {
    const at = Number(q.get('__at') ?? 0);
    return { start: stuck ? 0 : Math.max(0, at - (overlap && at ? 1 : 0)), size: size(num(p.sizeParam, cap)), resume: at };
  }
  return { start: 0, size: Number.MAX_SAFE_INTEGER };
};

const buildPage = (s: StreamConfig, all: Record<string, unknown>[], url: URL, vendorHost: string, fault: Fault) => {
  const cap = fault.vendorPageCap ?? DEFAULT_PAGE_CAP;
  const p = s.pagination;
  const { start, size, resume } = pageParams(p, url, cap, !!fault.stuckPagination, !!fault.overlapPages) as { start: number; size: number; resume?: number };
  const rows = all.slice(start, start + size);
  const end = (resume ?? start) + rows.length - (resume && fault.overlapPages ? 1 : 0);
  const more = end < all.length || !!fault.stuckPagination;
  const body: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  const nextLink = () => {
    const u = new URL(url);
    u.protocol = 'https:';
    u.host = vendorHost;
    u.port = '';
    u.searchParams.delete('__vendor_host');
    u.searchParams.set('__at', String(fault.stuckPagination ? 0 : end));
    return fault.nextLinkOrigin ? `${fault.nextLinkOrigin()}${u.pathname}${u.search}` : u.toString();
  };
  if (p.type === 'cursor' && (more || p.hasMorePath)) assign(body, p.cursorPath, `c${fault.stuckPagination ? 1 : end}`);
  if (p.type === 'cursor' && p.hasMorePath) assign(body, p.hasMorePath, more);
  if (p.type === 'next_url' && more) assign(body, p.urlPath, nextLink());
  if (p.type === 'link_header' && more) headers.link = `<${nextLink()}>; rel="next"`;
  if (p.type === 'offset') {
    if (p.totalPath) assign(body, p.totalPath, all.length);
    if (p.hasMorePath) assign(body, p.hasMorePath, more);
  }
  if (p.type === 'page_number') {
    if (p.totalPagesPath) assign(body, p.totalPagesPath, Math.ceil(all.length / size));
    if (p.hasMorePath) assign(body, p.hasMorePath, more);
  }
  if (s.recordsPath === '$') return { json: rows, headers };
  assign(body, s.recordsPath, rows);
  return { json: body, headers };
};

type Json = { query?: string; variables?: Record<string, unknown> };
const parseBody = (body: string | null): Json | null => {
  try {
    return JSON.parse(body ?? '');
  } catch {
    return null;
  }
};

/** The fake vendor without a transport. Replies are returned, not sent, so hangMs is the caller's to honour. */
export const createVendor = (m: Manifest, fault: Fault = {}, authIndex = 0) => {
  const auth = m.authMethods[authIndex];
  const credentials = Object.fromEntries(credentialFields(auth).map(f => [f.name, `sandbox-${f.name}-b7f3e19a`]));
  const connection = Object.fromEntries(m.connectionFields.map(f => [f.name, 'acme']));
  const baseUrl = m.baseUrl.replace(/\{\w+\}/g, 'acme');
  const base = new URL(baseUrl);
  const count = fault.recordCount ?? DEFAULT_RECORDS;
  const users = Array.from({ length: count }, (_, i) => synthUser(m, i));
  const usageStream = m.usage.kind === 'event_log' || m.usage.kind === 'aggregate_report' ? m.usage : null;
  const usage = usageStream ? Array.from({ length: 12 }, (_, i) => synthUsage(usageStream, i)) : [];
  let requests = 0;
  let token = credentials.accessToken ?? 'mock-access-0';
  const calls = new Map<string, number>();

  const routes: { re: RegExp; req: RequestSpec; route: Route }[] = [
    ...m.context.map((step, i) => ({ re: pathRegex(base.pathname, step.request.path), req: step.request, route: { stream: 'context' as const, step: i, config: null } })),
    ...(usageStream ? [{ re: pathRegex(base.pathname, usageStream.request.path), req: usageStream.request, route: { stream: 'usage' as const, config: usageStream } }] : []),
    { re: pathRegex(base.pathname, m.users.request.path), req: m.users.request, route: { stream: 'users' as const, config: m.users } },
  ];

  const handle = (req: PlainRequest): Reply => {
    requests++;
    const { url } = req;
    const tokenMethod = auth.type === 'oauth2_client_credentials' || auth.type === 'oauth2_authorization_code' ? auth : null;
    if (req.method === 'POST' && tokenMethod && url.pathname === new URL(tokenMethod.tokenUrl).pathname) {
      token = `mock-access-${requests}`;
      return { body: JSON.stringify({ access_token: token, expires_in: 3600, refresh_token: `sandbox-rotated-${requests}` }) };
    }
    const sent = req.method === 'POST' ? parseBody(req.body) : null;
    for (const [k, v] of Object.entries(sent?.variables ?? {})) url.searchParams.set(k, String(v));
    // GraphQL sends every operation to one path, so the query text decides the route.
    const match = routes.find(r => r.re.test(url.pathname) && r.req.method === req.method && (!r.req.body || (r.req.body as Json).query === sent?.query));
    if (!match) return { status: 404, body: '{"message":"not found"}' };
    const key = match.route.stream + (match.route.step ?? '');
    const n = (calls.get(key) ?? 0) + 1;
    calls.set(key, n);

    const custom = fault.intercept?.(match.route, n, url, req);
    if (custom) return custom;
    if (!expectedAuth(auth, credentials, req, token)) return { status: 401, body: '{"message":"unauthorized"}' };

    const envelope: Record<string, unknown> = {};
    if (m.errorEnvelope) assign(envelope, m.errorEnvelope.successPath, m.errorEnvelope.successValue);
    if (match.route.stream === 'context') {
      const step = m.context[match.route.step!];
      for (const path of Object.values(step.extract)) assign(envelope, path, `https://${base.host}/ctx/${path.replace(/\W/g, '-')}`);
      return { body: JSON.stringify(envelope) };
    }
    const config = match.route.config!;
    for (const [k, v] of Object.entries(match.req.query)) {
      if (!v.includes('{{') && url.searchParams.get(k) !== v) return { status: 400, body: `{"message":"bad ${k}"}` };
    }
    const pool = match.route.stream === 'users' ? users : usage;
    const records = fault.mutateRecords?.(pool.map(r => structuredClone(r)), match.route) ?? pool;
    const page = buildPage(config, records, url, base.host, fault);
    const json = Array.isArray(page.json) ? page.json : { ...envelope, ...page.json };
    return { headers: page.headers, body: JSON.stringify(json) };
  };

  return { handle, credentials, connection, requests: () => requests };
};
