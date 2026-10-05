import { fetchJson, type PoolInfo } from '@term/core';

export interface MarketDataResult {
  symbol: string | null;
  name: string | null;
  pools: PoolInfo[];
}

export interface MarketDataProvider {
  readonly name: string;
  getMarketData(mint: string): Promise<MarketDataResult>;
}

interface DexScreenerPair {
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name?: string; symbol?: string };
  quoteToken: { address: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  volume?: { h24?: number };
  txns?: { h1?: { buys: number; sells: number }; h24?: { buys: number; sells: number } };
  priceChange?: { h1?: number };
}

/** DexScreener public API: pools, liquidity, activity for a Solana mint. */
export class DexScreenerProvider implements MarketDataProvider {
  readonly name = 'dexscreener';
  constructor(
    private readonly baseUrl = 'https://api.dexscreener.com',
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async getMarketData(mint: string): Promise<MarketDataResult> {
    const pairs = await fetchJson<DexScreenerPair[] | null>(`${this.baseUrl}/token-pairs/v1/solana/${mint}`, { fetchImpl: this.fetchImpl });
    return parseDexScreenerPairs(mint, pairs ?? []);
  }
}

export function parseDexScreenerPairs(mint: string, pairs: DexScreenerPair[]): MarketDataResult {
  let symbol: string | null = null;
  let name: string | null = null;
  const pools: PoolInfo[] = [];
  for (const p of pairs) {
    // Normalise so `baseMint` is always our token.
    const isBase = p.baseToken.address === mint;
    if (!isBase && p.quoteToken.address !== mint) continue;
    if (isBase) {
      symbol ??= p.baseToken.symbol ?? null;
      name ??= p.baseToken.name ?? null;
    }
    const price = Number(p.priceUsd ?? 0);
    pools.push({
      dex: p.dexId,
      pairAddress: p.pairAddress,
      baseMint: mint,
      quoteMint: isBase ? p.quoteToken.address : p.baseToken.address,
      quoteSymbol: (isBase ? p.quoteToken.symbol : p.baseToken.symbol) ?? '?',
      liquidityUsd: p.liquidity?.usd ?? 0,
      // DexScreener prices the base token; invert when our token is the quote.
      priceUsd: isBase ? price : 0,
      fdvUsd: isBase ? p.fdv ?? null : null,
      marketCapUsd: isBase ? p.marketCap ?? null : null,
      createdAt: p.pairCreatedAt ?? null,
      volume24hUsd: p.volume?.h24 ?? 0,
      txns1h: p.txns?.h1 ?? { buys: 0, sells: 0 },
      txns24h: p.txns?.h24 ?? { buys: 0, sells: 0 },
      priceChange1hPct: p.priceChange?.h1 ?? null,
    });
  }
  pools.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return { symbol, name, pools };
}

/** In-memory provider for tests / offline. */
export class StaticMarketDataProvider implements MarketDataProvider {
  readonly name = 'static';
  readonly data = new Map<string, MarketDataResult>();
  async getMarketData(mint: string): Promise<MarketDataResult> {
    return this.data.get(mint) ?? { symbol: null, name: null, pools: [] };
  }
}
