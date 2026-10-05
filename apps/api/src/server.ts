import { createServer, type IncomingMessage, type Server } from 'node:http';
import { toWire, type Logger } from '@term/core';
import type { Terminal } from '@term/runtime';
import { WebSocketServer, type WebSocket } from 'ws';
import { readBody, Router, send, sendError } from './http';
import { registerRoutes } from './routes';

export interface ServerOptions {
  port: number;
  /** Origin allowed for CORS + WebSocket (the dashboard). */
  dashboardOrigin: string;
  host?: string;
}

/** Exponential lockout after repeated bad unlock attempts. */
export class UnlockGuard {
  private failures = 0;
  private lockedUntil = 0;
  constructor(private readonly now: () => number = Date.now) {}
  check(): void {
    if (this.now() < this.lockedUntil) {
      const s = Math.ceil((this.lockedUntil - this.now()) / 1000);
      throw Object.assign(new Error(`Too many failed attempts; retry in ${s}s`), { status: 429 });
    }
  }
  fail(): void {
    this.failures++;
    if (this.failures >= 3) this.lockedUntil = this.now() + Math.min(15 * 60_000, 5_000 * 2 ** (this.failures - 3));
  }
  succeed(): void {
    this.failures = 0;
    this.lockedUntil = 0;
  }
}

/**
 * Local engine API. Defences: binds 127.0.0.1, rejects foreign Host headers
 * (DNS rebinding), strict CORS to the dashboard origin, bearer token for
 * everything except status/init/unlock, 1 MB body cap.
 */
export function createApiServer(term: Terminal, opts: ServerOptions): { server: Server; wss: WebSocketServer; close: () => Promise<void> } {
  const log: Logger = term.log.child({ component: 'api' });
  const router = new Router();
  const unlockGuard = new UnlockGuard();
  registerRoutes(router, { term, onUnlocked: () => undefined, unlockGuard });

  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`]);
  const bearer = (req: IncomingMessage): string | null => {
    const h = req.headers.authorization;
    return h?.startsWith('Bearer ') ? h.slice(7) : null;
  };

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if (origin === opts.dashboardOrigin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE');
    }
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 421, { error: 'BAD_HOST', message: 'Host not allowed' });
      if (origin && origin !== opts.dashboardOrigin) return send(res, 403, { error: 'BAD_ORIGIN', message: 'Origin not allowed' });
      if (req.method === 'OPTIONS') return send(res, 204, null);

      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const m = router.match(req.method ?? 'GET', url.pathname);
      if (!m) return send(res, 404, { error: 'NOT_FOUND', message: 'No such route' });
      if (!m.route.public) {
        if (!term.session.verifyToken(bearer(req))) {
          return send(res, 401, { error: 'UNAUTHENTICATED', message: term.vault.isUnlocked() ? 'Invalid session token' : 'Vault is locked' });
        }
        term.session.touch();
      }
      const body = await readBody(req);
      const out = await m.route.handler({ req, res, params: m.params, query: url.searchParams, body });
      send(res, 200, out);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status) return send(res, status, { error: 'REQUEST', message: (e as Error).message });
      log.warn('request failed', { method: req.method, url: req.url?.split('?')[0], error: (e as Error).message });
      sendError(res, e);
    }
  });

  // ---------------------------------------------------------------- WebSocket push
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set<WebSocket>();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const ok =
      url.pathname === '/ws' &&
      allowedHosts.has(req.headers.host ?? '') &&
      (!req.headers.origin || req.headers.origin === opts.dashboardOrigin) &&
      term.session.verifyToken(url.searchParams.get('token'));
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.send(JSON.stringify({ type: 'hello', mode: term.mode.current }));
    });
  });
  const broadcast = (type: string, data: unknown) => {
    const msg = JSON.stringify(toWire({ type, data, at: Date.now() }));
    for (const c of clients) if (c.readyState === c.OPEN) c.send(msg);
  };
  term.prices.on('tick', (qs) => broadcast('prices', qs));
  term.engine.on('leg', (e) => broadcast('leg', e));
  term.engine.on('plan', (e) => broadcast('plan', e));
  term.engine.on('fill', (e) => broadcast('fill', e));
  term.positions.on('alert', (a) => broadcast('alert', a));
  term.mode.onChange((m) => broadcast('mode', { mode: m }));
  term.vault.onLock(() => {
    broadcast('lock', {});
    for (const c of clients) c.close(4001, 'vault locked');
  });

  return {
    server,
    wss,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}
