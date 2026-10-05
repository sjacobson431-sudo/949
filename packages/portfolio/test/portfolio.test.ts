import { describe, expect, it } from 'vitest';
import { solToLamports as sol, type Fill } from '@term/core';
import { openDatabase } from '@term/database';
import { buildLedger, computeTradeStats, fillsCsv, maxDrawdown, PortfolioService, tradesCsv } from '../src';

let id = 0;
const f = (o: Partial<Fill> & Pick<Fill, 'side' | 'tokenAmountRaw' | 'lamports' | 'at'>): Fill => ({
  id: ++id, wallet: 'W1', mint: 'M', decimals: 6, feeLamports: 0n, signature: null, paper: false, strategyTag: null, planId: null, ...o,
});

describe('ledger', () => {
  it('tracks average cost, realized P&L and cycles', () => {
    const fills = [
      f({ side: 'BUY', tokenAmountRaw: 1000n, lamports: sol('1'), at: 1 }),
      f({ side: 'BUY', tokenAmountRaw: 1000n, lamports: sol('3'), at: 3 }),
      f({ side: 'SELL', tokenAmountRaw: 1000n, lamports: sol('4'), at: 5 }),
    ];
    const r = buildLedger(fills);
    const lot = r.lots.get('W1:M')!;
    expect(lot.qtyRaw).toBe(1000n);
    expect(lot.costLamports).toBe(sol('2'));
    expect(lot.realizedLamports).toBe(sol('2'));
    expect(lot.openedAt).toBe(2);
    expect(r.cycles).toHaveLength(1);
    expect(r.cycles[0]!.closedAt).toBeNull();
    const r2 = buildLedger([...fills, f({ side: 'SELL', tokenAmountRaw: 1000n, lamports: sol('1'), at: 9 })]);
    expect(r2.cycles[0]!.closedAt).toBe(9);
    expect(r2.cycles[0]!.realized).toBe(sol('1'));
  });

  it('capitalises fees and handles untracked sells', () => {
    const r = buildLedger([
      f({ side: 'BUY', tokenAmountRaw: 100n, lamports: 1000n, feeLamports: 10n, at: 1 }),
      f({ side: 'SELL', tokenAmountRaw: 150n, lamports: 1500n, feeLamports: 10n, at: 2 }),
    ]);
    expect(r.lots.get('W1:M')!.realizedLamports).toBe(1500n - 10n - 1010n);
    expect(r.untrackedSells).toBe(1);
  });
});

describe('analytics', () => {
  it('computes win rate, profit factor, drawdown, breakdowns', () => {
    const fills = [
      // win +1 SOL on A
      f({ wallet: 'W1', mint: 'A', side: 'BUY', tokenAmountRaw: 10n, lamports: sol('1'), at: 0, strategyTag: 'aggr' }),
      f({ wallet: 'W1', mint: 'A', side: 'SELL', tokenAmountRaw: 10n, lamports: sol('2'), at: 60_000 }),
      // loss -0.5 SOL on B
      f({ wallet: 'W2', mint: 'B', side: 'BUY', tokenAmountRaw: 10n, lamports: sol('1'), at: 100_000 }),
      f({ wallet: 'W2', mint: 'B', side: 'SELL', tokenAmountRaw: 10n, lamports: sol('0.5'), at: 220_000 }),
      // win +0.25 on A again
      f({ wallet: 'W2', mint: 'A', side: 'BUY', tokenAmountRaw: 10n, lamports: sol('1'), at: 300_000, strategyTag: 'aggr' }),
      f({ wallet: 'W2', mint: 'A', side: 'SELL', tokenAmountRaw: 10n, lamports: sol('1.25'), at: 360_000 }),
      // open position
      f({ wallet: 'W3', mint: 'C', side: 'BUY', tokenAmountRaw: 10n, lamports: sol('1'), at: 400_000 }),
    ];
    const s = computeTradeStats(fills, { capitalBase: sol('10') });
    expect(s.closedTrades).toBe(3);
    expect(s.openTrades).toBe(1);
    expect(s.winRatePct).toBe(66.67);
    expect(s.avgWinnerLamports).toBe(sol('0.625'));
    expect(s.avgLoserLamports).toBe(-sol('0.5'));
    expect(s.profitFactor).toBe(2.5);
    expect(s.maxDrawdownLamports).toBe(sol('0.5'));
    expect(s.maxDrawdownPct).toBeCloseTo(4.55, 1);
    expect(s.bestTrade!.realized).toBe(sol('1'));
    expect(s.worstTrade!.realized).toBe(-sol('0.5'));
    expect(s.avgHoldingMs).toBe(80_000);
    expect(s.pnlByToken).toEqual({ A: sol('1.25'), B: -sol('0.5') });
    expect(s.pnlByStrategy.aggr).toBe(sol('1.25'));
    expect(s.pnlByStrategy.manual).toBe(-sol('0.5'));
    expect(tradesCsv(fills).split('\n')[0]).toContain('realized_pnl_sol');
    expect(fillsCsv(fills).trim().split('\n')).toHaveLength(8);
  });

  it('max drawdown on a series', () => {
    expect(maxDrawdown([10n, 12n, 6n, 15n, 9n]).abs).toBe(6n);
  });
});

describe('PortfolioService', () => {
  it('values wallets and tokens and computes P&L', () => {
    const repos = openDatabase(':memory:');
    repos.wallets.insert({ publicKey: 'W1', label: 'one', source: 'generated' });
    repos.wallets.insert({ publicKey: 'W2', label: 'two', source: 'generated' });
    repos.fills.insert({ wallet: 'W1', mint: 'M', side: 'BUY', tokenAmountRaw: 1_000_000n, decimals: 6, lamports: sol('1'), feeLamports: 0n, signature: null, paper: false, strategyTag: null, planId: null, at: 1 });
    repos.fills.insert({ wallet: 'W2', mint: 'M', side: 'BUY', tokenAmountRaw: 3_000_000n, decimals: 6, lamports: sol('3'), feeLamports: 0n, signature: null, paper: false, strategyTag: null, planId: null, at: 2 });
    const tok = (raw: bigint) => [{ mint: 'M', tokenAccount: 'x', programId: 'p', amountRaw: raw, decimals: 6 }];
    const balances = [
      { publicKey: 'W1', lamports: sol('2'), tokens: tok(1_000_000n), fetchedAt: 0 },
      { publicKey: 'W2', lamports: sol('1'), tokens: tok(3_000_000n), fetchedAt: 0 },
    ];
    const svc = new PortfolioService(repos, { solPrice: (m) => (m === 'M' ? 1.5 : null), solUsd: () => 100 }, () => balances, () => false);
    const s = svc.summary();
    expect(s.solLamports).toBe(sol('3'));
    expect(s.tokensLamports).toBe(sol('6'));
    expect(s.unrealizedLamports).toBe(sol('2'));
    const t = svc.token('M')!;
    expect(t.totalRaw).toBe(4_000_000n);
    expect(t.avgEntrySolPerToken).toBe(1);
    expect(t.returnPct).toBe(50);
    expect(t.wallets.map((w) => [w.wallet, w.pctOfPosition])).toEqual([['W2', 75], ['W1', 25]]);
    svc.snapshot();
    expect(repos.snapshots.portfolioHistory(0)).toHaveLength(1);
  });
});
