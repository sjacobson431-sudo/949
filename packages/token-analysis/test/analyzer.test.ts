import { describe, expect, it } from 'vitest';
import type { HolderInfo } from '@term/core';
import { openDatabase } from '@term/database';
import { approxPriceImpactPct, clusteredHolderPct, parseDexScreenerPairs, StaticMarketDataProvider, TokenAnalyzer } from '../src';

const h = (amount: bigint, pct: number, owner: string, pool = false): HolderInfo => ({ tokenAccount: owner + 'ta', owner, amountRaw: amount, pctOfSupply: pct, isProgramOrPool: pool });

describe('token analysis', () => {
  it('detects look-alike holder clusters', () => {
    const holders = [h(1000n, 10, 'a'), h(1001n, 10, 'b'), h(1003n, 10, 'c'), h(5000n, 50, 'pool', true), h(200n, 2, 'd')];
    expect(clusteredHolderPct(holders)).toBe(30);
    expect(clusteredHolderPct([h(1000n, 10, 'a'), h(2000n, 20, 'b')])).toBe(0);
  });

  it('approximates CPMM price impact', () => {
    expect(approxPriceImpactPct(100_000, 1_000)).toBeCloseTo(1.96, 1);
    expect(approxPriceImpactPct(0, 1)).toBe(100);
  });

  it('normalises DexScreener pairs', () => {
    const r = parseDexScreenerPairs('MINT', [
      { dexId: 'raydium', pairAddress: 'P1', baseToken: { address: 'MINT', symbol: 'ABC', name: 'Abc' }, quoteToken: { address: 'SOL', symbol: 'SOL' }, priceUsd: '0.5', liquidity: { usd: 1000 }, txns: { h1: { buys: 1, sells: 2 } } },
      { dexId: 'orca', pairAddress: 'P2', baseToken: { address: 'MINT' }, quoteToken: { address: 'USDC', symbol: 'USDC' }, priceUsd: '0.5', liquidity: { usd: 5000 } },
      { dexId: 'x', pairAddress: 'P3', baseToken: { address: 'OTHER' }, quoteToken: { address: 'SOL' } },
    ] as any);
    expect(r.symbol).toBe('ABC');
    expect(r.pools.map((p) => p.pairAddress)).toEqual(['P2', 'P1']);
  });

  it('analyzes a mint and tracks liquidity change across snapshots', async () => {
    const repos = openDatabase(':memory:');
    const market = new StaticMarketDataProvider();
    const pool = {
      dex: 'raydium', pairAddress: 'P', baseMint: 'M', quoteMint: 'S', quoteSymbol: 'SOL', liquidityUsd: 10_000, priceUsd: 1, fdvUsd: 1e6, marketCapUsd: 1e6,
      createdAt: Date.now() - 3600_000, volume24hUsd: 0, txns1h: { buys: 3, sells: 1 }, txns24h: { buys: 30, sells: 10 }, priceChange1hPct: 0,
    };
    market.data.set('M', { symbol: 'M', name: 'M', pools: [pool] });
    const chain = {
      getMintInfo: async () => ({ mint: 'M', programId: 'p', decimals: 6, supplyRaw: 1000n, mintAuthority: null, freezeAuthority: null, extensions: [] }),
      getLargestHolders: async () => [h(500n, 50, 'poolvault', true), h(100n, 10, 'x'), h(50n, 5, 'y')],
    };
    const an = new TokenAnalyzer(chain, market, repos.snapshots);
    const a1 = await an.analyze('M');
    expect(a1.top10Pct).toBe(15);
    expect(a1.topHolderPct).toBe(10);
    expect(a1.liquidityChangePct).toBeNull();
    expect(a1.tokenAgeSec).toBeGreaterThan(3500);
    an.record(a1, 40);
    market.data.set('M', { symbol: 'M', name: 'M', pools: [{ ...pool, liquidityUsd: 6_000 }] });
    const a2 = await an.analyze('M');
    expect(a2.liquidityChangePct).toBe(-40);
    expect(repos.snapshots.tokenMeta('M')?.decimals).toBe(6);
  });
});
