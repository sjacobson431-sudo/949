import { EventEmitter } from 'node:events';
import { errorMessage, fetchJson, silentLogger, WSOL_MINT, type Logger, type PriceQuote } from '@term/core';

export interface PriceProvider {
  readonly name: string;
  /** USD price per whole token for each mint it knows. */
  getUsdPrices(mints: string[]): Promise<Map<string, number>>;
}

/** Jupiter Price API v3. */
export class JupiterPriceProvider implements PriceProvider {
  readonly name = 'jupiter';
  constructor(
    private readonly baseUrl = 'https://lite-api.jup.ag',
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async getUsdPrices(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let i = 0; i < mints.length; i += 50) {
      const ids = mints.slice(i, i + 50).join(',');
      const r = await fetchJson<Record<string, { usdPrice?: number } | null>>(`${this.baseUrl}/price/v3?ids=${ids}`, { fetchImpl: this.fetchImpl });
      for (const [mint, v] of Object.entries(r)) if (v && typeof v.usdPrice === 'number') out.set(mint, v.usdPrice);
    }
    return out;
  }
}

/** Deterministic in-memory provider for tests and offline simulation. */
export class StaticPriceProvider implements PriceProvider {
  readonly name = 'static';
  readonly prices = new Map<string, number>();
  set(mint: string, usd: number): void {
    this.prices.set(mint, usd);
  }
  async getUsdPrices(mints: string[]): Promise<Map<string, number>> {
    return new Map(mints.filter((m) => this.prices.has(m)).map((m) => [m, this.prices.get(m)!]));
  }
}

export interface PriceServiceEvents {
  tick: [PriceQuote[]];
  error: [string];
}

/**
 * Polls the provider for watched mints, caches quotes and emits ticks. The
 * API layer forwards ticks to dashboard clients over WebSocket; the strategy
 * runner evaluates exit rules on each tick.
 */
export class PriceService extends EventEmitter<PriceServiceEvents> {
  private readonly cache = new Map<string, PriceQuote>();
  private readonly watched = new Set<string>([WSOL_MINT]);
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly provider: PriceProvider,
    private readonly opts: { intervalMs?: number; staleMs?: number; logger?: Logger; onSnapshot?: (q: PriceQuote) => void } = {},
  ) {
    super();
  }

  watch(...mints: string[]): void {
    for (const m of mints) this.watched.add(m);
  }

  unwatch(mint: string): void {
    if (mint !== WSOL_MINT) this.watched.delete(mint);
  }

  watchedMints(): string[] {
    return [...this.watched];
  }

  solUsd(): number | null {
    return this.cache.get(WSOL_MINT)?.usd ?? null;
  }

  get(mint: string): PriceQuote | undefined {
    const q = this.cache.get(mint);
    if (q && Date.now() - q.at > (this.opts.staleMs ?? 5 * 60_000)) return undefined;
    return q;
  }

  /** SOL per whole token, or null when unknown. */
  solPrice(mint: string): number | null {
    if (mint === WSOL_MINT) return 1;
    return this.get(mint)?.sol ?? null;
  }

  all(): PriceQuote[] {
    return [...this.cache.values()];
  }

  /** Inject a quote (paper trading, tests, or prices observed from executed swaps). */
  set(mint: string, usd: number, source = 'manual'): PriceQuote {
    const solUsd = mint === WSOL_MINT ? usd : this.solUsd();
    const q: PriceQuote = { mint, usd, sol: solUsd ? usd / solUsd : 0, at: Date.now(), source };
    this.cache.set(mint, q);
    return q;
  }

  async refresh(mints: string[] = this.watchedMints()): Promise<PriceQuote[]> {
    const list = [...new Set([WSOL_MINT, ...mints])];
    const usd = await this.provider.getUsdPrices(list);
    const solUsd = usd.get(WSOL_MINT) ?? this.solUsd();
    const now = Date.now();
    const quotes: PriceQuote[] = [];
    for (const [mint, p] of usd) {
      const q: PriceQuote = { mint, usd: p, sol: solUsd ? p / solUsd : 0, at: now, source: this.provider.name };
      this.cache.set(mint, q);
      quotes.push(q);
      this.opts.onSnapshot?.(q);
    }
    if (quotes.length) this.emit('tick', quotes);
    return quotes;
  }

  start(): void {
    if (this.timer) return;
    const run = async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        await this.refresh();
      } catch (e) {
        (this.opts.logger ?? silentLogger).warn('price refresh failed', { error: errorMessage(e) });
        this.emit('error', errorMessage(e));
      } finally {
        this.polling = false;
      }
    };
    void run();
    this.timer = setInterval(run, this.opts.intervalMs ?? 10_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
