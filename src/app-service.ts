import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { AccountError, changePassword, logIn, logOut, SESSION_DAYS, sessionFor, signUp, updateProfile, type Account, type Session } from './accounts.ts';
import type { Sql } from './db.ts';
import { readBody } from './read-service.ts';

export type AppDeps = { db: Promise<Sql | null> };

const COOKIE = 'pb_session';
const MAX_BODY = 1_000_000;

const Email = z.string().trim().toLowerCase().pipe(z.email({ error: 'Enter a valid email address.' }).max(254, 'Enter a valid email address.'));
const Password = z.string().min(8, 'Use at least 8 characters for your password.').max(200, 'Use at most 200 characters for your password.');
const Company = z.string().trim().min(1, 'Enter your company name.').max(100, 'Use at most 100 characters for the company name.');
const SignUpBody = z.object({ email: Email, password: Password, company: Company });
const ProfileBody = z.object({ name: z.string().trim().max(100, 'Use at most 100 characters for your name.').optional(), company: Company.optional() });
const PasswordBody = z.object({ current: z.string().min(1, 'Enter your current password.').max(200), next: Password });
const LogInBody = z.object({ email: Email, password: z.string().min(1, 'Enter your password.').max(200) });
// The connector is this workspace's own client state, shown back only to its members. Only what the server keys on is checked.
const PutBody = z.object({ connector: z.looseObject({ id: z.uuid(), updatedAt: z.number().int().nonnegative() }), pack: z.looseObject({}).nullable() });

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

const tokenOf = (req: IncomingMessage) =>
  req.headers.cookie?.split(';').map(c => c.trim().split('=')).find(([k]) => k === COOKIE)?.[1] ?? null;

const cookie = (req: IncomingMessage, token: string | null) => {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE}=${token ?? ''}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token ? SESSION_DAYS * 86_400 : 0}${secure}`;
};

/** A cross-site form can't send JSON without a preflight, and a page on another origin is refused outright. */
const sameOrigin = (req: IncomingMessage) => {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return false;
  const origin = req.headers.origin;
  return !origin || new URL(origin).host === (req.headers['x-forwarded-host'] ?? req.headers.host);
};

const body = async <T>(req: IncomingMessage, schema: z.ZodType<T>) => {
  const raw = await readBody(req, MAX_BODY);
  if (raw === null) throw new HttpError(413, 'That is too large to save.');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'The request was not valid JSON.');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'The request was not valid.');
  return parsed.data;
};

type Ctx = { req: IncomingMessage; res: ServerResponse; sql: Sql; id: string | undefined };
type Route = { auth: false; run: (c: Ctx) => Promise<void> } | { auth: true; run: (c: Ctx, account: Account, session: Session & { token: string }) => Promise<void> };

const signedIn = (c: Ctx, out: { token: string; account: Account }) =>
  send(c.res, 200, { account: out.account }, { 'set-cookie': cookie(c.req, out.token) });

const ROUTES: Record<string, Route> = {
  'POST /api/signup': { auth: false, run: async c => signedIn(c, await signUp(c.sql, await body(c.req, SignUpBody))) },
  'POST /api/login': { auth: false, run: async c => signedIn(c, await logIn(c.sql, await body(c.req, LogInBody))) },
  'POST /api/logout': {
    auth: false,
    run: async c => {
      const token = tokenOf(c.req);
      if (token) await logOut(c.sql, token);
      send(c.res, 200, {}, { 'set-cookie': cookie(c.req, null) });
    },
  },
  // Signed out is an answer here, not an error, so a visitor's console stays clean.
  'GET /api/me': {
    auth: false,
    run: async c => {
      const token = tokenOf(c.req);
      send(c.res, 200, { account: (token && (await sessionFor(c.sql, token))?.account) || null });
    },
  },
  'PATCH /api/me': {
    auth: true,
    run: async (c, _, { userId }) => send(c.res, 200, { account: await updateProfile(c.sql, userId, await body(c.req, ProfileBody)) }),
  },
  'POST /api/me/password': {
    auth: true,
    run: async (c, _, { userId, token }) => {
      await changePassword(c.sql, userId, token, await body(c.req, PasswordBody));
      send(c.res, 200, {});
    },
  },
  'GET /api/connectors': {
    auth: true,
    run: async (c, { workspace }) => {
      const rows = await c.sql(`SELECT id, data, pack FROM connectors WHERE workspace_id = $1 ORDER BY updated_at DESC`, [workspace.id]);
      send(c.res, 200, { connectors: rows.map(r => r.data), packs: Object.fromEntries(rows.filter(r => r.pack).map(r => [r.id, r.pack])) });
    },
  },
  'PUT /api/connectors/:id': {
    auth: true,
    run: async (c, { workspace }) => {
      const { connector, pack } = await body(c.req, PutBody);
      if (connector.id !== c.id) throw new HttpError(400, 'The connector id does not match the address.');
      // Older writes arriving late never overwrite newer ones, and an id from another workspace is never touched.
      await c.sql(
        `INSERT INTO connectors (id, workspace_id, data, pack, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data, pack = excluded.pack, updated_at = excluded.updated_at
         WHERE connectors.workspace_id = excluded.workspace_id AND connectors.updated_at <= excluded.updated_at`,
        [connector.id, workspace.id, JSON.stringify(connector), pack && JSON.stringify(pack), connector.updatedAt],
      );
      send(c.res, 200, {});
    },
  },
  'DELETE /api/connectors/:id': {
    auth: true,
    run: async (c, { workspace }) => {
      await c.sql(`DELETE FROM connectors WHERE id = $1 AND workspace_id = $2`, [c.id, workspace.id]);
      send(c.res, 200, {});
    },
  },
};

const routeFor = (method: string, path: string) => {
  const match = /^\/api\/connectors\/([^/]+)$/.exec(path);
  return { route: ROUTES[`${method} ${match ? '/api/connectors/:id' : path}`], id: match?.[1] };
};

export const handleApp = async (req: IncomingMessage, res: ServerResponse, { db }: AppDeps) => {
  const { route, id } = routeFor(req.method ?? 'GET', new URL(req.url ?? '/', 'http://localhost').pathname);
  if (!route) return send(res, 404, { error: 'Not found.' });
  try {
    const sql = await db;
    if (!sql) throw new HttpError(503, 'Accounts are not set up on this server.');
    if (req.method !== 'GET' && !sameOrigin(req)) throw new HttpError(403, 'This request came from another site.');
    const ctx = { req, res, sql, id };
    if (!route.auth) return await route.run(ctx);
    const token = tokenOf(req);
    const session = token && await sessionFor(sql, token);
    if (!session) throw new HttpError(401, 'Log in to carry on.');
    await route.run(ctx, session.account, { ...session, token: token! });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    if (e instanceof AccountError) return send(res, { email_taken: 409, bad_login: 401, throttled: 429, wrong_password: 403 }[e.code], { error: e.message, code: e.code });
    console.error('app request failed', (e as Error).name, (e as Error).message.slice(0, 200));
    send(res, 500, { error: 'Something went wrong on our side. Try again in a minute.' });
  }
};
