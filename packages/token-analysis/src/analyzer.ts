import { errorMessage, silentLogger, type HolderInfo, type Logger, type MintInfo, type TokenAnalysis } from '@term/core';
import type { SnapshotRepo } from '@term/database';
import type { MarketDataProvider } from './market-data';

export interface TokenChainReader {
  getMintInfo(mint: string): Promise<MintInfo>;
  getLargestHolders(mint: string, supplyRaw: bigint): Promise<HolderInfo[]>;
}

/**
 * Detect groups of holders with near-identical balances (within `tolerance`),
 * a common fingerprint of one entity spreading supply across many wallets.
 * Returns the % of supply held by holders in clusters of size >= minCluster.
 */
export function clusteredHolderPct(holders: HolderInfo[], tolerance = 0.01, minCluster = 3): number {
  const xs = holders.filter((h) => !h.isProgramOrPool && h.amountRaw > 0n).sort((a, b) => (a.amountRaw < b.amountRaw ? -1 : 1));
  let pct = 0;
  let i = 0;
  while (i < xs.length) {
    let j = i + 1;
    while (j < xs.length) {
      const a = Number(xs[i]!.amountRaw);
      const b = Number(xs[j]!.amountRaw);
      if ((b - a) / b > tolerance) break;
      j++;
    }
    if (j - i >= minCluster) for (let k = i; k < j; k++) pct += xs[k]!.pctOfSupply;
    i = j;
  }
  // Multiple large token accounts owned by the same wallet are also concentration.
  const byOwner = new Map<string, number>();
  for (const h of holders) if (h.owner && !h.isProgramOrPool) byOwner.set(h.owner, (byOwner.get(h.owner) ?? 0) + 1);
  for (const h of holders) {
    if (h.owner && !h.isProgramOrPool && (byOwner.get(h.owner) ?? 0) > 1) pct += h.pctOfSupply / 2;
  }
  return Math.min(100, round2(pct));
}

/**
 * Constant-product approximation of price impact for buying `tradeUsd` into a
 * pool with total liquidity `liquidityUsd` (half on each side).
 */
export function approxPriceImpactPct(liquidityUsd: number, tradeUsd: number): number {
  if (liquidityUsd <= 0) return 100;
  const quoteReserve = liquidityUsd / 2;
  return round2((tradeUsd / (quoteReserve + tradeUsd)) * 100);
}

export class TokenAnalyzer {
  constructor(
    private readonly chain: TokenChainReader,
    private readonly market: MarketDataProvider,
    private readonly snapshots: SnapshotRepo | null,
    private readonly log: Logger = silentLogger,
  ) {}

  async analyze(mint: string): Promise<TokenAnalysis> {
    const warnings: string[] = [];
    const mintInfo = await this.chain.getMintInfo(mint);
    const [holdersR, marketR] = await Promise.allSettled([
      this.chain.getLargestHolders(mint, mintInfo.supplyRaw),
      this.market.getMarketData(mint),
    ]);
    const holders = holdersR.status === 'fulfilled' ? holdersR.value : [];
    if (holdersR.status === 'rejected') warnings.push(`holder data unavailable: ${errorMessage(holdersR.reason)}`);
    const market = marketR.status === 'fulfilled' ? marketR.value : { symbol: null, name: null, pools: [] };
    if (marketR.status === 'rejected') warnings.push(`market data unavailable: ${errorMessage(marketR.reason)}`);

    const nonPool = holders.filter((h) => !h.isProgramOrPool);
    const top10Pct = round2(nonPool.slice(0, 10).reduce((s, h) => s + h.pctOfSupply, 0));
    const topHolderPct = round2(nonPool[0]?.pctOfSupply ?? 0);

    const pools = market.pools;
    const totalLiquidityUsd = round2(pools.reduce((s, p) => s + p.liquidityUsd, 0));
    const main = pools.find((p) => p.priceUsd > 0) ?? null;
    const created = pools.map((p) => p.createdAt).filter((x): x is number => x !== null);
    const tokenAgeSec = created.length ? Math.max(0, Math.round((Date.now() - Math.min(...created)) / 1000)) : null;
    const sum = (k: 'txns1h' | 'txns24h') =>
      pools.reduce((s, p) => ({ buys: s.buys + p[k].buys, sells: s.sells + p[k].sells }), { buys: 0, sells: 0 });

    const prev = this.snapshots?.lastToken(mint);
    const liquidityChangePct =
      prev && prev.liquidityUsd > 0 && pools.length ? round2(((totalLiquidityUsd - prev.liquidityUsd) / prev.liquidityUsd) * 100) : null;

    if (!pools.length) warnings.push('no liquidity pools found');
    if (holders.length >= 20) warnings.push('holder data limited to the 20 largest accounts');

    const a: TokenAnalysis = {
      mint,
      symbol: market.symbol,
      name: market.name,
      mintInfo,
      holders,
      top10Pct,
      topHolderPct,
      clusteredHolderPct: clusteredHolderPct(holders),
      pools,
      totalLiquidityUsd,
      priceUsd: main?.priceUsd ?? null,
      marketCapUsd: main?.marketCapUsd ?? null,
      fdvUsd: main?.fdvUsd ?? null,
      tokenAgeSec,
      liquidityChangePct,
      txns1h: sum('txns1h'),
      txns24h: sum('txns24h'),
      analyzedAt: Date.now(),
      warnings,
    };
    try {
      this.snapshots?.upsertTokenMeta(mint, mintInfo.decimals, market.symbol, market.name);
    } catch (e) {
      this.log.warn('token meta save failed', { error: errorMessage(e) });
    }
    return a;
  }

  /** Persist a snapshot (called after scoring so the score is stored with it). */
  record(a: TokenAnalysis, riskScore: number | null): void {
    this.snapshots?.addToken(a.mint, a.totalLiquidityUsd, a.top10Pct, riskScore, a);
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
