import { createServer } from 'node:http';
import { claudeApi, claudeCli } from '../src/llm.ts';
import { handleRead } from '../src/read-service.ts';

const PORT = 4321;
const api = !!process.env.ANTHROPIC_API_KEY;
const deps = { llm: api ? claudeApi() : claudeCli(), accessCode: process.env.DEMO_ACCESS_CODE ?? 'local' };

createServer((req, res) => {
  if (new URL(req.url ?? '/', 'http://localhost').pathname === '/api/read') return void handleRead(req, res, deps);
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => console.log(`Read API on http://127.0.0.1:${PORT}, using ${api ? 'the Messages API' : 'the signed-in claude CLI'}`));
