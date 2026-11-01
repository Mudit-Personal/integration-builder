import type { IncomingMessage, ServerResponse } from 'node:http';
import { llmFromEnv } from '../src/llm.ts';
import { handleRead } from '../src/read-service.ts';

const deps = { llm: llmFromEnv() };

export default (req: IncomingMessage, res: ServerResponse) => handleRead(req, res, deps);
