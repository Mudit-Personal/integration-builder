import type { IncomingMessage, ServerResponse } from 'node:http';
import { llmFromEnv } from '../src/llm.ts';
import { handleRead } from '../src/read-service.ts';

const deps = { llm: llmFromEnv(), accessCode: process.env.DEMO_ACCESS_CODE };

export default (req: IncomingMessage, res: ServerResponse) => handleRead(req, res, deps);
