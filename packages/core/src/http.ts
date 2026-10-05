import { TerminalError } from './errors';

export interface FetchJsonOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/** JSON fetch with timeout and retry on 429/5xx/network errors. */
export async function fetchJson<T>(url: string, o: FetchJsonOptions = {}): Promise<T> {
  const f = o.fetchImpl ?? fetch;
  const retries = o.retries ?? 2;
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 10_000);
    try {
      const res = await f(url, {
        method: o.method ?? 'GET',
        headers: { accept: 'application/json', ...(o.body ? { 'content-type': 'application/json' } : {}), ...o.headers },
        body: o.body ? JSON.stringify(o.body) : undefined,
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new TerminalError('PROVIDER_ERROR', `HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`);
      }
      return (await res.json()) as T;
    } catch (e) {
      last = e;
      if (e instanceof TerminalError) throw e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new TerminalError('PROVIDER_ERROR', `Request to ${new URL(url).host} failed: ${last instanceof Error ? last.message : String(last)}`);
}
