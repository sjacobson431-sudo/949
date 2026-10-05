export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8787';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setToken(t: string | null): void {
  token = t;
  try {
    // sessionStorage: survives reloads, dies with the tab. The token is useless once the vault auto-locks.
    if (t) sessionStorage.setItem('term.token', t);
    else sessionStorage.removeItem('term.token');
  } catch {
    /* storage unavailable */
  }
}

export function loadToken(): string | null {
  try {
    token = sessionStorage.getItem('term.token');
  } catch {
    token = null;
  }
  return token;
}

export function getToken(): string | null {
  return token;
}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  if (res.status === 401 && path !== '/api/vault/unlock') onUnauthorized?.();
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'ERROR', data?.message ?? String(data));
  return data as T;
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const put = <T = any>(p: string, b?: unknown) => api<T>('PUT', p, b ?? {});
export const patch = <T = any>(p: string, b?: unknown) => api<T>('PATCH', p, b ?? {});
export const del = <T = any>(p: string) => api<T>('DELETE', p);

/** Download a CSV endpoint with auth. */
export async function download(path: string, filename: string): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, 'ERROR', await res.text());
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
