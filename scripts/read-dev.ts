import { createServer } from 'node:http';
import { handleApp } from '../src/app-service.ts';
import { migrate, neonSql, pgliteSql } from '../src/db.ts';
import { claudeCli, codexCli, llmFromEnv } from '../src/llm.ts';
import { handleRead } from '../src/read-service.ts';

const PORT = Number(process.env.READ_PORT ?? 4321);
const codex = process.env.READ_LLM === 'codex';
const hosted = codex ? null : llmFromEnv();
const using = codex ? 'the signed-in codex CLI'
  : hosted ? (process.env.OPENAI_MODEL && process.env.OPENAI_API_KEY ? `OpenAI ${process.env.OPENAI_MODEL}` : 'the Messages API') : 'the signed-in claude CLI';
const deps = { llm: codex ? codexCli() : hosted ?? claudeCli() };
// Neon when DATABASE_URL is set, otherwise a Postgres kept in .data/ so accounts survive restarts.
const db = (process.env.DATABASE_URL ? neonSql(process.env.DATABASE_URL) : pgliteSql('.data/pglite')).then(async sql => { await migrate(sql); return sql; });

createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/api/read') return void handleRead(req, res, deps);
  if (path.startsWith('/api/')) return void handleApp(req, res, { db });
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => console.log(`API on http://127.0.0.1:${PORT}. Reads use ${using}. Accounts use ${process.env.DATABASE_URL ? 'DATABASE_URL' : '.data/pglite'}.`));
