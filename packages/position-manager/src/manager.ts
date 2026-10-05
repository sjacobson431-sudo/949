import { EventEmitter } from 'node:events';
import {
  errorMessage,
  pctOf,
  PRIORITY_MICROLAMPORTS,
  silentLogger,
  TerminalError,
  WSOL_MINT,
  type ExecutionTiming,
  type ExitRuleSpec,
  type Logger,
  type OperatingMode,
  type Plan,
  type PriceQuote,
  type PrioritySettings,
  type Side,
} from '@term/core';
import type { ExitRuleRecord, Repositories, TriggerOrderRecord } from '@term/database';
import type { ExecutionEngine, TradeRequest } from '@term/execution-engine';
import { buildLedger, lotKey, type PortfolioService } from '@term/portfolio';
import { evaluateExitRule, validateExitSpec } from './exit-rules';
import { planConsolidation, planTokenRebalance } from './consolidation';

export interface ExecDefaults {
  slippageBps: number;
  priority: PrioritySettings;
  timing: ExecutionTiming;
}

export interface AutomationSettings {
  /** Execute exit/trigger plans automatically. When false, plans are created and an alert is raised. */
  autoExecute: boolean;
  /** Auto-execution is allowed in LIVE mode only when this is also true. */
  allowLive: boolean;
  slippageBps: number;
  priority: PrioritySettings;
}

export const DEFAULT_AUTOMATION: AutomationSettings = {
  autoExecute: false,
  allowLive: false,
  slippageBps: 1_000,
  priority: { level: 'high' },
};

export interface AutomationAlert {
  kind: 'exit' | 'trigger';
  ruleId: number;
  mint: string;
  message: string;
  planId: string | null;
  executed: boolean;
  at: number;
}

interface ManagerEvents {
  alert: [AutomationAlert];
}

/**
 * Position management across many wallets: percentage / per-wallet sells,
 * emergency exits, consolidation, rent reclaim, rebalancing, and automated
 * exit rules + trigger (limit-style) orders evaluated on price ticks.
 */
export class PositionManager extends EventEmitter<ManagerEvents> {
  private evaluating = false;

  constructor(
    private readonly repos: Repositories,
    private readonly engine: ExecutionEngine,
    private readonly portfolio: PortfolioService,
    private readonly mode: () => OperatingMode,
    private readonly log: Logger = silentLogger,
  ) {
    super();
  }

  private walletsHolding(mint: string, wallets?: string[]): string[] {
    const t = this.portfolio.token(mint);
    const holders = t?.wallets.filter((w) => w.raw > 0n).map((w) => w.wallet) ?? [];
    return wallets ? holders.filter((w) => wallets.includes(w)) : holders;
  }

  /** Sell X% of each selected wallet's holding (all holders by default). */
  previewSellPercent(p: { mint: string; pct: number; wallets?: string[] } & ExecDefaults & { strategyTag?: string | null }): Promise<Plan> {
    const wallets = this.walletsHolding(p.mint, p.wallets);
    if (!wallets.length) throw new TerminalError('VALIDATION', 'No selected wallet holds this token');
    return this.engine.previewTrade({
      kind: 'EXIT', mint: p.mint, side: 'SELL', wallets, sizing: { kind: 'percentOfWallet', pct: p.pct },
      timing: p.timing, slippageBps: p.slippageBps, priority: p.priority, strategyTag: p.strategyTag ?? null,
      title: `Sell ${p.pct}% of position from ${wallets.length} wallet(s)`,
    });
  }

  /** Sell exact raw token amounts from specific wallets. */
  previewSellAmounts(p: { mint: string; amounts: Record<string, bigint>; strategyTag?: string | null; title?: string } & ExecDefaults): Promise<Plan> {
    return this.engine.previewTrade({
      kind: 'EXIT', mint: p.mint, side: 'SELL', wallets: Object.keys(p.amounts), sizing: { kind: 'perWallet', amounts: p.amounts },
      timing: p.timing, slippageBps: p.slippageBps, priority: p.priority, strategyTag: p.strategyTag ?? null, title: p.title,
    });
  }

  /**
   * Emergency exit: 100% of every holding of the given mints (or all held
   * tokens), simultaneous, wide slippage, top priority. Still previewed and
   * confirmed — it just has aggressive defaults.
   */
  async previewEmergencyExit(p: { mints?: string[]; slippageBps?: number } = {}): Promise<Plan[]> {
    const mints = p.mints ?? this.portfolio.tokens().filter((t) => t.totalRaw > 0n && t.mint !== WSOL_MINT).map((t) => t.mint);
    const plans: Plan[] = [];
    for (const mint of mints) {
      const wallets = this.walletsHolding(mint);
      if (!wallets.length) continue;
      plans.push(
        await this.engine.previewTrade({
          kind: 'EXIT', mint, side: 'SELL', wallets, sizing: { kind: 'percentOfWallet', pct: 100 },
          timing: { kind: 'simultaneous', concurrency: 16 }, slippageBps: p.slippageBps ?? 2_500, priority: { level: 'turbo' },
          strategyTag: 'emergency-exit', title: `EMERGENCY EXIT ${mint.slice(0, 6)}… from ${wallets.length} wallet(s)`,
        }),
      );
    }
    return plans;
  }

  async previewConsolidation(p: {
    wallets: string[];
    solDestination?: string;
    tokenDestination?: string;
    includeSol?: boolean;
    tokens?: boolean | string[];
    closeEmptyAccounts?: boolean;
    solReserve?: bigint;
    priority?: PrioritySettings;
  }): Promise<Plan> {
    const solDestination = p.solDestination ?? this.repos.wallets.primary()?.publicKey;
    if (!solDestination) throw new TerminalError('VALIDATION', 'No destination: set a primary wallet first');
    const tokenDest = p.tokenDestination ?? solDestination;
    const balances = await this.engine.balances([...new Set([...p.wallets, tokenDest])]);
    const destBal = balances.find((b) => b.publicKey === tokenDest);
    const lvl = p.priority?.level;
    const micro = lvl && lvl !== 'custom' ? PRIORITY_MICROLAMPORTS[lvl] : PRIORITY_MICROLAMPORTS.low;
    const r = planConsolidation({
      balances: balances.filter((b) => p.wallets.includes(b.publicKey)),
      solDestination,
      tokenDestination: tokenDest,
      includeSol: p.includeSol ?? true,
      tokens: p.tokens ?? true,
      closeEmptyAccounts: p.closeEmptyAccounts ?? true,
      solReserve: p.solReserve ?? 0n,
      microLamportsPerCu: micro,
      destinationHasAccount: new Set(destBal?.tokens.map((t) => t.mint) ?? []),
      labelOf: (pk) => this.repos.wallets.byPublicKey(pk)?.label ?? pk.slice(0, 6),
    });
    const blockers: string[] = [];
    for (const l of r.legs) {
      if (l.kind === 'TOKEN_TRANSFER' && l.mint && this.engine.inFlightMints.has(l.mint)) blockers.push(`a trade in ${l.mint} is executing`);
    }
    return this.engine.createPlan({
      kind: 'CONSOLIDATE',
      title: `Consolidate ${r.wallets.length} wallet(s): ~${(Number(r.expectedSolReceived) / 1e9).toFixed(4)} SOL to ${this.repos.wallets.byPublicKey(solDestination)?.label ?? 'primary'}`,
      params: {
        solDestination, tokenDestination: tokenDest, microLamports: micro, concurrency: 8,
        expectedSolReceived: r.expectedSolReceived, totalRentReclaimed: r.totalRentReclaimed, perWallet: r.wallets,
      },
      legs: r.legs,
      warnings: r.warnings,
      blockers,
    });
  }

  async previewRebalance(p: { mint: string; wallets: string[] }): Promise<Plan> {
    const balances = await this.engine.balances(p.wallets);
    const holdings = balances.map((b) => {
      const t = b.tokens.find((x) => x.mint === p.mint);
      return { wallet: b.publicKey, raw: t?.amountRaw ?? 0n, tokenAccount: t?.tokenAccount ?? '', programId: t?.programId ?? '', decimals: t?.decimals ?? 0 };
    });
    const programId = holdings.find((h) => h.programId)?.programId ?? '';
    const decimals = holdings.find((h) => h.programId)?.decimals ?? 0;
    const legs = planTokenRebalance(holdings.map((h) => ({ ...h, programId: h.programId || programId, decimals: h.decimals || decimals })), p.mint, PRIORITY_MICROLAMPORTS.low);
    return this.engine.createPlan({
      kind: 'CONSOLIDATE', title: `Rebalance ${p.mint.slice(0, 6)}… across ${p.wallets.length} wallets`,
      params: { mint: p.mint, microLamports: PRIORITY_MICROLAMPORTS.low, concurrency: 8 }, legs,
      blockers: this.engine.inFlightMints.has(p.mint) ? ['a trade in this token is executing'] : [],
    });
  }

  // ---------------------------------------------------------------- exit rules

  addExitRule(p: { mint: string; wallets?: string[]; spec: ExitRuleSpec; strategyTag?: string | null }): number {
    const problems = validateExitSpec(p.spec);
    if (problems.length) throw new TerminalError('VALIDATION', problems.join('; '));
    const t = this.portfolio.token(p.mint);
    const holders = (t?.wallets ?? []).filter((w) => w.raw > 0n && (!p.wallets || p.wallets.includes(w.wallet)));
    if (!holders.length) throw new TerminalError('VALIDATION', 'No selected wallet holds this token');
    const baselineByWallet = Object.fromEntries(holders.map((w) => [w.wallet, w.raw]));
    return this.repos.exitRules.insert({
      mint: p.mint,
      wallets: holders.map((w) => w.wallet),
      spec: p.spec,
      state: { baselineQtyRaw: holders.reduce((s, w) => s + w.raw, 0n), baselineByWallet, peakSolPerToken: 0, firedTiers: [], stopped: false },
      strategyTag: p.strategyTag ?? null,
    });
  }

  listExitRules(activeOnly = true): ExitRuleRecord[] {
    return this.repos.exitRules.list(activeOnly);
  }

  removeExitRule(id: number): void {
    this.repos.exitRules.deactivate(id);
  }

  addTriggerOrder(p: { mint: string; side: Side; condition: 'PRICE_LTE' | 'PRICE_GTE'; priceSol: number; request: Omit<TradeRequest, 'mint' | 'side'> }): number {
    if (!(p.priceSol > 0)) throw new TerminalError('VALIDATION', 'trigger price must be positive');
    return this.repos.triggers.insert({ mint: p.mint, side: p.side, condition: p.condition, priceSol: p.priceSol, order: p.request as unknown as Record<string, unknown> });
  }

  automation(): AutomationSettings {
    return { ...DEFAULT_AUTOMATION, ...this.repos.settings.get<Partial<AutomationSettings>>('automation', {}) };
  }

  setAutomation(a: Partial<AutomationSettings>): AutomationSettings {
    const next = { ...this.automation(), ...a };
    this.repos.settings.set('automation', next);
    return next;
  }

  /**
   * Evaluate all active exit rules and trigger orders against new prices.
   * Wired to PriceService 'tick'. Never runs in READ_ONLY mode.
   */
  async onPriceTick(quotes: PriceQuote[]): Promise<AutomationAlert[]> {
    if (this.evaluating || this.mode() === 'READ_ONLY') return [];
    this.evaluating = true;
    const alerts: AutomationAlert[] = [];
    try {
      const prices = new Map(quotes.map((q) => [q.mint, q.sol]));
      const auto = this.automation();
      const fills = this.repos.fills.list({ paper: this.mode() === 'SIMULATION' });
      const { lots } = buildLedger(fills);

      for (const rule of this.repos.exitRules.list(true)) {
        const price = prices.get(rule.mint);
        if (!price) continue;
        let qty = 0n;
        let cost = 0n;
        let decimals = 0;
        for (const w of rule.wallets) {
          const l = lots.get(lotKey(w, rule.mint));
          if (l) {
            qty += l.qtyRaw;
            cost += l.costLamports;
            decimals = l.decimals;
          }
        }
        if (qty === 0n) continue;
        const avgEntry = Number(cost) / 1e9 / (Number(qty) / 10 ** decimals);
        const ev = evaluateExitRule(rule.spec, rule.state, avgEntry, price);
        this.repos.exitRules.updateState(rule.id, ev.state, !ev.state.stopped);
        if (!ev.action) continue;
        const amounts: Record<string, bigint> = {};
        for (const w of rule.wallets) {
          const cur = lots.get(lotKey(w, rule.mint))?.qtyRaw ?? 0n;
          const want = ev.action.kind === 'all' ? cur : pctOf(rule.state.baselineByWallet[w] ?? 0n, ev.action.pctOfBaseline);
          const amt = want > cur ? cur : want;
          if (amt > 0n) amounts[w] = amt;
        }
        const msg = ev.action.kind === 'all' ? ev.action.reason : ev.action.reasons.join('; ');
        alerts.push(await this.dispatch('exit', rule.id, rule.mint, msg, auto, () =>
          this.previewSellAmounts({
            mint: rule.mint, amounts, slippageBps: auto.slippageBps, priority: auto.priority, timing: { kind: 'simultaneous', concurrency: 8 },
            strategyTag: rule.strategyTag, title: `Exit rule #${rule.id}: ${msg}`,
          }),
        ));
      }

      for (const t of this.repos.triggers.list(true)) {
        const price = prices.get(t.mint);
        if (!price) continue;
        const hit = t.condition === 'PRICE_LTE' ? price <= t.priceSol : price >= t.priceSol;
        if (!hit) continue;
        this.repos.triggers.markFired(t.id);
        alerts.push(await this.dispatch('trigger', t.id, t.mint, `${t.side} trigger: price ${price.toPrecision(4)} ${t.condition === 'PRICE_LTE' ? '≤' : '≥'} ${t.priceSol}`, auto, () =>
          this.engine.previewTrade({ ...(t.order as unknown as TradeRequest), mint: t.mint, side: t.side, strategyTag: (t.order as { strategyTag?: string }).strategyTag ?? 'trigger' }),
        ));
      }
    } finally {
      this.evaluating = false;
    }
    return alerts;
  }

  private async dispatch(
    kind: AutomationAlert['kind'],
    ruleId: number,
    mint: string,
    message: string,
    auto: AutomationSettings,
    build: () => Promise<Plan>,
  ): Promise<AutomationAlert> {
    const alert: AutomationAlert = { kind, ruleId, mint, message, planId: null, executed: false, at: Date.now() };
    try {
      const plan = await build();
      alert.planId = plan.id;
      const canAuto = auto.autoExecute && (this.mode() === 'SIMULATION' || (this.mode() === 'LIVE' && auto.allowLive));
      if (canAuto && plan.blockers.length === 0) {
        await this.engine.execute(plan.id, plan.hash);
        alert.executed = true;
      } else if (plan.blockers.length) {
        alert.message += ` — plan blocked: ${plan.blockers.join('; ')}`;
      } else {
        alert.message += ' — plan ready for confirmation';
      }
    } catch (e) {
      alert.message += ` — failed: ${errorMessage(e)}`;
      this.log.error('automation failed', { kind, ruleId, error: errorMessage(e) });
    }
    this.emit('alert', alert);
    return alert;
  }
}

export type { TriggerOrderRecord };
