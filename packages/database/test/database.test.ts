import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src';

describe('database', () => {
  it('migrates and round-trips wallets with a single primary', () => {
    const r = openDatabase(':memory:');
    const a = r.wallets.insert({ publicKey: 'A', label: 'a', groupName: 'g1', tags: ['x'], source: 'generated' });
    r.wallets.insert({ publicKey: 'B', label: 'b', source: 'imported' });
    r.wallets.setPrimary('A');
    r.wallets.setPrimary('B');
    expect(r.wallets.primary()?.publicKey).toBe('B');
    expect(r.wallets.list({ group: 'g1' }).map((w) => w.id)).toEqual([a.id]);
    r.wallets.update('A', { archived: true });
    expect(r.wallets.list().map((w) => w.publicKey)).toEqual(['B']);
    expect(r.wallets.list({ includeArchived: true })).toHaveLength(2);
    expect(r.wallets.groups()).toEqual([]);
  });

  it('stores bigints losslessly in fills and audit', () => {
    const r = openDatabase(':memory:');
    const huge = 2n ** 63n + 12345n;
    r.fills.insert({
      wallet: 'W', mint: 'M', side: 'BUY', tokenAmountRaw: huge, decimals: 6, lamports: 1n, feeLamports: 5000n,
      signature: null, paper: false, strategyTag: null, planId: null, at: 1000,
    });
    expect(r.fills.list()[0]!.tokenAmountRaw).toBe(huge);
    expect(r.fills.lastTradeAt('M', 'BUY')).toBe(1000);
    expect(r.fills.lastTradeAt('M', 'SELL')).toBeNull();

    const id = r.audit.insert({ kind: 'SOL_TRANSFER', mode: 'LIVE', status: 'CONFIRMED', wallet: 'W', lamportsDelta: 7n, details: { x: huge } });
    r.audit.insert({ kind: 'SOL_TRANSFER', mode: 'LIVE', status: 'CONFIRMED', wallet: 'W', lamportsDelta: 5n, internal: true });
    r.audit.insert({ kind: 'SOL_TRANSFER', mode: 'SIMULATION', status: 'PAPER_FILLED', wallet: 'W', lamportsDelta: 100n });
    expect(r.audit.byId(id)!.details.x).toBe(huge);
    expect(r.audit.outflowSince('W', 0)).toBe(12n);
    expect(r.audit.outflowSince(null, 0)).toBe(7n);
  });

  it('settings and transactions roll back on error', () => {
    const r = openDatabase(':memory:');
    r.settings.set('limits', { a: 1n });
    expect(r.settings.get('limits', null)).toEqual({ a: 1n });
    expect(() =>
      r.db.transaction(() => {
        r.whitelist.add('X', 'x');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(r.whitelist.isWhitelisted('X')).toBe(false);
  });
});
