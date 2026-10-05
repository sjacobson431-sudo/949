import { describe, expect, it } from 'vitest';
import type { TokenAnalysis } from '@term/core';
import { checkPriceImpact, DEFAULT_WEIGHTS, scoreToken } from '../src';

export function analysis(over: Partial<TokenAnalysis> = {}): TokenAnalysis {
  return {
    mint: 'M',
    symbol: 'TEST',
    name: 'Test',
    mintInfo: { mint: 'M', programId: 'p', decimals: 6, supplyRaw: 10n ** 15n, mintAuthority: null, freezeAuthority: null, extensions: [] },
    holders: [],
    top10Pct: 15,
    topHolderPct: 3,
    clusteredHolderPct: 0,
    pools: [
      {
        dex: 'raydium', pairAddress: 'P', baseMint: 'M', quoteMint: 'So1', quoteSymbol: 'SOL', liquidityUsd: 500_000, priceUsd: 0.01,
        fdvUsd: 2_000_000, marketCapUsd: 2_000_000, createdAt: Date.now() - 30 * 86_400_000, volume24hUsd: 1e6,
        txns1h: { buys: 120, sells: 100 }, txns24h: { buys: 3000, sells: 2800 }, priceChange1hPct: 1,
      },
    ],
    totalLiquidityUsd: 500_000,
    priceUsd: 0.01,
    marketCapUsd: 2_000_000,
    fdvUsd: 2_000_000,
    tokenAgeSec: 30 * 86_400,
    liquidityChangePct: 2,
    txns1h: { buys: 120, sells: 100 },
    txns24h: { buys: 3000, sells: 2800 },
    analyzedAt: Date.now(),
    warnings: [],
    ...over,
  };
}

describe('risk engine', () => {
  it('default weights sum to 100', () => {
    expect(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('scores a mature, healthy token low and passes policy', () => {
    const r = scoreToken(analysis());
    expect(r.score).toBeLessThan(10);
    expect(r.grade).toBe('LOW');
    expect(r.passesPolicy).toBe(true);
    expect(r.factors.every((f) => f.detail.length > 0)).toBe(true);
  });

  it('scores a fresh rug-shaped token high and explains why', () => {
    const r = scoreToken(
      analysis({
        mintInfo: { mint: 'M', programId: 'p', decimals: 6, supplyRaw: 1n, mintAuthority: 'Auth1111', freezeAuthority: 'Frz1111', extensions: [] },
        totalLiquidityUsd: 3000,
        top10Pct: 72,
        topHolderPct: 25,
        clusteredHolderPct: 30,
        tokenAgeSec: 600,
        liquidityChangePct: -45,
        txns1h: { buys: 5, sells: 40 },
        txns24h: { buys: 5, sells: 10 },
      }),
    );
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.grade).toBe('EXTREME');
    expect(r.passesPolicy).toBe(false);
    expect(r.blockers).toEqual(expect.arrayContaining(['Mint authority is not revoked', 'Freeze authority is not revoked']));
    expect(r.factors[0]!.points).toBeGreaterThan(0);
    const mint = r.factors.find((f) => f.id === 'mint_authority')!;
    expect(mint.points).toBe(mint.maxPoints);
    expect(mint.severity).toBe('critical');
  });

  it('respects custom weights and policy', () => {
    const a = analysis({ mintInfo: { ...analysis().mintInfo, mintAuthority: 'X' } });
    const def = scoreToken(a, { policy: { requireMintAuthorityRevoked: false } });
    expect(def.passesPolicy).toBe(true);
    const heavy = scoreToken(a, { weights: { mint_authority: 200 }, policy: { requireMintAuthorityRevoked: false } });
    expect(heavy.score).toBeGreaterThan(def.score);
    expect(heavy.passesPolicy).toBe(false); // exceeds maxScore
  });

  it('blocks permanent delegate tokens', () => {
    const r = scoreToken(analysis({ mintInfo: { ...analysis().mintInfo, extensions: ['permanentDelegate'] } }));
    expect(r.blockers.join()).toMatch(/Permanent delegate/);
  });

  it('checks price impact', () => {
    expect(checkPriceImpact(2)).toBeNull();
    expect(checkPriceImpact(7)).toMatch(/Price impact/);
  });
});
