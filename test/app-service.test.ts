import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { handleApp } from '../src/app-service.ts';
import { migrate, pgliteSql, type Sql } from '../src/db.ts';

let sql: Sql;
let base: string;
const server = createServer((req, res) => void handleApp(req, res, { db: Promise.resolve(sql) }));

before(async () => {
  sql = await pgliteSql();
  await migrate(sql);
  await migrate(sql);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

type Res = { status: number; body: any; cookie: string | null };
const call = async (method: string, path: string, opts: { body?: unknown; cookie?: string | null; headers?: Record<string, string> } = {}): Promise<Res> => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const set = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json(), cookie: set ? set.split(';')[0] : null };
};

const email = () => `${randomUUID().slice(0, 8)}@acme.com`;
const join = async (address = email(), company = 'Acme') => {
  const r = await call('POST', '/api/signup', { body: { email: address, password: 'correct horse', company } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { email: address, cookie: r.cookie! };
};
const connector = (updatedAt: number, name = 'Slack') => ({ id: randomUUID(), slug: 'slack', name, status: 'draft', step: 2, hash: '', updatedAt, flow: {} });

test('signing up opens a session for a new workspace, with the email normalized', async () => {
  const address = email();
  const r = await call('POST', '/api/signup', { body: { email: `  ${address.toUpperCase()} `, password: 'correct horse', company: ' Acme Inc ' } });
  assert.equal(r.status, 200);
  assert.match(r.cookie!, /^pb_session=.{20,}/);
  const me = await call('GET', '/api/me', { cookie: r.cookie });
  assert.equal(me.body.account.email, address);
  assert.equal(me.body.account.workspace.name, 'Acme Inc');
});

test('an email can hold one account, and a refused sign-up leaves no workspace behind', async () => {
  const { email: address } = await join();
  const [{ n: before }] = await sql('SELECT count(*)::int AS n FROM workspaces');
  const again = await call('POST', '/api/signup', { body: { email: address, password: 'another one', company: 'Other' } });
  assert.equal(again.status, 409);
  assert.equal(again.cookie, null);
  const [{ n: afterwards }] = await sql('SELECT count(*)::int AS n FROM workspaces');
  assert.equal(afterwards, before);
});

test('sign-up explains what to fix', async () => {
  const short = await call('POST', '/api/signup', { body: { email: email(), password: 'short', company: 'Acme' } });
  assert.deepEqual([short.status, short.body.error], [400, 'Use at least 8 characters for your password.']);
  const bad = await call('POST', '/api/signup', { body: { email: 'not-an-email', password: 'correct horse', company: 'Acme' } });
  assert.deepEqual([bad.status, bad.body.error], [400, 'Enter a valid email address.']);
});

test('passwords are stored hashed', async () => {
  const { email: address } = await join();
  const [row] = await sql('SELECT password_hash FROM users WHERE email = $1', [address]);
  assert.match(row.password_hash as string, /^scrypt\$/);
  assert.doesNotMatch(row.password_hash as string, /correct horse/);
});

test('log in, log out, and a logged-out session stops working', async () => {
  const { email: address } = await join();
  const wrong = await call('POST', '/api/login', { body: { email: address, password: 'wrong password' } });
  assert.deepEqual([wrong.status, wrong.cookie], [401, null]);
  const unknown = await call('POST', '/api/login', { body: { email: email(), password: 'correct horse' } });
  assert.equal(unknown.body.error, wrong.body.error);
  const ok = await call('POST', '/api/login', { body: { email: address.toUpperCase(), password: 'correct horse' } });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: ok.cookie })).body.account.email, address);
  const out = await call('POST', '/api/logout', { cookie: ok.cookie, body: {} });
  assert.match(out.cookie!, /^pb_session=$/);
  assert.equal((await call('GET', '/api/me', { cookie: ok.cookie })).body.account, null);
});

test('ten wrong passwords lock that email out for a while, even with the right one', async () => {
  const { email: address } = await join();
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/api/login', { body: { email: address, password: 'wrong password' } })).status, 401);
  const locked = await call('POST', '/api/login', { body: { email: address, password: 'correct horse' } });
  assert.equal(locked.status, 429);
});

test('connectors and their reads are saved to the workspace', async () => {
  const { cookie } = await join();
  const c = connector(1000);
  const pack = { hash: 'h1', manifest: { app: { name: 'Slack' } } };
  assert.equal((await call('PUT', `/api/connectors/${c.id}`, { cookie, body: { connector: c, pack } })).status, 200);
  const list = await call('GET', '/api/connectors', { cookie });
  assert.deepEqual(list.body.connectors, [c]);
  assert.deepEqual(list.body.packs, { [c.id]: pack });
  assert.equal((await call('DELETE', `/api/connectors/${c.id}`, { cookie, headers: { 'content-type': 'application/json' } })).status, 200);
  assert.deepEqual((await call('GET', '/api/connectors', { cookie })).body.connectors, []);
});

test('a late, older save never overwrites a newer one', async () => {
  const { cookie } = await join();
  const newer = { ...connector(2000, 'Newer') };
  await call('PUT', `/api/connectors/${newer.id}`, { cookie, body: { connector: newer, pack: null } });
  await call('PUT', `/api/connectors/${newer.id}`, { cookie, body: { connector: { ...newer, updatedAt: 1000, name: 'Older' }, pack: null } });
  assert.equal((await call('GET', '/api/connectors', { cookie })).body.connectors[0].name, 'Newer');
});

test('one workspace can never read, overwrite or delete another workspace\'s connectors', async () => {
  const a = await join();
  const b = await join(email(), 'Rival');
  const c = connector(1000, 'Private');
  await call('PUT', `/api/connectors/${c.id}`, { cookie: a.cookie, body: { connector: c, pack: null } });
  assert.deepEqual((await call('GET', '/api/connectors', { cookie: b.cookie })).body.connectors, []);
  await call('PUT', `/api/connectors/${c.id}`, { cookie: b.cookie, body: { connector: { ...c, updatedAt: 9999, name: 'Stolen' }, pack: null } });
  await call('DELETE', `/api/connectors/${c.id}`, { cookie: b.cookie, headers: { 'content-type': 'application/json' } });
  assert.equal((await call('GET', '/api/connectors', { cookie: a.cookie })).body.connectors[0].name, 'Private');
});

test('workspace data needs a session', async () => {
  assert.equal((await call('GET', '/api/connectors')).status, 401);
  assert.equal((await call('GET', '/api/connectors', { cookie: 'pb_session=made-up' })).status, 401);
});

test('writes from another site, or without JSON, are refused', async () => {
  const { cookie } = await join();
  const c = connector(1000);
  const foreign = await call('PUT', `/api/connectors/${c.id}`, { cookie, body: { connector: c, pack: null }, headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  const form = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a@b.co&password=x' });
  assert.equal(form.status, 403);
});

test('the server says so when accounts are not set up', async () => {
  const bare = createServer((req, res) => void handleApp(req, res, { db: Promise.resolve(null) }));
  await new Promise<void>(r => bare.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/api/me`);
  bare.close();
  assert.equal(res.status, 503);
});

test('a person can set their name and rename the workspace, and blank fields are refused', async () => {
  const { cookie } = await join();
  const r = await call('PATCH', '/api/me', { cookie, body: { name: '  Ana Cruz ', company: 'Acme Labs' } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.account.name, r.body.account.workspace.name], ['Ana Cruz', 'Acme Labs']);
  assert.equal((await call('GET', '/api/me', { cookie })).body.account.name, 'Ana Cruz');
  const blank = await call('PATCH', '/api/me', { cookie, body: { company: '  ' } });
  assert.deepEqual([blank.status, blank.body.error], [400, 'Enter your company name.']);
  assert.equal((await call('PATCH', '/api/me', { body: { name: 'X' } })).status, 401);
});

test('changing the password needs the current one, and signs out every other session', async () => {
  const { email: address, cookie } = await join();
  const other = (await call('POST', '/api/login', { body: { email: address, password: 'correct horse' } })).cookie;
  const wrong = await call('POST', '/api/me/password', { cookie, body: { current: 'not it at all', next: 'battery staple' } });
  assert.equal(wrong.status, 403);
  const short = await call('POST', '/api/me/password', { cookie, body: { current: 'correct horse', next: 'short' } });
  assert.equal(short.status, 400);
  assert.equal((await call('POST', '/api/me/password', { cookie, body: { current: 'correct horse', next: 'battery staple' } })).status, 200);
  assert.equal((await call('GET', '/api/me', { cookie })).body.account.email, address, 'this session stays');
  assert.equal((await call('GET', '/api/me', { cookie: other })).body.account, null, 'the other session is gone');
  assert.equal((await call('POST', '/api/login', { body: { email: address, password: 'correct horse' } })).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { email: address, password: 'battery staple' } })).status, 200);
});

test('guessing the current password counts towards the login lockout', async () => {
  const { cookie } = await join();
  for (let i = 0; i < 10; i++) await call('POST', '/api/me/password', { cookie, body: { current: 'guess number x', next: 'battery staple' } });
  const locked = await call('POST', '/api/me/password', { cookie, body: { current: 'correct horse', next: 'battery staple' } });
  assert.equal(locked.status, 429);
});
