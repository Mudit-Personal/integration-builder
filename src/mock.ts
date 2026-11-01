import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Manifest } from './manifest.ts';
import { createVendor, type Fault, type Mock, type Reply } from './mock-core.ts';

export { setPath, synthUser, type Fault, type Mock, type PlainRequest, type Reply, type Route, type StartMock } from './mock-core.ts';

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

export const startMock = async (m: Manifest, fault: Fault = {}, authIndex = 0): Promise<Mock> => {
  const vendor = createVendor(m, fault, authIndex);
  const offsiteHits: Mock['offsiteHits'] = [];

  const offsite: Server = createServer((req, res) => {
    offsiteHits.push({ url: req.url ?? '', authorization: req.headers.authorization });
    res.end('{}');
  });
  await new Promise<void>(r => offsite.listen(0, '127.0.0.1', r));
  const offsiteOrigin = `http://127.0.0.1:${(offsite.address() as AddressInfo).port}`;

  const reply = (res: ServerResponse, r: Reply) => {
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
    res.end(r.body ?? '');
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const body = req.method === 'POST' ? await readBody(req) : null;
    const r = vendor.handle({ method: req.method ?? 'GET', url, headers: req.headers as Record<string, string>, body });
    if (r.hangMs) await new Promise(done => setTimeout(done, r.hangMs));
    reply(res, r);
  };
  const server = createServer((req, res) => { handler(req, res).catch(() => { res.statusCode = 500; res.end(); }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, offsiteOrigin, offsiteHits,
    requests: vendor.requests, credentials: vendor.credentials, connection: vendor.connection,
    stop: async () => {
      server.closeAllConnections();
      offsite.closeAllConnections();
      await Promise.all([server, offsite].map(s => new Promise(r => s.close(r))));
    },
  };
};
