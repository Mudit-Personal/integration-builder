import type { Manifest } from './manifest.ts';
import { createVendor, type Fault, type Mock } from './mock-core.ts';

const ORIGIN = 'https://vendor.sandbox.invalid';
const OFFSITE_ORIGIN = 'https://offsite.sandbox.invalid';

const hang = (ms: number, signal?: AbortSignal | null) => new Promise<void>((done, fail) => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); fail(signal.reason); }, { once: true });
});

/** Same vendor as startMock, behind a fetch that never leaves the page. Fake origins, so an escape would fail, not reach anything. */
export const startVirtualMock = async (m: Manifest, fault: Fault = {}, authIndex = 0): Promise<Mock> => {
  const vendor = createVendor(m, fault, authIndex);
  const offsiteHits: Mock['offsiteHits'] = [];

  const virtualFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init.headers));
    init.signal?.throwIfAborted();
    if (url.origin === OFFSITE_ORIGIN) {
      offsiteHits.push({ url: url.pathname + url.search, authorization: headers.authorization });
      return new Response('{}');
    }
    if (url.origin !== ORIGIN) throw new TypeError(`The sandbox has no route to ${url.origin}`);
    const r = vendor.handle({ method: init.method ?? 'GET', url, headers, body: init.body === undefined || init.body === null ? null : String(init.body) });
    if (r.hangMs) await hang(r.hangMs, init.signal);
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
  }) as typeof fetch;

  return {
    origin: ORIGIN, offsiteOrigin: OFFSITE_ORIGIN, offsiteHits, fetch: virtualFetch,
    requests: vendor.requests, credentials: vendor.credentials, connection: vendor.connection, stop: async () => {},
  };
};
