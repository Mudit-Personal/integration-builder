import { z } from 'zod';

export const SCHEMA_VERSION = 1;

const AuthBase = { label: z.string().min(1) };

const Scopes = z.array(z.string());

export const AuthMethod = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bearer'), ...AuthBase, headerName: z.string(), prefix: z.string() }),
  z.object({
    type: z.literal('api_key'), ...AuthBase,
    in: z.enum(['header', 'query']), name: z.string().min(1), prefix: z.string(),
  }),
  z.object({ type: z.literal('basic'), ...AuthBase, usernameLabel: z.string(), passwordLabel: z.string() }),
  z.object({
    type: z.literal('oauth2_client_credentials'), ...AuthBase,
    tokenUrl: z.string().url(), scopes: Scopes, clientAuth: z.enum(['basic', 'body']),
  }),
  z.object({
    type: z.literal('oauth2_authorization_code'), ...AuthBase,
    authorizeUrl: z.string().url(), tokenUrl: z.string().url(), scopes: Scopes,
  }),
]);
export type AuthMethod = z.infer<typeof AuthMethod>;

export const Pagination = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('cursor'),
    cursorPath: z.string(), cursorParam: z.string(),
    cursorIn: z.enum(['query', 'graphql_variable']).default('query'),
    hasMorePath: z.string().nullable().default(null),
    sizeParam: z.string().nullable(), pageSize: z.number().int().positive().nullable(),
  }),
  z.object({
    type: z.literal('next_url'),
    urlPath: z.string(),
    sizeParam: z.string().nullable(), pageSize: z.number().int().positive().nullable(),
  }),
  z.object({
    type: z.literal('link_header'),
    sizeParam: z.string().nullable(), pageSize: z.number().int().positive().nullable(),
  }),
  z.object({
    type: z.literal('offset'),
    offsetParam: z.string(), limitParam: z.string(), pageSize: z.number().int().positive(),
    totalPath: z.string().nullable(), hasMorePath: z.string().nullable(),
  }),
  z.object({
    type: z.literal('page_number'),
    pageParam: z.string(), sizeParam: z.string().nullable(), pageSize: z.number().int().positive().nullable(),
    startAt: z.number().int().min(0).max(1),
    totalPagesPath: z.string().nullable(), hasMorePath: z.string().nullable(),
  }),
]);
export type Pagination = z.infer<typeof Pagination>;

export const RequestSpec = z.object({
  method: z.enum(['GET', 'POST']),
  path: z.string().startsWith('/'),
  query: z.record(z.string(), z.string()),
  body: z.unknown().nullable(),
  readOnlyPostReason: z.string().nullable(),
});
export type RequestSpec = z.infer<typeof RequestSpec>;

/** Shared by the verifier and the runtime, so the request the checks passed is the one that runs. */
export const writeIntent = (req: RequestSpec, headers: Record<string, string>): string | null => {
  if (/\bmutation\b/i.test(JSON.stringify([req.path, req.query, req.body]))) return 'GraphQL mutations are not allowed';
  if (Object.keys(req.query).some(k => /^_?method$/i.test(k)) || Object.keys(headers).some(h => /method/i.test(h))) return 'A method override can turn a read into a write';
  return null;
};

const Field = z.object({
  path: z.string().min(1),
  fallbackPaths: z.array(z.string()).nullable(),
  map: z.record(z.string(), z.string()).nullable(),
  format: z.enum(['iso8601', 'epoch_seconds', 'epoch_millis']).nullable(),
});
export type Field = z.infer<typeof Field>;

const NullableField = Field.nullable();

const StreamBase = {
  request: RequestSpec,
  recordsPath: z.string().min(1),
  pagination: Pagination,
  requiredScopes: Scopes,
  planRequirement: z.string().nullable(),
};

export const USER_STATUSES = ['active', 'inactive', 'suspended', 'pending', 'deleted', 'unknown'] as const;
export const USER_TYPES = ['member', 'guest', 'service', 'unknown'] as const;

const UsersStream = z.object({
  ...StreamBase,
  fields: z.object({
    externalId: Field,
    email: NullableField,
    displayName: NullableField,
    status: NullableField,
    role: NullableField,
    userType: NullableField,
    lastActiveAt: NullableField,
    createdAt: NullableField,
  }),
});

const Window = z.object({
  startParam: z.string(), endParam: z.string().nullable(),
  format: z.enum(['iso8601', 'date', 'epoch_seconds', 'epoch_millis']),
  maxDays: z.number().int().positive().nullable(),
});

const UsageStream = z.discriminatedUnion('kind', [
  z.object({
    kind: z.enum(['event_log', 'aggregate_report']),
    ...StreamBase,
    forEachUser: z.boolean(),
    window: Window.nullable(),
    fields: z.object({
      userRef: Field,
      userRefType: z.enum(['externalId', 'email']),
      occurredAt: NullableField,
      metric: NullableField,
      metricConstant: z.string().nullable(),
      value: NullableField,
    }),
  }),
  z.object({ kind: z.literal('last_activity_field') }),
  z.object({ kind: z.literal('unavailable'), reason: z.string().min(1) }),
]);

const ContextStep = z.object({
  name: z.string().regex(/^[a-zA-Z_]\w*$/),
  request: RequestSpec,
  extract: z.record(z.string(), z.string()),
});

export const ConnectionField = z.object({
  name: z.string().regex(/^[a-zA-Z_]\w*$/),
  label: z.string(),
  example: z.string(),
});

export const Citation = z.object({
  claim: z.enum(['auth', 'pagination', 'rate_limit', 'users', 'usage', 'plan', 'errors']),
  quote: z.string().min(8),
});
export type Citation = z.infer<typeof Citation>;

export const Manifest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  app: z.object({
    name: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    apiVersion: z.string().nullable(),
  }),
  baseUrl: z.string().min(1),
  connectionFields: z.array(ConnectionField),
  authMethods: z.array(AuthMethod).min(1),
  extraHeaders: z.record(z.string(), z.string()),
  context: z.array(ContextStep),
  users: UsersStream,
  usage: UsageStream,
  errorEnvelope: z.object({
    successPath: z.string(),
    successValue: z.union([z.boolean(), z.string()]),
    messagePath: z.string().nullable(),
    rateLimitedCodes: z.array(z.string()),
    authCodes: z.array(z.string()),
  }).nullable(),
  rateLimit: z.object({
    maxRequestsPerMinute: z.number().positive().nullable(),
    remainingHeader: z.string().nullable(),
    resetHeader: z.string().nullable(),
    resetFormat: z.enum(['epoch_seconds', 'epoch_millis', 'delta_seconds']).nullable(),
  }),
  evidence: z.array(Citation),
  assumptions: z.array(z.string()),
});
export type Manifest = z.infer<typeof Manifest>;
export type UsersStream = Manifest['users'];
export type UsageStream = Manifest['usage'];
export type ActiveUsageStream = Extract<UsageStream, { kind: 'event_log' | 'aggregate_report' }>;
export type StreamConfig = UsersStream | ActiveUsageStream;

/** The form a person fills in for one auth method. Declared here so the UI, runtime and mock agree. */
export const credentialFields = (m: AuthMethod): { name: string; label: string; optional?: boolean }[] => {
  const table: Record<AuthMethod['type'], { name: string; label: string; optional?: boolean }[]> = {
    bearer: [{ name: 'token', label: m.label }],
    api_key: [{ name: 'apiKey', label: m.label }],
    basic: [
      { name: 'username', label: m.type === 'basic' ? m.usernameLabel : 'Username' },
      { name: 'password', label: m.type === 'basic' ? m.passwordLabel : 'Password' },
    ],
    oauth2_client_credentials: [{ name: 'clientId', label: 'Client ID' }, { name: 'clientSecret', label: 'Client secret' }],
    oauth2_authorization_code: [
      { name: 'accessToken', label: 'Access token' },
      { name: 'refreshToken', label: 'Refresh token', optional: true },
      { name: 'clientId', label: 'Client ID', optional: true },
      { name: 'clientSecret', label: 'Client secret', optional: true },
    ],
  };
  return table[m.type];
};

export const manifestJsonSchema = () => z.toJSONSchema(Manifest, { target: 'draft-7' });

/** [0].slug, $[0].slug and $.users are common ways to write a path from the response root. */
export const normalizePath = (rawPath: string) => rawPath.trim().replace(/\[(\d+)\]/g, '.$1').replace(/^\$(?=\.)/, '').replace(/^\./, '') || '$';
