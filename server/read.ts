import type { IncomingMessage, ServerResponse } from 'node:http';
import { claudeApi } from '../src/llm.ts';
import { handleRead } from '../src/read-service.ts';

const deps = { llm: process.env.ANTHROPIC_API_KEY ? claudeApi() : null };

export default (req: IncomingMessage, res: ServerResponse) => handleRead(req, res, deps);
