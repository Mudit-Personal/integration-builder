import { parse as parseYaml } from 'yaml';
import { normalizePath } from './manifest.ts';

export type SpecParam = { name: string; in: string; required: boolean };
export type SpecOperation = {
  method: string; path: string; summary: string; description: string;
  parameters: SpecParam[]; responseSchema: unknown; scopes: string[]; deprecated: boolean;
};
export type SpecAuthScheme = { name: string; type: string; scheme?: string; in?: string; paramName?: string; tokenUrl?: string; authorizeUrl?: string; scopes: string[]; description: string };
export type ApiSpec = {
  title: string; version: string; format: 'openapi3' | 'swagger2' | 'postman';
  servers: string[]; authSchemes: SpecAuthScheme[]; operations: SpecOperation[]; description: string;
};

type Json = Record<string, any>;
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const MAX_DEREF_NODES = 40_000;

export const parseStructured = (text: string): unknown => {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) return undefined;
  try {
    return trimmed.startsWith('{') ? JSON.parse(trimmed) : parseYaml(trimmed, { maxAliasCount: 1000, logLevel: 'silent' });
  } catch {
    return undefined;
  }
};

/** Resolves $refs with cycle detection. The node budget keeps one wide schema in a 14 MB spec from exploding. */
const deref = (root: Json, node: unknown, budget = { nodes: MAX_DEREF_NODES }, seen: string[] = []): unknown => {
  if (node === null || typeof node !== 'object') return node;
  if (--budget.nodes < 0) return { type: 'object' };
  if (Array.isArray(node)) return node.map(n => deref(root, n, budget, seen));
  const obj = node as Json;
  if (typeof obj.$ref === 'string') {
    if (seen.includes(obj.$ref)) return { type: 'object' };
    const target = obj.$ref.replace(/^#\//, '').split('/').reduce<any>((acc, k) => acc?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    return deref(root, target, budget, [...seen, obj.$ref]);
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k !== 'example' && k !== 'examples' && k !== 'x-examples') out[k] = deref(root, v, budget, seen);
  }
  return out;
};

const responseSchemaOf = (root: Json, op: Json, swagger: boolean): unknown => {
  const responses = (deref(root, op.responses) ?? {}) as Json;
  const key = Object.keys(responses).find(c => /^2/.test(c)) ?? 'default';
  const ok = responses[key];
  if (!ok) return undefined;
  if (swagger) return ok.schema;
  const content = ok.content ?? {};
  const media = Object.keys(content).find(c => c.includes('json')) ?? Object.keys(content)[0];
  return media ? content[media]?.schema : undefined;
};

const fromOpenApi = (root: Json, swagger: boolean): ApiSpec => {
  const schemesObj: Json = swagger ? root.securityDefinitions ?? {} : root.components?.securitySchemes ?? {};
  const authSchemes: SpecAuthScheme[] = Object.entries(schemesObj).flatMap(([name, raw]) => {
    const s = deref(root, raw) as Json | undefined;
    // A $ref into another file can't be resolved from here. Snowflake splits its specs this way.
    if (!s) return [];
    const flows = (s.flows ?? {}) as Json;
    const flow = (Object.values(flows)[0] ?? s) as Json;
    return [{
      name, type: s.type, scheme: s.scheme, in: s.in, paramName: s.name, tokenUrl: flow.tokenUrl, authorizeUrl: flow.authorizationUrl,
      scopes: Object.keys(flow.scopes ?? {}), description: String(s.description ?? '').slice(0, 800),
    }];
  });
  const servers = swagger
    ? root.host ? [`${(root.schemes ?? ['https'])[0]}://${root.host}${root.basePath ?? ''}`] : []
    : (root.servers ?? []).map((s: Json) => Object.entries<Json>(s.variables ?? {}).reduce(
        (url: string, [k, v]) => (k === 'basePath' || k === 'version' ? url.replace(`{${k}}`, v.default ?? '') : url), String(s.url)));
  const operations: SpecOperation[] = [];
  for (const [path, item] of Object.entries<Json>(root.paths ?? {})) {
    const shared = (item.parameters ?? []) as Json[];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const parameters = [...shared, ...(op.parameters ?? [])].map(p => deref(root, p) as Json)
        .filter(p => p?.name).map(p => ({ name: p.name, in: p.in, required: !!p.required }));
      const security = (op.security ?? root.security ?? []) as Json[];
      operations.push({
        method: method.toUpperCase(), path, summary: String(op.summary ?? ''), description: String(op.description ?? ''),
        parameters, scopes: [...new Set(security.flatMap(s => Object.values(s).flat() as string[]))],
        deprecated: !!op.deprecated,
        // Lazy, because resolving every response in a 14 MB spec takes far longer than the few we read.
        get responseSchema() { return responseSchemaOf(root, op, swagger); },
      });
    }
  }
  return {
    title: String(root.info?.title ?? 'Unknown API'), version: String(root.info?.version ?? ''),
    format: swagger ? 'swagger2' : 'openapi3', servers: servers.filter(Boolean), authSchemes, operations,
    description: String(root.info?.description ?? '').slice(0, 6000),
  };
};

const fromPostman = (root: Json): ApiSpec => {
  const operations: SpecOperation[] = [];
  const servers = new Set<string>();
  const visit = (items: Json[]) => {
    for (const item of items) {
      if (item.item) visit(item.item);
      const req = item.request;
      if (!req) continue;
      const raw = typeof req.url === 'string' ? req.url : req.url?.raw ?? '';
      const match = /^(?:\{\{[^}]+\}\}|https?:\/\/[^/]+)(\/[^?]*)?/.exec(raw);
      if (raw.startsWith('http') && match) servers.add(new URL(raw).origin);
      const path = (match?.[1] ?? '/').replace(/:(\w+)/g, '{$1}').replace(/\{\{(\w+)\}\}/g, '{$1}');
      const example = item.response?.find((r: Json) => String(r.code).startsWith('2'))?.body;
      let responseSchema: unknown;
      try { responseSchema = example ? schemaFromExample(JSON.parse(example)) : undefined; } catch { /* a non-JSON example gives no schema */ }
      operations.push({
        method: String(req.method ?? 'GET'), path, summary: String(item.name ?? ''), description: String(req.description ?? '').slice(0, 1500),
        parameters: (req.url?.query ?? []).map((q: Json) => ({ name: q.key, in: 'query', required: false })),
        responseSchema, scopes: [], deprecated: false,
      });
    }
  };
  visit(root.item ?? []);
  return {
    title: String(root.info?.name ?? 'Postman collection'), version: '', format: 'postman', servers: [...servers],
    authSchemes: root.auth ? [{ name: 'collection', type: String(root.auth.type), scopes: [], description: '' }] : [],
    operations, description: String(root.info?.description ?? '').slice(0, 6000),
  };
};

const schemaFromExample = (v: unknown): unknown => {
  if (Array.isArray(v)) return { type: 'array', items: v.length ? schemaFromExample(v[0]) : {} };
  if (v && typeof v === 'object') {
    return { type: 'object', properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, schemaFromExample(x)])) };
  }
  return { type: v === null ? 'null' : typeof v };
};

export const toApiSpec = (doc: unknown): ApiSpec | null => {
  if (!doc || typeof doc !== 'object') return null;
  const root = doc as Json;
  if (typeof root.openapi === 'string' && root.paths) return fromOpenApi(root, false);
  if (String(root.swagger ?? '').startsWith('2') && root.paths) return fromOpenApi(root, true);
  if (String(root.info?.schema ?? '').includes('postman') && root.item) return fromPostman(root);
  return null;
};

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Handles composition keywords so a field behind allOf or oneOf still resolves. */
const propertiesOf = (schema: unknown): Json => {
  const s = (schema ?? {}) as Json;
  const merged: Json = { ...(s.properties ?? {}) };
  // Slack writes a union as a list under "items" with no array type.
  for (const key of ['allOf', 'oneOf', 'anyOf', 'items']) {
    for (const part of asList(s[key])) Object.assign(merged, propertiesOf(part));
  }
  return merged;
};

const itemsOf = (schema: unknown): unknown => {
  const s = (schema ?? {}) as Json;
  if (s.items && !Array.isArray(s.items)) return s.items;
  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    for (const part of asList(s[key])) {
      const found = itemsOf(part);
      if (found) return found;
    }
  }
  return undefined;
};

export const isOpenSchema = (schema: unknown): boolean => {
  const s = schema as Json | undefined;
  return !s || (Object.keys(propertiesOf(s)).length === 0 && !s.items && !s.additionalProperties && !['string', 'number', 'integer', 'boolean'].includes(s.type));
};

export const schemaAt = (schema: unknown, rawPath: string): unknown => {
  const path = normalizePath(rawPath);
  if (path === '$') return schema;
  const index = /^\d+(?:\.(.+))?$/.exec(path);
  if (index) return index[1] ? schemaAt(itemsOf(schema), index[1]) : itemsOf(schema);
  const props = propertiesOf(schema);
  if (path in props) return props[path];
  for (let i = path.lastIndexOf('.'); i > 0; i = path.lastIndexOf('.', i - 1)) {
    const head = path.slice(0, i);
    if (head in props) return schemaAt(props[head], path.slice(i + 1));
  }
  return undefined;
};

export const arrayItems = (schema: unknown) => itemsOf(schema);

/** Dotted paths to every named property, a few levels deep, without stepping into lists. */
export const propertyPaths = (schema: unknown, depth = 3, prefix = ''): string[] =>
  depth === 0 ? [] : Object.entries(propertiesOf(schema)).flatMap(([k, v]) => [`${prefix}${k}`, ...propertyPaths(v, depth - 1, `${prefix}${k}.`)]);

export const samePathShape = (specPath: string, manifestPath: string) => {
  const norm = (p: string) => p.replace(/\{\{?[^}]+\}?\}/g, '{}').replace(/\/+$/, '').toLowerCase();
  return norm(specPath) === norm(manifestPath);
};

export const findOperation = (spec: ApiSpec, method: string, path: string) =>
  spec.operations.find(o => o.method === method && samePathShape(o.path, path))
  // Spec servers often carry a base path that the manifest kept in the path, or the reverse.
  ?? spec.operations.find(o => o.method === method && (samePathShape(o.path, path.replace(/^\/[^/]+/, '')) || samePathShape(o.path.replace(/^\/[^/]+/, ''), path)));

const PEOPLE_SIGNALS: [RegExp, number][] = [
  [/\b(list|get|search|all)\b.*\b(users?|members?|memberships?|accounts?|people|employees|seats|licen[cs]es?|collaborators?|agents?|teammates?)\b/i, 12],
  [/\/(users?|members?|memberships?|people|seats|licen[cs]es?|agents?|admins?)(\.list|\/search)?\/?$/i, 12],
  [/\/(users?|members?)[./]/i, 3],
  [/\/(me|whoami|current|self|organi[sz]ations?|orgs?|workspaces?|tenants?|teams?)\/?$/i, 3],
];
const USAGE_SIGNALS: [RegExp, number][] = [
  [/\b(audit|activity|activities|sign.?ins?|logins?|access.?logs?|usage|analytics|last.?active)\b/i, 12],
  [/\/(audit|logs?|events?|reports?)[-_/]?/i, 6],
];

const scoreOp = (op: SpecOperation, signals: [RegExp, number][]) => {
  if (op.deprecated) return -5;
  const text = `${op.path} ${op.summary}`;
  const base = signals.reduce((sum, [re, w]) => sum + (re.test(text) ? w : 0), 0);
  // /orgs/{org}/members is a tenant-wide list, /users/{id}/events is about one person.
  const scopedToOnePerson = /\/(users?|members?|people|accounts?)\/\{/i.test(op.path) ? 8 : 0;
  const endsOnParam = /\}\/?$/.test(op.path) ? 8 : 0;
  const params = (op.path.match(/\{/g) ?? []).length;
  return (op.method === 'GET' ? base : base / 3) - params - scopedToOnePerson - endsOnParam;
};

const compact = (schema: unknown, depth: number): unknown => {
  const s = (schema ?? {}) as Json;
  if (depth > 5) return s.type ?? 'object';
  const items = itemsOf(s);
  if (items !== undefined) return [compact(items, depth + 1)];
  const props = propertiesOf(s);
  const keys = Object.keys(props);
  if (keys.length) return Object.fromEntries(keys.slice(0, 45).map(k => [k, compact(props[k], depth + 1)]));
  const type = Array.isArray(s.type) ? s.type.join('|') : s.type ?? 'any';
  return s.enum ? `${type} enum ${s.enum.slice(0, 12).join('|')}` : s.format ? `${type} ${s.format}` : type;
};

const HINT = /(rate.?limit|throttl|retry.?after|pagina|next.?page|next_cursor|cursor|enterprise|plan\b|subscription|authenticat|bearer|api.?key|scope)/i;

const hintLines = (spec: ApiSpec, ranked: SpecOperation[]) => {
  const pool = [spec.description, ...spec.authSchemes.map(s => s.description), ...ranked.map(o => o.description)];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const text of pool) {
    for (const line of text.split(/\n+/)) {
      const clean = line.trim().slice(0, 300);
      if (clean.length > 12 && HINT.test(clean) && !seen.has(clean)) { seen.add(clean); lines.push(clean); }
    }
  }
  return lines.slice(0, 60);
};

/** The model sees this digest, not the whole spec. GitHub's spec is 14 MB, so selection has to happen first. */
export const specDigest = (spec: ApiSpec, maxChars = 90_000) => {
  const top = (signals: [RegExp, number][], n: number) => [...spec.operations].sort((a, b) => scoreOp(b, signals) - scoreOp(a, signals)).slice(0, n);
  // Separate quotas, so hundreds of user endpoints cannot crowd out the one audit log.
  const ranked = [...new Set([...top(PEOPLE_SIGNALS, 25), ...top(USAGE_SIGNALS, 15)])];
  const out: string[] = [
    `API: ${spec.title} ${spec.version}`, `Format: ${spec.format}`, `Declared servers: ${spec.servers.join(', ') || 'none'}`,
    `Total operations: ${spec.operations.length}`, '', 'Auth schemes:', JSON.stringify(spec.authSchemes.map(s => ({ ...s, scopes: s.scopes.slice(0, 80) }))), '',
    'Documentation lines about auth, pagination, limits and plans:', ...hintLines(spec, ranked), '', 'Most relevant operations:',
  ];
  let size = out.join('\n').length;
  for (const op of ranked) {
    const entry = [
      `### ${op.method} ${op.path}`, op.summary, op.description.replace(/\s+/g, ' ').slice(0, 500),
      `params: ${op.parameters.map(p => `${p.name}(${p.in}${p.required ? ',required' : ''})`).join(' ')}`,
      `scopes: ${op.scopes.slice(0, 15).join(' ')}`,
      `response: ${JSON.stringify(compact(op.responseSchema, 0)).slice(0, 3500)}`, '',
    ].join('\n');
    if (size + entry.length > maxChars) break;
    size += entry.length;
    out.push(entry);
  }
  return out.join('\n');
};
