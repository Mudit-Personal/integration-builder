import { createServer } from 'node:http';
import { claudeApi, claudeCli, codexCli } from '../src/llm.ts';
import { handleRead } from '../src/read-service.ts';

const PORT = Number(process.env.READ_PORT ?? 4321);
const codex = process.env.READ_LLM === 'codex';
const api = !codex && !!process.env.ANTHROPIC_API_KEY;
const deps = { llm: codex ? codexCli() : api ? claudeApi() : claudeCli() };
const using = codex ? 'the signed-in codex CLI' : api ? 'the Messages API' : 'the signed-in claude CLI';

createServer((req, res) => {
  if (new URL(req.url ?? '/', 'http://localhost').pathname === '/api/read') return void handleRead(req, res, deps);
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => console.log(`Read API on http://127.0.0.1:${PORT}, using ${using}`));
