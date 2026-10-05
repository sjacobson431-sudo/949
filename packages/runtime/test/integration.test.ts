import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { isTerminalError, solToLamports as sol, WSOL_MINT } from '@term/core';
import { computeTradeStats } from '@term/portfolio';
import { Terminal, type RuntimeConfig } from '../src';

const PW = 'integration test passphrase 42!';
const MINT = Keypair.generate().publicKey.toBase58();

function cfg(): RuntimeConfig {
  return {
    dataDir: '/tmp', dbPath: ':memory:', rpcUrls: [], offline: true, startMode: 'READ_ONLY',
    jupiterBaseUrl: '', dexscreenerBaseUrl: '', logLevel: 'error', priceIntervalMs: 60_000, kdf: { N: 2 ** 10 },
  };
}

let term: Terminal | null = null;
afterEach(() => {
  term?.close();
  term = null;
});

async function boot() {
  const t = (term = new Terminal(cfg()));
  await t.vault.initialize(PW);
  t.session.start();
  const wallets = t.wallets.generate({ count: 10, group: 'swarm' });
  return { t, primary: wallets[0]!.publicKey, others: wallets.slice(1).map((w) => w.publicKey) };
}

describe('end-to-end (offline SIMULATION)', () => {
  it('runs distribute → analyze → buy → exit rules → analytics → consolidate', async () => {
    const { t, primary, others } = await boot();

    // READ_ONLY cannot plan
    await expect(t.engine.previewDistribution({ recipients: others, total: sol('1'), spec: { kind: 'equal' }, priority: { level: 'none' } })).rejects.toSatisfy(
      (e) => isTerminalError(e, 'MODE_FORBIDDEN'),
    );
    // LIVE is impossible offline
    await expect(t.setMode('LIVE', PW)).rejects.toThrow(/offline/);

    await t.setMode('SIMULATION');
    t.engine.paperDeposit(primary, sol('100'));

    // ---- distribute 9 SOL equally + auto gas reserve
    const dist = await t.engine.previewDistribution({
      recipients: others, total: sol('9'), spec: { kind: 'equal' }, gasReserve: 'auto', priority: { level: 'none' },
    });
    expect(dist.blockers).toEqual([]);
    expect(dist.legs).toHaveLength(9);
    expect(dist.legs.every((l) => l.destination && l.lamportsDelta > sol('1'))).toBe(true);
    await expect(t.engine.execute(dist.id, 'nope')).rejects.toSatisfy((e) => isTerminalError(e, 'PLAN_MISMATCH'));
    const dres = await t.engine.execute(dist.id, dist.hash);
    expect(dres.status).toBe('DONE');
    expect(dres.paper).toBe(9);
    await expect(t.engine.execute(dist.id, dist.hash)).rejects.toThrow(/not executable/);

    const bals = await t.refreshBalances();
    const primaryBal = bals.find((b) => b.publicKey === primary)!;
    expect(primaryBal.lamports).toBe(BigInt(String(dist.params.sourceRemaining)));
    expect(bals.find((b) => b.publicKey === others[0])!.lamports).toBe(dist.legs[0]!.lamportsDelta);

    // ---- token analysis + risk
    t.seedMockMarket({ mint: MINT, symbol: 'MEME', decimals: 6, solReserve: sol('500'), tokenReserve: 1_000_000_000_000_000n, solUsd: 150 });
    const { analysis, risk } = await t.analyzeToken(MINT);
    expect(analysis.symbol).toBe('MEME');
    expect(risk.score).toBeGreaterThanOrEqual(0);
    expect(risk.factors.length).toBe(12);

    // ---- multi-wallet staggered buy
    const buy = await t.engine.previewTrade({
      mint: MINT, side: 'BUY', wallets: others, sizing: { kind: 'fixed', amount: sol('0.5') },
      timing: { kind: 'staggered', intervalMs: 5, jitterMs: 2 }, slippageBps: 300, priority: { level: 'none' }, strategyTag: 'test-strat',
      maxPriceImpactPct: 5,
    });
    expect(buy.blockers).toEqual([]);
    expect(buy.legs).toHaveLength(9);
    expect(buy.legs[0]!.simulation!.postTokenRaw! > 0n).toBe(true);
    const events: string[] = [];
    t.engine.on('leg', (e) => events.push(e.status));
    const bres = await t.engine.execute(buy.id, buy.hash);
    expect(bres.status).toBe('DONE');
    expect(events.filter((s) => s === 'PAPER_FILLED')).toHaveLength(9);
    expect(t.repos.fills.list({ paper: true })).toHaveLength(9);

    await t.refreshBalances();
    const exposure = t.portfolio.token(MINT)!;
    expect(exposure.wallets).toHaveLength(9);
    expect(exposure.totalRaw > 0n).toBe(true);
    const summary = t.portfolio.summary();
    expect(summary.paper).toBe(true);
    expect(summary.tokensLamports > 0n).toBe(true);

    // ---- self-trade guard blocks an immediate sell
    const blocked = await t.positions.previewSellPercent({ mint: MINT, pct: 50, slippageBps: 300, priority: { level: 'none' }, timing: { kind: 'simultaneous', concurrency: 4 } });
    expect(blocked.blockers.join()).toMatch(/self-trade guard/);
    t.updateSecurity({ selfTradeCooldownSec: 0 });

    // ---- staged exit rule fires on a price jump and auto-executes in SIMULATION
    const ruleId = t.positions.addExitRule({ mint: MINT, spec: { takeProfits: [{ gainPct: 50, sellPct: 25 }, { gainPct: 100, sellPct: 25 }], stopLossPct: 40 }, strategyTag: 'test-strat' });
    t.positions.setAutomation({ autoExecute: true, slippageBps: 2_000, priority: { level: 'none' } });
    const avgEntry = t.portfolio.token(MINT)!.avgEntrySolPerToken!;
    // price triples: pool reserves move (someone else bought)
    (t.swap as any).addPool(MINT, sol('900'), 555_555_555_555_556n);
    const alerts = await t.positions.onPriceTick([{ mint: MINT, usd: avgEntry * 3.1 * 150, sol: avgEntry * 3.1, at: Date.now(), source: 'test' }]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.executed).toBe(true);
    expect(alerts[0]!.message).toMatch(/take profit #1.*take profit #2/);
    const sells = t.repos.fills.list({ paper: true }).filter((f) => f.side === 'SELL');
    expect(sells).toHaveLength(9);
    const rule = t.positions.listExitRules(false).find((r) => r.id === ruleId)!;
    expect(rule.state.firedTiers).toEqual([0, 1]);
    expect(rule.active).toBe(true); // 50% still held with stop loss armed

    // ---- analytics: realized profit recorded per strategy
    const stats = computeTradeStats(t.repos.fills.list({ paper: true }));
    expect(stats.pnlByStrategy['test-strat']! > 0n).toBe(true);
    expect(stats.openTrades).toBe(9);

    // ---- emergency exit closes everything
    const [exitPlan] = await t.positions.previewEmergencyExit({ mints: [MINT] });
    expect(exitPlan!.legs).toHaveLength(9);
    await t.engine.execute(exitPlan!.id, exitPlan!.hash);
    await t.refreshBalances();
    expect(t.portfolio.token(MINT)).toBeUndefined();
    const stats2 = computeTradeStats(t.repos.fills.list({ paper: true }));
    expect(stats2.closedTrades).toBe(9);
    expect(stats2.winRatePct).toBe(100);

    // ---- consolidate SOL back to primary
    const before = (await t.engine.balances([primary]))[0]!.lamports;
    const cons = await t.positions.previewConsolidation({ wallets: others, includeSol: true, tokens: true, closeEmptyAccounts: false });
    expect(cons.blockers).toEqual([]);
    const expected = BigInt(String(cons.params.expectedSolReceived));
    expect(expected > sol('9')).toBe(true); // profits came back too
    const cres = await t.engine.execute(cons.id, cons.hash);
    expect(cres.status).toBe('DONE');
    const after = (await t.engine.balances([primary]))[0]!.lamports;
    expect(after - before).toBe(expected);

    // ---- audit trail has every leg
    expect(t.repos.audit.list({ limit: 1000 }).length).toBeGreaterThanOrEqual(9 + 9 + 9 + 9 + 9);
  });

  it('expires plans and refuses execution across mode changes', async () => {
    const { t, others } = await boot();
    await t.setMode('SIMULATION');
    t.engine.paperDeposit(t.wallets.primary()!.publicKey, sol('5'));
    t.updateSecurity({ planTtlSec: 10 });
    const p = await t.engine.previewDistribution({ recipients: others.slice(0, 2), total: sol('1'), spec: { kind: 'equal' }, priority: { level: 'none' } });
    // tampering with the stored plan breaks the hash
    t.repos.db.run(`UPDATE plans SET body_json = json_set(body_json, '$.title', 'tampered') WHERE id = ?`, p.id);
    await expect(t.engine.execute(p.id, p.hash)).rejects.toSatisfy((e) => isTerminalError(e, 'PLAN_MISMATCH'));

    const pe = await t.engine.previewDistribution({ recipients: others.slice(0, 2), total: sol('1'), spec: { kind: 'equal' }, priority: { level: 'none' } });
    const realNow = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 11_000);
    try {
      await expect(t.engine.execute(pe.id, pe.hash)).rejects.toSatisfy((e) => isTerminalError(e, 'PLAN_EXPIRED'));
    } finally {
      spy.mockRestore();
    }

    const p2 = await t.engine.previewDistribution({ recipients: others.slice(0, 2), total: sol('1'), spec: { kind: 'equal' }, priority: { level: 'none' } });
    await t.setMode('READ_ONLY');
    await expect(t.engine.execute(p2.id, p2.hash)).rejects.toSatisfy((e) => isTerminalError(e, 'MODE_FORBIDDEN'));
  });

  it('blocks distributions to non-whitelisted addresses and over-funded sources', async () => {
    const { t, primary } = await boot();
    await t.setMode('SIMULATION');
    t.engine.paperDeposit(primary, sol('1'));
    const stranger = Keypair.generate().publicKey.toBase58();
    const p = await t.engine.previewDistribution({ recipients: [stranger], total: sol('0.1'), spec: { kind: 'equal' }, priority: { level: 'none' } });
    expect(p.blockers.join()).toMatch(/not whitelisted/);
    t.repos.whitelist.add(stranger, 'cold wallet');
    const p2 = await t.engine.previewDistribution({ recipients: [stranger], total: sol('5'), spec: { kind: 'equal' }, priority: { level: 'none' } });
    expect(p2.blockers.join()).toMatch(/below the required reserve/);
    await expect(t.engine.execute(p2.id, p2.hash)).rejects.toThrow(/blockers/);
  });

  it('locks the vault and demotes LIVE on lock', async () => {
    const { t } = await boot();
    t.mode.set('LIVE', { reauthenticated: true }); // simulate an online LIVE session
    t.session.lock();
    expect(t.mode.current).toBe('SIMULATION');
    expect(t.vault.isUnlocked()).toBe(false);
    expect(() => t.wallets.generate({ count: 1 })).toThrow(/Unlock/);
    expect(WSOL_MINT).toBeTruthy();
  });
});
