import { Manifest, type AuthMethod, type Pagination } from '../src/manifest.ts';

export const field = (path: string, extra: object = {}) => ({ path, fallbackPaths: null, map: null, format: null, ...extra });

export const makeManifest = (pagination: Pagination, auth: AuthMethod, overrides: Partial<Manifest> = {}): Manifest => Manifest.parse({
  schemaVersion: 1,
  app: { name: 'Acme', slug: 'acme', apiVersion: 'v1' },
  baseUrl: 'https://api.acme.test/v2',
  connectionFields: [],
  authMethods: [auth],
  extraHeaders: {},
  context: [{
    name: 'org',
    request: { method: 'GET', path: '/me', query: {}, body: null, readOnlyPostReason: null },
    extract: { orgId: 'resource.org' },
  }],
  users: {
    request: { method: 'GET', path: '/orgs/{{context.orgId}}/members', query: { state: 'all' }, body: null, readOnlyPostReason: null },
    recordsPath: 'data', pagination, requiredScopes: [], planRequirement: null,
    fields: {
      externalId: field('id'), email: field('profile.email'), displayName: field('profile.name'),
      status: field('state', { map: { enabled: 'active', disabled: 'suspended' } }), role: field('role'),
      userType: null, lastActiveAt: field('last_seen', { format: 'epoch_seconds' }), createdAt: field('created_at'),
    },
  },
  usage: {
    kind: 'event_log',
    request: { method: 'GET', path: '/audit', query: {}, body: null, readOnlyPostReason: null },
    recordsPath: 'data', pagination: { type: 'none' }, requiredScopes: [], planRequirement: 'Enterprise',
    forEachUser: false,
    window: { startParam: 'since', endParam: 'until', format: 'iso8601', maxDays: 30 },
    fields: { userRef: field('actor'), userRefType: 'externalId', occurredAt: field('at'), metric: field('action'), metricConstant: null, value: null },
  },
  errorEnvelope: null,
  rateLimit: { maxRequestsPerMinute: null, remainingHeader: null, resetHeader: null, resetFormat: null },
  evidence: [], assumptions: [],
  ...overrides,
});

const size = { sizeParam: 'limit', pageSize: 50 };
export const PAGINATIONS: Pagination[] = [
  { type: 'none' },
  { type: 'cursor', cursorPath: 'meta.next', cursorParam: 'cursor', cursorIn: 'query', hasMorePath: null, ...size },
  { type: 'cursor', cursorPath: 'meta.next', cursorParam: 'cursor', cursorIn: 'query', hasMorePath: 'meta.more', ...size },
  { type: 'next_url', urlPath: 'links.next', ...size },
  { type: 'next_url', urlPath: '@odata.nextLink', sizeParam: null, pageSize: null },
  { type: 'link_header', ...size },
  { type: 'offset', offsetParam: 'offset', limitParam: 'limit', pageSize: 50, totalPath: 'meta.total', hasMorePath: null },
  { type: 'offset', offsetParam: 'offset', limitParam: 'limit', pageSize: 50, totalPath: null, hasMorePath: null },
  { type: 'offset', offsetParam: 'offset', limitParam: 'limit', pageSize: 50, totalPath: null, hasMorePath: 'more' },
  { type: 'page_number', pageParam: 'page', sizeParam: 'per_page', pageSize: 20, startAt: 1, totalPagesPath: 'pages', hasMorePath: null },
  { type: 'page_number', pageParam: 'page', sizeParam: 'per_page', pageSize: 20, startAt: 0, totalPagesPath: null, hasMorePath: null },
];

export const AUTHS: AuthMethod[] = [
  { type: 'bearer', label: 'Token', headerName: 'Authorization', prefix: 'Bearer' },
  { type: 'bearer', label: 'Token', headerName: 'Authorization', prefix: 'Token token=' },
  { type: 'api_key', label: 'Key', in: 'header', name: 'X-Api-Key', prefix: '' },
  { type: 'api_key', label: 'Key', in: 'query', name: 'api_key', prefix: '' },
  { type: 'basic', label: 'Basic', usernameLabel: 'Email', passwordLabel: 'Token' },
  { type: 'oauth2_client_credentials', label: 'App', tokenUrl: 'https://auth.acme.test/token', scopes: ['read'], clientAuth: 'basic' },
  { type: 'oauth2_client_credentials', label: 'App', tokenUrl: 'https://auth.acme.test/token', scopes: [], clientAuth: 'body' },
  { type: 'oauth2_authorization_code', label: 'OAuth', authorizeUrl: 'https://auth.acme.test/authorize', tokenUrl: 'https://auth.acme.test/token', scopes: [] },
];
