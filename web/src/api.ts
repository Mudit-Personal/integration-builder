import type { SavedConnector } from './connectors.ts';
import type { AppPack } from './pack.ts';

export type Account = { email: string; name: string; workspace: { id: string; name: string } };
/** From the name when there is one (Ana de la Cruz is AC), otherwise the email (mudit.mittal@ is MM, sam@ is S). */
export const initialsOf = ({ email, name }: Pick<Account, 'email' | 'name'>) => {
  const words = name.trim() ? name.trim().split(/\s+/) : email.split('@')[0].split(/[^a-zA-Z]+/).filter(Boolean);
  return (words.length > 1 ? [words[0], words.at(-1)!] : words).map(w => [...w][0].toUpperCase()).join('') || '?';
};
export const displayName = (a: Account) => a.name.trim() || a.email;

export type Session = { kind: 'checking' } | { kind: 'out' } | { kind: 'in'; account: Account };
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const OFFLINE = "We couldn't reach Integration Builder. Check your connection and try again.";

const request = async <T>(method: string, path: string, body?: unknown): Promise<Outcome<T> & { status: number }> => {
  try {
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body === undefined && method === 'GET' ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, value: data as T, status: res.status } : { ok: false, error: data.error ?? OFFLINE, status: res.status };
  } catch {
    return { ok: false, error: OFFLINE, status: 0 };
  }
};

/** Signed out only when the server says so. A network failure throws, and the caller retries rather than throwing anyone out. */
export const currentSession = async (): Promise<Session> => {
  const r = await request<{ account: Account | null }>('GET', '/api/me');
  if (!r.ok) throw new Error(r.error);
  return r.value.account ? { kind: 'in', account: r.value.account } : { kind: 'out' };
};

const enter = async (path: string, body: object): Promise<Outcome<Account>> => {
  const r = await request<{ account: Account }>('POST', path, body);
  return r.ok ? { ok: true, value: r.value.account } : r;
};

export const signUp = (input: { email: string; password: string; company: string }) => enter('/api/signup', input);
export const logIn = (input: { email: string; password: string }) => enter('/api/login', input);
export const logOut = () => request('POST', '/api/logout', {});
export const updateProfile = async (input: { name: string; company: string }): Promise<Outcome<Account>> => {
  const r = await request<{ account: Account }>('PATCH', '/api/me', input);
  return r.ok ? { ok: true, value: r.value.account } : r;
};
export const changePassword = (input: { current: string; next: string }) => request('POST', '/api/me/password', input);

export type Workspace = { connectors: SavedConnector[]; packs: Record<string, AppPack> };
export const loadWorkspace = () => request<Workspace>('GET', '/api/connectors');
export const saveConnector = (connector: SavedConnector, pack: AppPack | null) => request('PUT', `/api/connectors/${connector.id}`, { connector, pack });
export const removeConnector = (id: string) => request('DELETE', `/api/connectors/${id}`, {});
