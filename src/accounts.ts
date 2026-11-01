import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Row, Sql } from './db.ts';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export type Account = { email: string; name: string; workspace: { id: string; name: string } };
export type AccountErrorCode = 'email_taken' | 'bad_login' | 'throttled' | 'wrong_password';

export class AccountError extends Error {
  code: AccountErrorCode;
  constructor(code: AccountErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const SESSION_DAYS = 30;
const MAX_FAILURES = 10;
const FAILURE_WINDOW = '15 minutes';
const KEY_LENGTH = 64;

export const hashPassword = async (password: string) => {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(password, salt, KEY_LENGTH)).toString('base64')}`;
};

export const passwordMatches = async (password: string, stored: string) => {
  const [, salt, hash] = stored.split('$');
  const want = Buffer.from(hash ?? '', 'base64');
  const got = await scrypt(password, Buffer.from(salt ?? '', 'base64'), KEY_LENGTH);
  return want.length === got.length && timingSafeEqual(want, got);
};

// Compared against when the email is unknown, so a miss takes as long as a wrong password.
const DECOY = hashPassword(randomUUID());

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

const startSession = async (sql: Sql, userId: string) => {
  const token = randomBytes(32).toString('base64url');
  await sql(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [tokenHash(token), userId]);
  return token;
};

/** Inputs arrive already validated and normalized by the HTTP boundary. */
export const signUp = async (sql: Sql, input: { email: string; password: string; company: string }) => {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const passwordHash = await hashPassword(input.password);
  const rows = await sql(
    `WITH w AS (INSERT INTO workspaces (id, name) VALUES ($1, $2) RETURNING id)
     INSERT INTO users (id, email, password_hash, workspace_id) SELECT $4, $3, $5, id FROM w ON CONFLICT (email) DO NOTHING RETURNING id`,
    [workspaceId, input.company, input.email, userId, passwordHash],
  );
  if (!rows.length) {
    // The workspace insert ran even though the user insert did not.
    await sql(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    throw new AccountError('email_taken', 'An account with this email already exists. Log in instead.');
  }
  return { token: await startSession(sql, userId), account: { email: input.email, name: '', workspace: { id: workspaceId, name: input.company } } };
};

const ACCOUNT = `SELECT u.id, u.email, u.name, u.password_hash, w.id AS workspace_id, w.name AS workspace_name FROM users u JOIN workspaces w ON w.id = u.workspace_id`;
const toAccount = (row: Row): Account => ({ email: row.email as string, name: row.name as string, workspace: { id: row.workspace_id as string, name: row.workspace_name as string } });

/** Both logging in and changing a password check a password, so both count towards the same lockout. */
const checkPassword = async (sql: Sql, email: string, password: string, stored: string | undefined) => {
  const [{ n }] = await sql(`SELECT count(*)::int AS n FROM login_failures WHERE email = $1 AND at > now() - interval '${FAILURE_WINDOW}'`, [email]);
  if ((n as number) >= MAX_FAILURES) throw new AccountError('throttled', 'Too many attempts. Wait 15 minutes, then try again.');
  const ok = await passwordMatches(password, stored ?? await DECOY);
  if (ok && stored) {
    await sql(`DELETE FROM login_failures WHERE email = $1`, [email]);
    return true;
  }
  await sql(`DELETE FROM login_failures WHERE email = $1 AND at < now() - interval '1 day'`, [email]);
  await sql(`INSERT INTO login_failures (email) VALUES ($1)`, [email]);
  return false;
};

export const logIn = async (sql: Sql, input: { email: string; password: string }) => {
  const [user] = await sql(`${ACCOUNT} WHERE u.email = $1`, [input.email]);
  if (!await checkPassword(sql, input.email, input.password, user?.password_hash as string | undefined)) {
    throw new AccountError('bad_login', "That email and password don't match an account.");
  }
  return { token: await startSession(sql, user.id as string), account: toAccount(user) };
};

export type Session = { userId: string; account: Account };
export const sessionFor = async (sql: Sql, token: string): Promise<Session | null> => {
  const [row] = await sql(`${ACCOUNT} JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = $1 AND s.expires_at > now()`, [tokenHash(token)]);
  return row ? { userId: row.id as string, account: toAccount(row) } : null;
};

/** Inputs arrive validated and trimmed. A field left out stays as it was. */
export const updateProfile = async (sql: Sql, userId: string, input: { name?: string; company?: string }) => {
  if (input.name !== undefined) await sql(`UPDATE users SET name = $2 WHERE id = $1`, [userId, input.name]);
  if (input.company !== undefined) await sql(`UPDATE workspaces SET name = $2 WHERE id = (SELECT workspace_id FROM users WHERE id = $1)`, [userId, input.company]);
  const [row] = await sql(`${ACCOUNT} WHERE u.id = $1`, [userId]);
  return toAccount(row);
};

/** Signs out every other session, so a password changed after a leak locks the other holder out. */
export const changePassword = async (sql: Sql, userId: string, token: string, input: { current: string; next: string }) => {
  const [row] = await sql(`${ACCOUNT} WHERE u.id = $1`, [userId]);
  if (!await checkPassword(sql, row.email as string, input.current, row.password_hash as string)) {
    throw new AccountError('wrong_password', "That isn't your current password.");
  }
  await sql(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, await hashPassword(input.next)]);
  await sql(`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`, [userId, tokenHash(token)]);
};

export const logOut = async (sql: Sql, token: string) => {
  await sql(`DELETE FROM sessions WHERE token_hash = $1 OR expires_at < now()`, [tokenHash(token)]);
};
