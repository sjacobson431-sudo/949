import { Connection, type Commitment } from '@solana/web3.js';
import { errorMessage, silentLogger, TerminalError, type Logger } from '@term/core';

export interface RpcEndpointConfig {
  url: string;
  wsUrl?: string;
  label?: string;
}

export interface RpcPoolOptions {
  /** Consecutive failures before an endpoint's circuit opens. */
  failureThreshold?: number;
  /** How long an open circuit stays open before a half-open probe. */
  cooldownMs?: number;
  /** Attempts per call across endpoints (first try + retries). */
  maxAttempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  commitment?: Commitment;
  logger?: Logger;
  /** Injected for tests. */
  connectionFactory?: (cfg: RpcEndpointConfig, commitment: Commitment) => Connection;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface EndpointHealth {
  url: string;
  label: string;
  state: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  totalCalls: number;
  totalFailures: number;
  ewmaLatencyMs: number | null;
  lastError: string | null;
  openedAt: number | null;
}

interface Endpoint {
  cfg: RpcEndpointConfig;
  conn: Connection;
  health: EndpointHealth;
}

/** Errors that mean "try again / try elsewhere" rather than "your request is wrong". */
export function isRetryableRpcError(e: unknown): boolean {
  const m = errorMessage(e).toLowerCase();
  return (
    /\b(429|500|502|503|504|520|522|524)\b/.test(m) ||
    m.includes('too many requests') ||
    m.includes('rate limit') ||
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('fetch failed') ||
    m.includes('econnreset') ||
    m.includes('econnrefused') ||
    m.includes('enotfound') ||
    m.includes('socket hang up') ||
    m.includes('network') ||
    m.includes('service unavailable') ||
    m.includes('node is behind') ||
    m.includes('node is unhealthy') ||
    m.includes('internal error')
  );
}

/**
 * Pool of RPC endpoints with latency-aware selection, per-endpoint circuit
 * breakers and retry-with-backoff on transient failures only.
 */
export class RpcPool {
  private readonly endpoints: Endpoint[];
  private readonly o: Required<Omit<RpcPoolOptions, 'connectionFactory' | 'logger'>> & { logger: Logger };

  constructor(configs: RpcEndpointConfig[], opts: RpcPoolOptions = {}) {
    if (!configs.length) throw new TerminalError('VALIDATION', 'At least one RPC endpoint is required');
    this.o = {
      failureThreshold: opts.failureThreshold ?? 3,
      cooldownMs: opts.cooldownMs ?? 30_000,
      maxAttempts: opts.maxAttempts ?? 4,
      baseDelayMs: opts.baseDelayMs ?? 250,
      timeoutMs: opts.timeoutMs ?? 15_000,
      commitment: opts.commitment ?? 'confirmed',
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: opts.now ?? Date.now,
      logger: opts.logger ?? silentLogger,
    };
    const factory =
      opts.connectionFactory ??
      ((cfg, commitment) => new Connection(cfg.url, { commitment, wsEndpoint: cfg.wsUrl, disableRetryOnRateLimit: true }));
    this.endpoints = configs.map((cfg, i) => ({
      cfg,
      conn: factory(cfg, this.o.commitment),
      health: {
        url: redactUrl(cfg.url),
        label: cfg.label ?? `rpc${i}`,
        state: 'closed',
        consecutiveFailures: 0,
        totalCalls: 0,
        totalFailures: 0,
        ewmaLatencyMs: null,
        lastError: null,
        openedAt: null,
      },
    }));
  }

  get commitment(): Commitment {
    return this.o.commitment;
  }

  health(): EndpointHealth[] {
    this.refreshStates();
    return this.endpoints.map((e) => ({ ...e.health }));
  }

  /** All connections (for fan-out broadcast of signed transactions). */
  connections(): Connection[] {
    this.refreshStates();
    return this.endpoints.filter((e) => e.health.state !== 'open').map((e) => e.conn);
  }

  /**
   * Run `fn` against the best available endpoint, failing over on retryable
   * errors. Non-retryable errors are thrown immediately.
   */
  async call<T>(op: string, fn: (conn: Connection) => Promise<T>): Promise<T> {
    let lastErr: unknown = null;
    const tried = new Set<Endpoint>();
    for (let attempt = 0; attempt < this.o.maxAttempts; attempt++) {
      const ep = this.pick(tried);
      if (!ep) break;
      tried.add(ep);
      const start = this.o.now();
      ep.health.totalCalls++;
      try {
        const r = await withTimeout(fn(ep.conn), this.o.timeoutMs, `${op} timed out after ${this.o.timeoutMs}ms`);
        this.recordSuccess(ep, this.o.now() - start);
        return r;
      } catch (e) {
        lastErr = e;
        if (!isRetryableRpcError(e)) {
          // The endpoint answered; the request itself was bad.
          this.recordSuccess(ep, this.o.now() - start);
          throw e;
        }
        this.recordFailure(ep, e);
        this.o.logger.warn('rpc call failed, failing over', { op, endpoint: ep.health.label, attempt, error: errorMessage(e) });
        if (tried.size >= this.endpoints.length) tried.clear();
        await this.o.sleep(this.o.baseDelayMs * 2 ** attempt);
      }
    }
    throw new TerminalError('RPC_UNAVAILABLE', `${op} failed on all RPC endpoints: ${errorMessage(lastErr)}`);
  }

  private refreshStates(): void {
    const t = this.o.now();
    for (const e of this.endpoints) {
      if (e.health.state === 'open' && e.health.openedAt !== null && t - e.health.openedAt >= this.o.cooldownMs) {
        e.health.state = 'half-open';
      }
    }
  }

  private pick(exclude: Set<Endpoint>): Endpoint | undefined {
    this.refreshStates();
    const candidates = this.endpoints.filter((e) => e.health.state !== 'open' && !exclude.has(e));
    if (!candidates.length) {
      // Everything is open: try the one that has been open longest rather than giving up.
      return [...this.endpoints].filter((e) => !exclude.has(e)).sort((a, b) => (a.health.openedAt ?? 0) - (b.health.openedAt ?? 0))[0];
    }
    // Prefer closed over half-open, then lower latency; ties keep config order (primary first).
    return candidates
      .map((e, i) => ({ e, i }))
      .sort((a, b) => {
        const s = (x: Endpoint) => (x.health.state === 'closed' ? 0 : 1);
        if (s(a.e) !== s(b.e)) return s(a.e) - s(b.e);
        const la = a.e.health.ewmaLatencyMs ?? 0;
        const lb = b.e.health.ewmaLatencyMs ?? 0;
        // only reorder on meaningful latency differences (>50%) to keep the primary sticky
        if (la && lb && (la > lb * 1.5 || lb > la * 1.5)) return la - lb;
        return a.i - b.i;
      })[0]!.e;
  }

  private recordSuccess(ep: Endpoint, latency: number): void {
    const h = ep.health;
    h.consecutiveFailures = 0;
    h.state = 'closed';
    h.openedAt = null;
    h.ewmaLatencyMs = h.ewmaLatencyMs === null ? latency : h.ewmaLatencyMs * 0.8 + latency * 0.2;
  }

  private recordFailure(ep: Endpoint, e: unknown): void {
    const h = ep.health;
    h.consecutiveFailures++;
    h.totalFailures++;
    h.lastError = errorMessage(e).slice(0, 300);
    if (h.state === 'half-open' || h.consecutiveFailures >= this.o.failureThreshold) {
      h.state = 'open';
      h.openedAt = this.o.now();
      this.o.logger.warn('rpc circuit opened', { endpoint: h.label });
    }
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error(msg)), ms);
    }),
  ]);
}

/** Hide API keys embedded in provider URLs (query strings / path tokens). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, '***');
    u.pathname = u.pathname.replace(/[A-Za-z0-9_-]{20,}/g, '***');
    u.username = u.password = '';
    return u.toString();
  } catch {
    return '[invalid-url]';
  }
}
