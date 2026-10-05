import { describe, expect, it } from 'vitest';
import { RENT_EXEMPT_SYSTEM_ACCOUNT, RENT_EXEMPT_TOKEN_ACCOUNT, WSOL_MINT, type ExitRuleSpec, type ExitRuleState } from '@term/core';
import { evaluateExitRule, planConsolidation, planTokenRebalance, validateExitSpec } from '../src';

const fresh = (): ExitRuleState => ({ baselineQtyRaw: 1000n, baselineByWallet: {}, peakSolPerToken: 0, firedTiers: [], stopped: false });

describe('exit rules', () => {
  const staged: ExitRuleSpec = {
    takeProfits: [
      { gainPct: 50, sellPct: 25 },
      { gainPct: 100, sellPct: 25 },
      { gainPct: 200, sellPct: 25 },
    ],
    stopLossPct: 30,
  };

  it('fires staged take-profits once each and holds the rest', () => {
    let s = fresh();
    let e = evaluateExitRule(staged, s, 1, 1.2);
    expect(e.action).toBeNull();
    e = evaluateExitRule(staged, e.state, 1, 1.55);
    expect(e.action).toEqual({ kind: 'partial', pctOfBaseline: 25, reasons: [expect.stringContaining('#1')] });
    e = evaluateExitRule(staged, e.state, 1, 1.6);
    expect(e.action).toBeNull(); // tier 1 doesn't re-fire
    e = evaluateExitRule(staged, e.state, 1, 3.5); // jumps through tiers 2 and 3
    expect(e.action).toMatchObject({ kind: 'partial', pctOfBaseline: 50 });
    expect(e.state.firedTiers).toEqual([0, 1, 2]);
    expect(e.state.stopped).toBe(false); // 25% remains held, stop loss still armed
    s = e.state;
    e = evaluateExitRule(staged, s, 1, 0.65);
    expect(e.action).toMatchObject({ kind: 'all' });
    expect(e.state.stopped).toBe(true);
    expect(evaluateExitRule(staged, e.state, 1, 10).action).toBeNull();
  });

  it('trailing stop arms after activation and tracks the peak', () => {
    const spec: ExitRuleSpec = { takeProfits: [], trailingStopPct: 20, trailingActivationPct: 50 };
    let e = evaluateExitRule(spec, fresh(), 1, 1.3);
    e = evaluateExitRule(spec, e.state, 1, 1.0); // -23% from peak but not armed (peak +30%)
    expect(e.action).toBeNull();
    e = evaluateExitRule(spec, e.state, 1, 2.0);
    e = evaluateExitRule(spec, e.state, 1, 1.7); // -15% from 2.0
    expect(e.action).toBeNull();
    e = evaluateExitRule(spec, e.state, 1, 1.59); // -20.5%
    expect(e.action).toMatchObject({ kind: 'all', reason: expect.stringContaining('trailing') });
  });

  it('validates specs', () => {
    expect(validateExitSpec({ takeProfits: [{ gainPct: 10, sellPct: 80 }, { gainPct: 20, sellPct: 30 }] })[0]).toMatch(/110%/);
    expect(validateExitSpec(staged)).toEqual([]);
  });
});

describe('consolidation planner', () => {
  const tok = (mint: string, amountRaw: bigint) => ({ mint, tokenAccount: `${mint}-acc`, programId: 'Tok', amountRaw, decimals: 6 });

  it('moves tokens, closes empties, unwraps WSOL and sweeps SOL with reserve', () => {
    const r = planConsolidation({
      balances: [
        { publicKey: 'W1', lamports: 100_000_000n, tokens: [tok('A', 500n), tok('B', 0n), tok(WSOL_MINT, 1_000_000n)], fetchedAt: 0 },
        { publicKey: 'W2', lamports: 3_000n, tokens: [], fetchedAt: 0 },
        { publicKey: 'P', lamports: 1n, tokens: [], fetchedAt: 0 },
      ],
      solDestination: 'P',
      includeSol: true,
      tokens: true,
      closeEmptyAccounts: true,
      solReserve: 0n,
      microLamportsPerCu: 0,
    });
    expect(r.legs.map((l) => [l.wallet, l.kind])).toEqual([
      ['W1', 'TOKEN_TRANSFER'],
      ['W1', 'CLOSE_ACCOUNT'],
      ['W1', 'SOL_TRANSFER'],
    ]);
    const w1 = r.wallets[0]!;
    expect(w1.accountsClosed).toBe(3);
    // A: reclaimed rent but paid dest ATA rent; B + WSOL closed: 2 rents + 1_000_000 unwrapped
    expect(w1.rentReclaimed).toBe(3n * RENT_EXEMPT_TOKEN_ACCOUNT + 1_000_000n);
    expect(w1.remainingLamports).toBe(0n);
    expect(r.expectedSolReceived).toBe(w1.sweepLamports);
    expect(w1.sweepLamports).toBe(100_000_000n + 2n * RENT_EXEMPT_TOKEN_ACCOUNT + 1_000_000n - w1.fees);
    expect(r.warnings.join()).toMatch(/too small/); // W2
  });

  it('bumps tiny reserves to rent-exempt minimum', () => {
    const r = planConsolidation({
      balances: [{ publicKey: 'W', lamports: 10_000_000n, tokens: [], fetchedAt: 0 }],
      solDestination: 'P', includeSol: true, tokens: false, closeEmptyAccounts: false, solReserve: 1000n, microLamportsPerCu: 0,
    });
    expect(r.wallets[0]!.remainingLamports).toBe(RENT_EXEMPT_SYSTEM_ACCOUNT);
  });

  it('rebalances token holdings', () => {
    const legs = planTokenRebalance(
      [
        { wallet: 'A', raw: 900n, tokenAccount: 'a', programId: 'p', decimals: 0 },
        { wallet: 'B', raw: 100n, tokenAccount: 'b', programId: 'p', decimals: 0 },
        { wallet: 'C', raw: 200n, tokenAccount: 'c', programId: 'p', decimals: 0 },
      ],
      'M',
      0,
    );
    expect(legs.map((l) => [l.wallet, l.destination, -l.tokenDelta!])).toEqual([
      ['A', 'B', 300n],
      ['A', 'C', 200n],
    ]);
  });
});
