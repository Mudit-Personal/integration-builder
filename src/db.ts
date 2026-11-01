export type Row = Record<string, unknown>;
/** One parameterized statement in, rows out. Neon in production, PGlite for local dev and tests. */
export type Sql = (text: string, params?: unknown[]) => Promise<Row[]>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workspaces (id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_failures (email text NOT NULL, at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS login_failures_email_at ON login_failures (email, at)`,
  `CREATE TABLE IF NOT EXISTS connectors (
    id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    data jsonb NOT NULL, pack jsonb, updated_at bigint NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS connectors_workspace ON connectors (workspace_id)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT ''`,
];

/** Idempotent, so every cold start can run it. */
export const migrate = async (sql: Sql) => {
  for (const statement of SCHEMA) await sql(statement);
};

export const neonSql = async (url: string): Promise<Sql> => {
  const { neon } = await import('@neondatabase/serverless');
  const run = neon(url);
  return (text, params = []) => run.query(text, params) as Promise<Row[]>;
};

/** An in-process Postgres. A folder keeps data between runs; no folder keeps it in memory. */
export const pgliteSql = async (dir?: string): Promise<Sql> => {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dir) (await import('node:fs')).mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  return async (text, params = []) => (await db.query<Row>(text, params)).rows;
};
