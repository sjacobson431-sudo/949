import { describe, expect, it } from 'vitest';
import { RENT_EXEMPT_SYSTEM_ACCOUNT, seededRng, solToLamports as sol, sumBig, WSOL_MINT } from '@term/core';
import { MockSwapProvider, planDistribution, planOrders, splitAmount } from '../src';

const keys = ['A', 'B', 'C', 'D'];

describe('splitAmount', () => {
  it('equal split sums exactly', () => {
    const m = splitAmount(1000n, ['a', 'b', 'c'], { kind: 'equal' });
    expect(sumBig(m.values())).toBe(1000n);
    expect([...m.values()].sort()).toEqual([333n, 333n, 334n]);
  });
  it('percentage requires 100%', () => {
    expect(() => splitAmount(100n, ['a', 'b'], { kind: 'percentage', pcts: { a: 50, b: 40 } })).toThrow(/100/);
    const m = splitAmount(1000n, ['a', 'b'], { kind: 'percentage', pcts: { a: 75, b: 25 } });
    expect(m.get('a')).toBe(750n);
  });
  it('weighted split', () => {
    const m = splitAmount(900n, ['a', 'b'], { kind: 'weighted', weights: { a: 2, b: 1 } });
    expect(m.get('a')).toBe(600n);
    expect(m.get('b')).toBe(300n);
  });
  it('random within range, reproducible with a seed', () => {
    const spec = { kind: 'random' as const, min: sol('0.1'), max: sol('0.2'), seed: 7 };
    const a = splitAmount(0n, keys, spec);
    const b = splitAmount(0n, keys, spec);
    expect([...a.values()]).toEqual([...b.values()]);
    for (const v of a.values()) expect(v >= sol('0.1') && v <= sol('0.2')).toBe(true);
  });
});

describe('planDistribution', () => {
  const recipients = keys.map((k) => ({ publicKey: k, lamports: 0n }));

  it('distributes equally with gas reserve and computes remainder', () => {
    const r = planDistribution({
      source: { publicKey: 'SRC', lamports: sol('10') },
      recipients,
      total: sol('4'),
      spec: { kind: 'equal' },
      gasReservePerWallet: sol('0.01'),
      feePerTx: 5000n,
    });
    expect(r.problems).toEqual([]);
    expect(r.transfers.map((t) => t.lamports)).toEqual(Array(4).fill(sol('1.01')));
    expect(r.txCount).toBe(1);
    expect(r.sourceRemaining).toBe(sol('10') - sol('4.04') - 5000n);
  });

  it('applies min/max balance constraints and rent-exempt minimum', () => {
    const r = planDistribution({
      source: { publicKey: 'SRC', lamports: sol('10') },
      recipients: [
        { publicKey: 'A', lamports: sol('0.9') }, // near max
        { publicKey: 'B', lamports: 0n }, // tiny alloc -> rent minimum
        { publicKey: 'C', lamports: sol('2') }, // already above max -> skipped
      ],
      total: 300n,
      spec: { kind: 'equal' },
      constraints: { maxWalletBalance: sol('1') },
      feePerTx: 5000n,
    });
    const byTo = Object.fromEntries(r.transfers.map((t) => [t.to, t]));
    expect(byTo.A!.lamports).toBe(100n);
    expect(byTo.B!.lamports).toBe(RENT_EXEMPT_SYSTEM_ACCOUNT);
    expect(byTo.C).toBeUndefined();

    const r2 = planDistribution({
      source: { publicKey: 'SRC', lamports: sol('10') },
      recipients: [{ publicKey: 'A', lamports: sol('0.2') }],
      total: 0n,
      spec: { kind: 'equal' },
      constraints: { minWalletBalance: sol('0.5') },
      feePerTx: 5000n,
    });
    expect(r2.transfers[0]!.lamports).toBe(sol('0.3'));
    expect(r2.transfers[0]!.postLamports).toBe(sol('0.5'));
  });

  it('flags insufficient source balance', () => {
    const r = planDistribution({ source: { publicKey: 'S', lamports: sol('1') }, recipients, total: sol('1'), spec: { kind: 'equal' }, feePerTx: 5000n });
    expect(r.problems[0]).toMatch(/below the required reserve/);
  });

  it('batches into multiple transactions for many wallets', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ publicKey: `W${i}`, lamports: 0n }));
    const r = planDistribution({ source: { publicKey: 'S', lamports: sol('100') }, recipients: many, total: sol('40'), spec: { kind: 'equal' }, feePerTx: 10_000n });
    expect(r.txCount).toBe(3);
    expect(r.totalFees).toBe(30_000n);
  });
});

describe('planOrders', () => {
  const wallets = [
    { publicKey: 'A', lamports: sol('1'), tokenRaw: 1000n },
    { publicKey: 'B', lamports: sol('0.5'), tokenRaw: 3000n },
    { publicKey: 'C', lamports: sol('0.005'), tokenRaw: 0n },
  ];

  it('fixed buys respect gas reserve and skip broke wallets', () => {
    const r = planOrders({ side: 'BUY', wallets, sizing: { kind: 'fixed', amount: sol('0.6') }, timing: { kind: 'simultaneous', concurrency: 4 }, gasReserve: sol('0.01') });
    expect(r.orders.map((o) => o.inAmount)).toEqual([sol('0.6'), sol('0.49')]);
    expect(r.orders[1]!.notes[0]).toMatch(/reduced/);
    expect(r.skipped.map((s) => s.wallet)).toEqual(['C']);
  });

  it('percent-of-wallet sells', () => {
    const r = planOrders({ side: 'SELL', wallets, sizing: { kind: 'percentOfWallet', pct: 50 }, timing: { kind: 'simultaneous', concurrency: 1 }, gasReserve: 0n });
    expect(r.orders.map((o) => [o.wallet, o.inAmount])).toEqual([['A', 500n], ['B', 1500n]]);
  });

  it('total sells split proportionally to holdings', () => {
    const r = planOrders({ side: 'SELL', wallets, sizing: { kind: 'total', total: 2000n, allocation: { kind: 'equal' } }, timing: { kind: 'simultaneous', concurrency: 1 }, gasReserve: 0n });
    expect(Object.fromEntries(r.orders.map((o) => [o.wallet, o.inAmount]))).toEqual({ A: 500n, B: 1500n });
  });

  it('staggers with bounded jitter', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ publicKey: `W${i}`, lamports: sol('1'), tokenRaw: 0n }));
    const r = planOrders({
      side: 'BUY', wallets: many, sizing: { kind: 'fixed', amount: sol('0.1') },
      timing: { kind: 'staggered', intervalMs: 1000, jitterMs: 200 }, gasReserve: 0n, rng: seededRng(1),
    });
    const offsets = r.orders.map((o) => o.offsetMs).sort((a, b) => a - b);
    offsets.forEach((o, i) => expect(Math.abs(o - i * 1000)).toBeLessThanOrEqual(200));
  });
});

describe('MockSwapProvider', () => {
  it('quotes constant-product with fee and impact, and moves reserves on fill', async () => {
    const m = new MockSwapProvider();
    m.addPool('T', sol('100'), 1_000_000_000n, 0);
    const q = await m.quote({ inputMint: WSOL_MINT, outputMint: 'T', amount: sol('1'), slippageBps: 100 });
    expect(q.outAmount).toBe(9_900_990n);
    expect(q.priceImpactPct).toBeCloseTo(0.99, 1);
    expect(q.minOutAmount).toBe((q.outAmount * 9900n) / 10000n);
    m.applyFill(q);
    const q2 = await m.quote({ inputMint: WSOL_MINT, outputMint: 'T', amount: sol('1'), slippageBps: 100 });
    expect(q2.outAmount < q.outAmount).toBe(true);
    const s = await m.quote({ inputMint: 'T', outputMint: WSOL_MINT, amount: q.outAmount, slippageBps: 100 });
    expect(s.outAmount <= sol('1')).toBe(true);
  });
});
