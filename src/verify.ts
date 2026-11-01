import { USER_STATUSES, USER_TYPES, writeIntent, type Field, type Manifest, type Pagination, type RequestSpec, type StreamConfig } from './manifest.ts';
import { arrayItems, findOperation, isOpenSchema, propertyPaths, schemaAt, type ApiSpec } from './spec.ts';

export type Severity = 'block' | 'review' | 'info';
export type Finding = { severity: Severity; code: string; message: string; where: string };

export type Source = {
  kind: 'spec' | 'docs';
  /** Where the customer pointed us. Null for pasted text, which has no domain to trust. */
  origin: string | null;
  spec: ApiSpec | null;
  promptText: string;
  corpus: string;
  warnings: string[];
};

export const normalizeForQuote = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// shortcut: covers common two-part suffixes only. Use the Public Suffix List in production.
const TWO_PART = /\.(co|com|org|net|ac|gov)\.[a-z]{2}$/;
export const registrableDomain = (host: string) => {
  const labels = host.toLowerCase().split('.');
  return labels.slice(TWO_PART.test(host.toLowerCase()) ? -3 : -2).join('.');
};

const VARIABLE = 'xvariablex';

const parseHost = (url: string) => {
  try {
    return new URL(url.replace(/\{+[^}]+\}+/g, VARIABLE));
  } catch {
    return null;
  }
};

const hostOf = (url: string) => parseHost(url)?.hostname ?? null;

type Check = { findings: Finding[]; m: Manifest; source: Source; normalized: string };
const add = (c: Check, severity: Severity, code: string, where: string, message: string) => c.findings.push({ severity, code, where, message });

const checkHost = (c: Check, where: string, url: string) => {
  if (!/^https:\/\//.test(url)) return add(c, 'block', 'not_https', where, `${url} must use https.`);
  if (url.includes('{{')) return add(c, 'block', 'bad_url', where, `${url} must use {name} for a host setting, not {{...}}.`);
  const parsed = parseHost(url);
  if (!parsed) return add(c, 'block', 'bad_url', where, `${url} is not a valid URL.`);
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return add(c, 'block', 'bad_url', where, `${url} must not carry a query, fragment or login, because they can hide the real host.`);
  if (registrableDomain(parsed.hostname).includes(VARIABLE)) {
    return add(c, 'block', 'host_is_variable', where, `${url} lets a setting choose the host. Fix the vendor domain, like https://{subdomain}.vendor.com.`);
  }
  const labels = parsed.hostname.split('.');
  const host = labels.slice(labels.findLastIndex(l => l.includes(VARIABLE)) + 1).join('.');
  if (/^[\d.]+$/.test(host) || host.includes('[')) return add(c, 'block', 'host_is_ip', where, 'Hosts must be names, not IP addresses.');
  const declared = (c.source.spec?.servers ?? []).map(s => hostOf(s)).filter(Boolean) as string[];
  const inSource = declared.some(d => d === host || d.endsWith(`.${host}`)) || c.normalized.includes(normalizeForQuote(host));
  if (!inSource) return add(c, 'block', 'host_undeclared', where, `${host} does not appear anywhere in the source.`);
  const originHost = c.source.origin ? hostOf(c.source.origin) : null;
  if (!originHost) return add(c, 'review', 'host_unverified', where, `No docs URL to compare against. Confirm ${host} really belongs to this vendor.`);
  if (registrableDomain(originHost) !== registrableDomain(host)) {
    add(c, 'review', 'host_domain_mismatch', where, `Docs are on ${registrableDomain(originHost)} but the connector calls ${host}. Confirm this is the vendor's own domain, because credentials will be sent there.`);
  }
};

const TEMPLATE = /\{\{\s*([\w.]+)\s*\}\}/g;

const checkTemplates = (c: Check, where: string, text: string, scope: Set<string>) => {
  for (const [, ref] of text.matchAll(TEMPLATE)) {
    const root = ref.split('.')[0];
    if (root === 'context' || root === 'connection') {
      if (!scope.has(ref)) add(c, 'block', 'unbound_template', where, `{{${ref}}} is never set.`);
    } else if (!scope.has(root)) {
      add(c, 'block', 'unbound_template', where, `{{${ref}}} is not available here.`);
    }
  }
};

const checkRequest = (c: Check, where: string, req: RequestSpec, scope: Set<string>) => {
  checkTemplates(c, `${where}.path`, req.path, scope);
  for (const v of Object.values(req.query)) checkTemplates(c, `${where}.query`, v, scope);
  if (/\{(?!\{)[^}]*\}/.test(req.path.replace(TEMPLATE, ''))) add(c, 'block', 'unbound_path_param', where, `${req.path} has a path parameter with no value. Bind it with {{...}}.`);
  if (req.method === 'POST') {
    if (!req.readOnlyPostReason) add(c, 'block', 'write_method', where, 'POST needs a stated read-only reason.');
    else add(c, 'review', 'read_only_post', where, `Uses POST to read data: ${req.readOnlyPostReason}. Confirm this changes nothing.`);
    if (/(delete|remove|create|update|deactivate|suspend|invite|revoke|provision)/i.test(req.path)) add(c, 'block', 'write_path', where, `${req.path} looks like a write.`);
  }
  const write = writeIntent(req, c.m.extraHeaders);
  if (write) add(c, 'block', 'write_intent', where, `${write}.`);
  const action = req.path.replace(TEMPLATE, '').split(/[/?.]/).filter(Boolean).at(-1) ?? '';
  if (req.method === 'GET' && /^(delete|remove|create|update|deactivate|suspend|invite|revoke|provision|add|set|disable|enable)([_-]|$)/i.test(action)) add(c, 'block', 'write_path', where, `${req.path} looks like a write, even as a GET.`);
  const op = c.source.spec ? findOperation(c.source.spec, req.method, req.path.replace(TEMPLATE, '{x}')) : null;
  if (c.source.spec) {
    if (!op) {
      add(c, 'block', 'op_not_in_spec', where, `${req.method} ${req.path} is not in the API spec.`);
      return null;
    }
    if (op.deprecated) add(c, 'review', 'op_deprecated', where, `${req.method} ${req.path} is deprecated.`);
    const known = new Set(op.parameters.map(p => p.name));
    for (const k of Object.keys(req.query)) if (!known.has(k)) add(c, 'review', 'param_unknown', where, `Query parameter "${k}" is not listed in the spec.`);
    // A required credential parameter, like Slack's ?token=, is supplied by the auth method, not the request.
    const fromAuth = new Set([...c.m.authMethods.flatMap(a => (a.type === 'api_key' && a.in === 'query' ? [a.name] : [])), 'token', 'access_token', 'api_key', 'apikey', 'auth_token']);
    for (const p of op.parameters) {
      if (p.required && p.in === 'query' && !(p.name in req.query) && !fromAuth.has(p.name.toLowerCase())) add(c, 'block', 'param_required', where, `Required query parameter "${p.name}" is missing.`);
    }
    return op;
  }
  const lastStatic = req.path.replace(TEMPLATE, '').split(/[/?]/).filter(Boolean).at(-1);
  if (lastStatic && !c.normalized.includes(normalizeForQuote(lastStatic))) add(c, 'block', 'op_not_in_docs', where, `${req.path} does not appear in the docs.`);
  return null;
};

const paginationParams = (p: Pagination): string[] => ({
  none: [], cursor: p.type === 'cursor' ? [p.cursorParam, p.sizeParam] : [],
  next_url: p.type === 'next_url' ? [p.sizeParam] : [], link_header: p.type === 'link_header' ? [p.sizeParam] : [],
  offset: p.type === 'offset' ? [p.offsetParam, p.limitParam] : [],
  page_number: p.type === 'page_number' ? [p.pageParam, p.sizeParam] : [],
}[p.type] as (string | null)[]).filter((x): x is string => !!x);

const paginationBodyPaths = (p: Pagination): [string, boolean][] => {
  if (p.type === 'cursor') return [[p.cursorPath, true], ...(p.hasMorePath ? [[p.hasMorePath, false] as [string, boolean]] : [])];
  if (p.type === 'next_url') return [[p.urlPath, true]];
  if (p.type === 'offset') return [[p.totalPath, false], [p.hasMorePath, false]].filter(([x]) => x) as [string, boolean][];
  if (p.type === 'page_number') return [[p.totalPagesPath, false], [p.hasMorePath, false]].filter(([x]) => x) as [string, boolean][];
  return [];
};

const checkField = (c: Check, where: string, item: unknown, field: Field | null, severity: Severity) => {
  if (!field || isOpenSchema(item)) return;
  const paths = [field.path, ...(field.fallbackPaths ?? [])];
  const hits = paths.map(p => schemaAt(item, p)).filter(s => s !== undefined);
  if (!hits.length) return add(c, severity, 'field_not_in_schema', where, `"${paths.join('" or "')}" is not in the response schema.`);
  const type = (hits[0] as { type?: unknown }).type;
  if (/At$/.test(where) && !field.format && (type === 'integer' || type === 'number')) {
    add(c, 'block', 'timestamp_format', where, `"${field.path}" is numeric, so set format to epoch_seconds or epoch_millis.`);
  }
};

const PAGING_PARAM = /^(page|page_?token|page_?number|offset|start_?at|cursor|after|next|starting_after|marker|skip)$/i;
// /user/... and /me describe whoever holds the token, never everyone on the account.
const CALLER_SCOPED = /^\/(user|me)(\/|$)|\/me\/?$/i;

const checkStream = (c: Check, where: string, s: StreamConfig, scope: Set<string>) => {
  if (where === 'users' && CALLER_SCOPED.test(s.request.path.replace(TEMPLATE, '{x}'))) {
    add(c, 'block', 'caller_scoped_users', `${where}.request`, `${s.request.path} describes the signed-in caller, not everyone on the account. Use the admin or organization member listing.`);
  }
  const op = checkRequest(c, `${where}.request`, s.request, scope);
  if (!op) return;
  const known = new Set(op.parameters.map(p => p.name));
  for (const p of paginationParams(s.pagination)) if (!known.has(p)) add(c, 'review', 'param_unknown', `${where}.pagination`, `Pagination parameter "${p}" is not listed in the spec.`);
  const schema = op.responseSchema;
  if (isOpenSchema(schema)) return add(c, 'review', 'schema_missing', where, 'The spec has no response schema here, so field mappings are unproven until the live probe.');
  const records = schemaAt(schema, s.recordsPath);
  if (records === undefined) return add(c, 'block', 'records_path_missing', `${where}.recordsPath`, `"${s.recordsPath}" is not in the response schema.`);
  const item = arrayItems(records);
  if (item === undefined) return add(c, 'block', 'records_not_array', `${where}.recordsPath`, `"${s.recordsPath}" is not a list.`);
  if (s.pagination.type === 'offset' && /page/i.test(s.pagination.offsetParam)) {
    add(c, 'block', 'offset_is_page_number', `${where}.pagination`, `"${s.pagination.offsetParam}" counts pages, not rows. Use page_number, because treating it as an offset would skip users.`);
  }
  // Asana-style: the response hands back the next "offset" as an opaque token, so it's a cursor, not a row count.
  const handedBack = s.pagination.type === 'offset' ? propertyPaths(schema).find(p => p.includes('.') && p.endsWith(`.${(s.pagination as { offsetParam: string }).offsetParam}`)) : undefined;
  if (handedBack) {
    add(c, 'block', 'offset_is_cursor', `${where}.pagination`, `The response returns the next value at "${handedBack}". That makes it a cursor: use type cursor, cursorPath "${handedBack}", cursorParam "${(s.pagination as { offsetParam: string }).offsetParam}".`);
  }
  const pagingParam = op.parameters.find(p => p.in === 'query' && PAGING_PARAM.test(p.name));
  if (where === 'users' && s.pagination.type === 'none' && pagingParam) {
    add(c, 'block', 'paging_ignored', `${where}.pagination`, `The spec pages this list with "${pagingParam.name}", so one request would miss people. Set the pagination it documents.`);
  }
  for (const [path, required] of paginationBodyPaths(s.pagination)) {
    if (schemaAt(schema, path) === undefined) add(c, required ? 'block' : 'review', 'pagination_path_missing', `${where}.pagination`, `"${path}" is not in the response schema.`);
  }
  for (const [name, field] of Object.entries(s.fields)) {
    if (field && typeof field === 'object') checkField(c, `${where}.fields.${name}`, item, field, name === 'externalId' || name === 'userRef' ? 'block' : 'review');
  }
};

const checkEvidence = (c: Check) => {
  const { m } = c;
  const claims = new Set<string>();
  for (const cite of m.evidence) {
    const quote = normalizeForQuote(cite.quote);
    if (quote && c.normalized.includes(quote)) claims.add(cite.claim);
    else add(c, 'block', 'quote_not_found', 'evidence', `The ${cite.claim} citation is not in the source: "${cite.quote.slice(0, 80)}"`);
  }
  if (!claims.has('auth')) add(c, 'review', 'uncited_auth', 'authMethods', 'Auth has no supporting quote from the source.');
  if (m.users.pagination.type !== 'none' && !claims.has('pagination')) add(c, 'review', 'uncited_pagination', 'users.pagination', 'Pagination has no supporting quote from the source.');
  if (!claims.has('rate_limit') && !m.rateLimit.maxRequestsPerMinute) add(c, 'review', 'rate_limit_unknown', 'rateLimit', 'The source gives no rate limit, so the connector relies on backoff alone.');
  for (const a of m.assumptions) add(c, 'review', 'assumption', 'assumptions', a);
};

const checkAuth = (c: Check) => {
  const spec = c.source.spec;
  for (const [i, a] of c.m.authMethods.entries()) {
    const where = `authMethods[${i}]`;
    if (a.type === 'oauth2_client_credentials' || a.type === 'oauth2_authorization_code') {
      checkHost(c, `${where}.tokenUrl`, a.tokenUrl);
      const declared = spec?.authSchemes.flatMap(s => (s.tokenUrl ? [s.tokenUrl] : [])) ?? [];
      // Specs often give the token URL relative to the API host, like /oauth2/v1/token.
      if (declared.length && !declared.some(d => d === a.tokenUrl || (d.startsWith('/') && URL.canParse(a.tokenUrl) && new URL(a.tokenUrl).pathname === d))) add(c, 'block', 'token_url_mismatch', where, `Token URL differs from the spec: ${declared.join(', ')}.`);
      const known = new Set(spec?.authSchemes.flatMap(s => s.scopes) ?? []);
      if (known.size) for (const s of a.scopes) if (!known.has(s)) add(c, 'review', 'scope_unknown', where, `Scope "${s}" is not in the spec.`);
    }
    if (a.type === 'oauth2_authorization_code') checkHost(c, `${where}.authorizeUrl`, a.authorizeUrl);
    if (a.type === 'api_key' && spec) {
      const names = spec.authSchemes.filter(s => s.type === 'apiKey').map(s => s.paramName?.toLowerCase());
      if (names.length && !names.includes(a.name.toLowerCase())) add(c, 'block', 'api_key_name_mismatch', where, `The spec names the key "${names.join(', ')}", not "${a.name}".`);
    }
  }
};

export const verifyManifest = (m: Manifest, source: Source): Finding[] => {
  const c: Check = { findings: [], m, source, normalized: normalizeForQuote(source.corpus) };

  checkHost(c, 'baseUrl', m.baseUrl);
  const hostVars = [...m.baseUrl.matchAll(/\{(\w+)\}/g)].map(x => x[1]);
  const declaredVars = new Set(m.connectionFields.map(f => f.name));
  for (const v of hostVars) if (!declaredVars.has(v)) add(c, 'block', 'unbound_template', 'baseUrl', `{${v}} has no connection field.`);
  for (const header of Object.keys(m.extraHeaders)) {
    if (/^(authorization|cookie|host|proxy-|x-forwarded|.*(token|secret|key|auth))/i.test(header)) add(c, 'block', 'sensitive_header', `extraHeaders.${header}`, 'Credentials may only be set by the auth method.');
    else if (!/^(accept|content-type|user-agent|.*version)$/i.test(header)) add(c, 'review', 'extra_header', `extraHeaders.${header}`, `Every request sends the header ${header}. Confirm the vendor documents it.`);
  }
  checkAuth(c);

  const scope = new Set(m.connectionFields.map(f => `connection.${f.name}`));
  for (const [i, step] of m.context.entries()) {
    const op = checkRequest(c, `context[${i}]`, step.request, scope);
    for (const [key, path] of Object.entries(step.extract)) {
      if (op && !isOpenSchema(op.responseSchema) && schemaAt(op.responseSchema, path) === undefined) {
        add(c, 'block', 'context_path_missing', `context[${i}].extract.${key}`, `"${path}" is not in the response schema.`);
      }
      scope.add(`context.${key}`);
    }
  }
  checkStream(c, 'users', m.users, scope);

  const f = m.users.fields;
  for (const [name, field, allowed] of [['status', f.status, USER_STATUSES], ['userType', f.userType, USER_TYPES]] as const) {
    for (const v of Object.values(field?.map ?? {})) {
      if (!(allowed as readonly string[]).includes(v)) add(c, 'block', 'bad_enum_value', `users.fields.${name}`, `"${v}" is not one of ${allowed.join(', ')}.`);
    }
  }
  if (!f.email) add(c, 'review', 'no_email', 'users.fields.email', 'No email field. Matching people across apps will be weak.');

  const u = m.usage;
  if (u.kind === 'unavailable') add(c, 'info', 'usage_gap', 'usage', `No usage data: ${u.reason}`);
  if (u.kind === 'last_activity_field' && !f.lastActiveAt) add(c, 'block', 'usage_field_missing', 'usage', 'Usage says last activity comes from the user record, but lastActiveAt is not mapped.');
  if (u.kind === 'event_log' || u.kind === 'aggregate_report') {
    const usageScope = new Set(scope);
    if (u.forEachUser) {
      usageScope.add('user');
      add(c, 'review', 'fan_out', 'usage', 'Usage needs one call per user, which spends rate limit quickly on large accounts.');
    }
    if (u.window) usageScope.add('window');
    checkStream(c, 'usage', u, usageScope);
    if (u.planRequirement) add(c, 'info', 'plan_gate', 'usage', `Usage needs this plan: ${u.planRequirement}. Users still sync on lower plans.`);
    if (u.fields.userRefType === 'externalId' && !u.forEachUser && !f.externalId) add(c, 'block', 'usage_unjoinable', 'usage', 'Usage cannot be joined to users.');
  }
  if (m.users.planRequirement) add(c, 'review', 'users_plan_gate', 'users', `User listing needs ${m.users.planRequirement}.`);

  checkEvidence(c);
  for (const w of source.warnings) add(c, 'review', 'source_suspicious', 'source', w);
  return c.findings;
};

export const isBlocked = (findings: Finding[]) => findings.some(f => f.severity === 'block');
