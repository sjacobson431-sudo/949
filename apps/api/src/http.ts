import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorMessage, isTerminalError, toWire, type ErrorCode } from '@term/core';
import { ZodError } from 'zod';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  public: boolean;
}

/** Raw response marker for non-JSON bodies (CSV downloads). */
export class Raw {
  constructor(
    readonly body: string,
    readonly contentType: string,
    readonly filename?: string,
  ) {}
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler, opts: { public?: boolean } = {}): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/:([a-zA-Z]+)/g, (_m, k) => (keys.push(k), '([^/]+)')) + '$',
    );
    this.routes.push({ method, pattern, keys, handler, public: !!opts.public });
  }

  get = (p: string, h: Handler, o?: { public?: boolean }) => this.add('GET', p, h, o);
  post = (p: string, h: Handler, o?: { public?: boolean }) => this.add('POST', p, h, o);
  put = (p: string, h: Handler, o?: { public?: boolean }) => this.add('PUT', p, h, o);
  patch = (p: string, h: Handler, o?: { public?: boolean }) => this.add('PATCH', p, h, o);
  delete = (p: string, h: Handler, o?: { public?: boolean }) => this.add('DELETE', p, h, o);

  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      return { route: r, params };
    }
    return null;
  }
}

const STATUS: Partial<Record<ErrorCode, number>> = {
  VAULT_LOCKED: 423,
  VAULT_NOT_INITIALIZED: 409,
  BAD_PASSWORD: 401,
  MODE_FORBIDDEN: 403,
  LIMIT_EXCEEDED: 403,
  NOT_WHITELISTED: 403,
  SELF_TRADE_BLOCKED: 409,
  PLAN_EXPIRED: 410,
  PLAN_MISMATCH: 409,
  PLAN_NOT_FOUND: 404,
  NOT_FOUND: 404,
  RISK_BLOCKED: 409,
  INSUFFICIENT_FUNDS: 409,
  VALIDATION: 400,
  RPC_UNAVAILABLE: 503,
  PROVIDER_ERROR: 502,
  TX_REJECTED: 422,
};

export function send(res: ServerResponse, status: number, body: unknown): void {
  if (body instanceof Raw) {
    res.writeHead(status, {
      'content-type': body.contentType,
      ...(body.filename ? { 'content-disposition': `attachment; filename="${body.filename}"` } : {}),
    });
    res.end(body.body);
    return;
  }
  const json = JSON.stringify(toWire(body ?? { ok: true }));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json);
}

export function sendError(res: ServerResponse, e: unknown): void {
  if (e instanceof ZodError) return send(res, 400, { error: 'VALIDATION', message: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  if (isTerminalError(e)) return send(res, STATUS[e.code] ?? 400, { error: e.code, message: e.message, details: e.details });
  send(res, 500, { error: 'INTERNAL', message: errorMessage(e) });
}

export async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE') return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  } finally {
    for (const c of chunks) c.fill(0); // bodies may contain passwords / imported keys
  }
}
