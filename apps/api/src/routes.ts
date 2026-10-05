import { z } from 'zod';
import { solToLamports, TerminalError, type OperatingMode, type RiskPolicy, type StrategyPreset } from '@term/core';
import { computeTradeStats, fillsCsv, pnlBreakdownCsv, tradesCsv } from '@term/portfolio';
import type { Terminal } from '@term/runtime';
import { Raw, type Router } from './http';
import * as S from './schemas';

export interface RouteDeps {
  term: Terminal;
  /** Issues a new API token (on init/unlock) */
  onUnlocked: (token: string) => void;
  unlockGuard: { check(): void; fail(): void; succeed(): void };
}

export function registerRoutes(r: Router, { term, onUnlocked, unlockGuard }: RouteDeps): void {
  const t = term;

  // ---------------------------------------------------------------- session / vault / mode
  r.get(
    '/api/status',
    () => ({
      initialized: t.vault.isInitialized(),
      ...t.session.status(),
      mode: t.mode.current,
      offline: t.config.offline,
      walletCount: t.repos.wallets.count(),
      rpc: t.pool?.health() ?? [],
      solUsd: t.prices.solUsd(),
    }),
    { public: true },
  );

  r.post(
    '/api/vault/init',
    async ({ body }) => {
      const { password } = z.object({ password: S.password }).parse(body);
      await t.vault.initialize(password);
      const token = t.session.start();
      onUnlocked(token);
      return { token };
    },
    { public: true },
  );

  r.post(
    '/api/vault/unlock',
    async ({ body }) => {
      unlockGuard.check();
      const { password } = z.object({ password: S.password }).parse(body);
      try {
        const token = await t.session.unlock(password);
        unlockGuard.succeed();
        onUnlocked(token);
        return { token };
      } catch (e) {
        unlockGuard.fail();
        throw e;
      }
    },
    { public: true },
  );

  r.post('/api/vault/lock', () => {
    t.session.lock();
    return { locked: true };
  });

  r.post('/api/vault/password', async ({ body }) => {
    const b = z.object({ oldPassword: S.password, newPassword: S.password }).parse(body);
    await t.vault.changePassword(b.oldPassword, b.newPassword);
    return { changed: true };
  });

  r.post('/api/mode', async ({ body }) => {
    const b = S.modeBody.parse(body);
    return { mode: await t.setMode(b.mode as OperatingMode, b.password) };
  });

  // ---------------------------------------------------------------- wallets
  r.get('/api/wallets', ({ query }) =>
    t.wallets.list({ includeArchived: query.get('archived') === '1', group: query.get('group') ?? undefined, tag: query.get('tag') ?? undefined }),
  );
  r.get('/api/wallets/groups', () => t.wallets.groups());
  r.post('/api/wallets/generate', ({ body }) => {
    const b = S.generateBody.parse(body);
    return t.wallets.generate({ count: b.count, group: b.group ?? null, labelPrefix: b.labelPrefix, tags: b.tags });
  });
  r.post('/api/wallets/import', ({ body }) => {
    const b = S.importBody.parse(body);
    return t.wallets.importSecret(b.secret, { label: b.label, group: b.group ?? null });
  });
  r.post('/api/wallets/import-bundle', async ({ body }) => {
    const b = z.object({ bundle: z.any(), exportPassword: S.password }).parse(body);
    return t.wallets.importEncrypted(b.bundle, b.exportPassword);
  });
  r.post('/api/wallets/export', async ({ body }) => {
    const b = z.object({ publicKeys: z.array(S.pubkey).min(1), exportPassword: S.password }).parse(body);
    return t.wallets.exportEncrypted(b.publicKeys, b.exportPassword);
  });
  r.get('/api/wallets/export.csv', () => new Raw(t.wallets.exportPublicCsv(), 'text/csv', 'wallets.csv'));
  r.patch('/api/wallets/:pk', ({ params, body }) => t.wallets.update(params.pk!, S.walletPatch.parse(body)));
  r.post('/api/wallets/bulk', ({ body }) => {
    const b = z.object({ publicKeys: z.array(S.pubkey).min(1), patch: S.walletPatch.omit({ label: true }) }).parse(body);
    return { updated: t.wallets.bulkUpdate(b.publicKeys, b.patch) };
  });
  r.post('/api/wallets/:pk/primary', ({ params }) => {
    t.wallets.setPrimary(params.pk!);
    return { primary: params.pk };
  });
  r.get('/api/wallets/:pk', async ({ params }) => {
    const wallet = t.wallets.get(params.pk!);
    const view = t.portfolio.wallets().find((w) => w.wallet.publicKey === wallet.publicKey) ?? null;
    let chainHistory: unknown[] = [];
    if (t.client) chainHistory = await t.client.getSignatures(wallet.publicKey, 25).catch(() => []);
    return { wallet, view, audit: t.portfolio.walletHistory(wallet.publicKey, 100), chainHistory };
  });
  r.post('/api/balances/refresh', async () => t.refreshBalances());

  // ---------------------------------------------------------------- portfolio
  r.get('/api/portfolio/summary', () => t.portfolio.summary());
  r.get('/api/portfolio/wallets', () => t.portfolio.wallets());
  r.get('/api/portfolio/tokens', () => t.portfolio.tokens());
  r.get('/api/portfolio/tokens/:mint', ({ params }) => {
    const tok = t.portfolio.token(params.mint!);
    if (!tok) throw new TerminalError('NOT_FOUND', 'No position in this token');
    return { token: tok, exitRules: t.positions.listExitRules(true).filter((x) => x.mint === params.mint), priceHistory: t.repos.snapshots.priceHistory(params.mint!, Date.now() - 7 * 86_400_000) };
  });
  r.get('/api/prices', () => t.prices.all());

  // ---------------------------------------------------------------- tokens
  r.post('/api/tokens/analyze', async ({ body }) => {
    const b = z.object({ mint: S.pubkey, policy: S.riskPolicy.partial().optional(), weights: z.record(z.string(), z.number()).optional() }).parse(body);
    return t.analyzeToken(b.mint, { policy: b.policy, weights: b.weights as never });
  });
  r.get('/api/tokens/recent', () =>
    t.repos.snapshots.recentTokens(50).map((x) => ({ ...x, meta: t.repos.snapshots.tokenMeta(x.mint) ?? null, price: t.prices.get(x.mint) ?? null })),
  );

  // ---------------------------------------------------------------- plans
  r.post('/api/plans/distribute', ({ body }) => t.engine.previewDistribution(S.distributeBody.parse(body)));

  r.post('/api/plans/trade', async ({ body }) => {
    const b = S.tradeBody.parse(body);
    let risk = null;
    const extraBlockers: string[] = [];
    if (b.enforceRisk !== false && b.side === 'BUY') {
      const preset = b.strategyTag ? t.repos.strategies.get(b.strategyTag) : undefined;
      const res = await t.analyzeToken(b.mint, { policy: preset?.risk });
      risk = res.risk;
      extraBlockers.push(...res.risk.blockers.map((x) => `risk policy: ${x}`));
      b.maxPriceImpactPct ??= preset?.risk.maxPriceImpactPct;
    }
    const plan = await t.engine.previewTrade({ ...b, strategyTag: b.strategyTag ?? null, extraBlockers });
    return { plan, risk };
  });

  r.post('/api/plans/sell-percent', ({ body }) => {
    const b = z.object({ mint: S.pubkey, pct: z.number().gt(0).max(100), wallets: z.array(S.pubkey).optional(), ...S.execDefaults }).parse(body);
    return t.positions.previewSellPercent(b);
  });
  r.post('/api/plans/sell-amounts', ({ body }) => {
    const b = z.object({ mint: S.pubkey, amounts: z.record(z.string(), S.big), ...S.execDefaults }).parse(body);
    return t.positions.previewSellAmounts(b);
  });
  r.post('/api/plans/emergency-exit', ({ body }) => {
    const b = z.object({ mints: z.array(S.pubkey).optional(), slippageBps: z.number().int().min(1).max(5000).optional() }).parse(body);
    return t.positions.previewEmergencyExit(b);
  });
  r.post('/api/plans/consolidate', ({ body }) => {
    const b = z
      .object({
        wallets: z.array(S.pubkey).min(1),
        solDestination: S.pubkey.optional(),
        tokenDestination: S.pubkey.optional(),
        includeSol: z.boolean().optional(),
        tokens: z.union([z.boolean(), z.array(S.pubkey)]).optional(),
        closeEmptyAccounts: z.boolean().optional(),
        solReserve: S.big.optional(),
        priority: S.priority.optional(),
      })
      .parse(body);
    return t.positions.previewConsolidation(b);
  });
  r.post('/api/plans/rebalance', ({ body }) => t.positions.previewRebalance(z.object({ mint: S.pubkey, wallets: z.array(S.pubkey).min(2) }).parse(body)));

  r.get('/api/plans', () => t.repos.plans.list(100));
  r.get('/api/plans/:id', ({ params }) => {
    const p = t.engine.getPlan(params.id!);
    return { ...p, audit: t.repos.audit.byPlan(params.id!) };
  });
  r.post('/api/plans/:id/execute', ({ params, body }) => {
    const { hash } = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/) }).parse(body);
    // Refusals (hash, expiry, mode, limits) throw here; execution continues in
    // the background and streams progress over the WebSocket.
    const { done } = t.engine.start(params.id!, hash);
    done.catch((e) => t.log.error('plan execution crashed', { planId: params.id, error: String(e) }));
    return { accepted: true, planId: params.id };
  });
  r.post('/api/plans/:id/cancel', ({ params }) => {
    t.engine.cancel(params.id!);
    return { cancelled: true };
  });

  // ---------------------------------------------------------------- transactions
  r.get('/api/transactions', ({ query }) =>
    t.repos.audit.list({
      wallet: query.get('wallet') ?? undefined,
      mint: query.get('mint') ?? undefined,
      mode: (query.get('mode') as OperatingMode) ?? undefined,
      limit: Math.min(1000, Number(query.get('limit') ?? 200)),
      offset: Number(query.get('offset') ?? 0),
    }),
  );
  r.get('/api/fills', ({ query }) => t.repos.fills.list({ paper: query.get('paper') === null ? undefined : query.get('paper') === '1' }));

  // ---------------------------------------------------------------- strategies / automation
  r.get('/api/strategies', () => t.repos.strategies.list());
  r.put('/api/strategies/:id', ({ params, body }) => {
    const b = S.strategyBody.parse({ ...(body as object), id: params.id });
    const existing = t.repos.strategies.get(b.id);
    if (existing?.builtin) throw new TerminalError('VALIDATION', 'Built-in presets are read-only; save as a new id');
    const preset: StrategyPreset = { ...b, builtin: false, risk: b.risk as RiskPolicy };
    t.repos.strategies.upsert(preset);
    return preset;
  });
  r.delete('/api/strategies/:id', ({ params }) => {
    t.repos.strategies.remove(params.id!);
    return { deleted: true };
  });
  r.get('/api/exit-rules', ({ query }) => t.positions.listExitRules(query.get('all') !== '1'));
  r.post('/api/exit-rules', ({ body }) => {
    const b = z.object({ mint: S.pubkey, wallets: z.array(S.pubkey).optional(), spec: S.exitSpec, strategyTag: z.string().nullish() }).parse(body);
    return { id: t.positions.addExitRule(b) };
  });
  r.delete('/api/exit-rules/:id', ({ params }) => {
    t.positions.removeExitRule(Number(params.id));
    return { deleted: true };
  });
  r.get('/api/triggers', () => t.repos.triggers.list(false));
  r.post('/api/triggers', ({ body }) => {
    const b = z
      .object({
        mint: S.pubkey,
        side: z.enum(['BUY', 'SELL']),
        condition: z.enum(['PRICE_LTE', 'PRICE_GTE']),
        priceSol: z.number().positive(),
        request: S.tradeBody.omit({ mint: true, side: true, enforceRisk: true }),
      })
      .parse(body);
    return { id: t.positions.addTriggerOrder(b) };
  });
  r.delete('/api/triggers/:id', ({ params }) => {
    t.repos.triggers.cancel(Number(params.id));
    return { cancelled: true };
  });
  r.get('/api/automation', () => t.positions.automation());
  r.put('/api/automation', ({ body }) =>
    t.positions.setAutomation(
      z.object({ autoExecute: z.boolean().optional(), allowLive: z.boolean().optional(), slippageBps: z.number().int().min(1).max(5000).optional(), priority: S.priority.optional() }).parse(body),
    ),
  );

  // ---------------------------------------------------------------- analytics
  const paperFills = () => t.repos.fills.list({ paper: t.mode.current === 'SIMULATION' });
  r.get('/api/analytics', () => {
    const fills = paperFills();
    const stats = computeTradeStats(fills);
    return { ...stats, fillCount: fills.length, paper: t.mode.current === 'SIMULATION' };
  });
  const sym = (m: string) => t.repos.snapshots.tokenMeta(m)?.symbol ?? null;
  r.get('/api/analytics/trades.csv', () => new Raw(tradesCsv(paperFills(), sym), 'text/csv', 'trades.csv'));
  r.get('/api/analytics/fills.csv', () => new Raw(fillsCsv(paperFills()), 'text/csv', 'fills.csv'));
  r.get('/api/analytics/pnl.csv', () => new Raw(pnlBreakdownCsv(computeTradeStats(paperFills())), 'text/csv', 'pnl.csv'));

  // ---------------------------------------------------------------- settings
  r.get('/api/settings/security', () => t.security());
  r.put('/api/settings/security', ({ body }) => {
    const b = S.securityPatch.parse(body);
    return t.updateSecurity(b as never);
  });
  r.get('/api/whitelist', () => t.repos.whitelist.list());
  r.post('/api/whitelist', ({ body }) => {
    const b = z.object({ address: S.pubkey, label: z.string().min(1).max(64) }).parse(body);
    t.repos.whitelist.add(b.address, b.label);
    return { added: true };
  });
  r.delete('/api/whitelist/:address', ({ params }) => {
    t.repos.whitelist.remove(params.address!);
    return { removed: true };
  });
  r.get('/api/rpc/health', () => t.pool?.health() ?? []);

  // ---------------------------------------------------------------- paper trading helpers
  r.post('/api/paper/deposit', ({ body }) => {
    const b = z.object({ wallet: S.pubkey, sol: z.string().regex(/^\d+(\.\d+)?$/) }).parse(body);
    t.engine.paperDeposit(b.wallet, solToLamports(b.sol));
    return { deposited: true };
  });
  r.post('/api/paper/seed-market', ({ body }) => {
    const b = z
      .object({ mint: S.pubkey, symbol: z.string().max(16), decimals: z.number().int().min(0).max(12), solReserve: S.big, tokenReserve: S.big, solUsd: z.number().positive() })
      .parse(body);
    t.seedMockMarket(b);
    return { seeded: true };
  });
}
