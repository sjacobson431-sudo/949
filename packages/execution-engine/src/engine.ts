import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { VersionedTransaction } from '@solana/web3.js';
import {
  canonicalJson,
  CU_SOL_TRANSFER,
  CU_SWAP,
  cryptoRng,
  errorMessage,
  formatSol,
  MAX_TRANSFERS_PER_TX,
  RENT_EXEMPT_TOKEN_ACCOUNT,
  silentLogger,
  sumBig,
  TerminalError,
  WSOL_MINT,
  type AllocationConstraints,
  type AllocationSpec,
  type ExecutionTiming,
  type Logger,
  type OperatingMode,
  type OrderSizing,
  type Plan,
  type PlanKind,
  type PlannedTx,
  type PlanStatus,
  type PrioritySettings,
  type Rng,
  type SecuritySettings,
  type Side,
  type SwapQuote,
  type TxStatus,
  type WalletBalance,
} from '@term/core';
import type { Repositories } from '@term/database';
import type { DestinationPolicy, ModeGuard, Outflow, SelfTradeGuard, SpendingLimiter } from '@term/security';
import {
  associatedTokenAddress,
  buildCloseAccounts,
  buildSolTransfers,
  buildTokenTransfer,
  estimateGasReserve,
  estimateTxFee,
  inspectThirdPartyTx,
  microLamportsFor,
  priorityLamportsFor,
  type SolanaClient,
} from '@term/solana-client';
import { planDistribution, planOrders, type SwapProvider } from '@term/trade-engine';
import type { TransactionSigner } from '@term/wallet-manager';
import { applyPaperOverlay } from './paper';

export interface TokenInfo {
  decimals: number;
  programId: string;
  symbol: string | null;
}

export interface BalanceReader {
  /** Real chain balances (or empty balances when offline). */
  get(publicKeys: string[]): Promise<WalletBalance[]>;
}

export interface EngineDeps {
  repos: Repositories;
  client: SolanaClient | null;
  swap: SwapProvider;
  signer: TransactionSigner;
  mode: ModeGuard;
  limiter: SpendingLimiter;
  destinations: DestinationPolicy;
  selfTrade: SelfTradeGuard;
  balances: BalanceReader;
  tokenInfo: (mint: string) => Promise<TokenInfo>;
  security: () => SecuritySettings;
  /** Called after each paper fill so offline markets can move. */
  onPaperFill?: (q: SwapQuote) => void;
  log?: Logger;
  rng?: Rng;
  now?: () => number;
}

export interface TradeRequest {
  mint: string;
  side: Side;
  wallets: string[];
  sizing: OrderSizing;
  timing: ExecutionTiming;
  slippageBps: number;
  priority: PrioritySettings;
  strategyTag?: string | null;
  maxPriceImpactPct?: number;
  /** Lamports each wallet keeps for fees (BUY). Default: auto. */
  gasReserve?: bigint;
  simulate?: boolean;
  title?: string;
  kind?: Extract<PlanKind, 'TRADE' | 'EXIT'>;
  /** Pre-trade checks done by the caller (e.g. risk policy) that must block execution. */
  extraBlockers?: string[];
  extraWarnings?: string[];
}

export interface DistributionRequest {
  source?: string;
  recipients: string[];
  total: bigint;
  spec: AllocationSpec;
  constraints?: AllocationConstraints;
  /** Extra lamports per recipient for its future fees; 'auto' estimates it. */
  gasReserve?: bigint | 'auto';
  autoGas?: { expectedTxs: number; newTokenAccounts: number };
  priority: PrioritySettings;
  simulate?: boolean;
}

export interface CustomPlanInput {
  kind: PlanKind;
  title: string;
  params: Record<string, unknown>;
  legs: PlannedTx[];
  warnings?: string[];
  blockers?: string[];
  strategyTag?: string | null;
}

export interface LegEvent {
  planId: string;
  legId: string;
  wallet: string;
  kind: PlannedTx['kind'];
  status: TxStatus;
  signature?: string | null;
  error?: string | null;
  at: number;
}

export interface PlanEvent {
  planId: string;
  status: PlanStatus;
  at: number;
  summary?: ExecutionSummary;
}

export interface ExecutionSummary {
  planId: string;
  status: PlanStatus;
  confirmed: number;
  failed: number;
  skipped: number;
  paper: number;
  legs: { legId: string; wallet: string; status: TxStatus; signature: string | null; error: string | null }[];
}

export interface FillEvent {
  wallet: string;
  mint: string;
  side: Side;
  solPerToken: number;
  paper: boolean;
}

interface EngineEvents {
  leg: [LegEvent];
  plan: [PlanEvent];
  fill: [FillEvent];
}

const DUMMY_BLOCKHASH = '11111111111111111111111111111111';

/**
 * The execution engine turns intents into immutable, hashed plans, and plans
 * into transactions. It is the only component that calls the signer and the
 * sender; every execution is checked against mode, plan hash/expiry, spending
 * limits, destination whitelist and the self-trade guard, and every leg is
 * written to the audit trail.
 */
export class ExecutionEngine extends EventEmitter<EngineEvents> {
  private readonly log: Logger;
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly cancelled = new Set<string>();
  private readonly running = new Set<string>();
  /** Mints with trade plans currently executing (blocks token transfers of the same mint). */
  readonly inFlightMints = new Set<string>();

  constructor(private readonly d: EngineDeps) {
    super();
    this.log = d.log ?? silentLogger;
    this.rng = d.rng ?? cryptoRng;
    this.now = d.now ?? (() => Date.now());
  }

  // ================================================================ balances

  /** Balances as the current mode sees them (SIMULATION adds the paper overlay). */
  async balances(publicKeys: string[]): Promise<WalletBalance[]> {
    const base = await this.d.balances.get(publicKeys);
    if (this.d.mode.current !== 'SIMULATION') return base;
    const rows = this.d.repos.db
      .all<{ id: number }>(`SELECT id FROM tx_audit WHERE status = 'PAPER_FILLED' AND (wallet IN (${publicKeys.map(() => '?').join(',') || "''"}) OR json_extract(details_json, '$.destination') IN (${publicKeys.map(() => '?').join(',') || "''"}))`, ...publicKeys, ...publicKeys)
      .map((r) => this.d.repos.audit.byId(Number(r.id))!);
    const set = new Set(publicKeys);
    return applyPaperOverlay(base, rows).filter((b) => set.has(b.publicKey));
  }

  /** SIMULATION only: credit a wallet with paper SOL (offline testing / what-if). */
  paperDeposit(wallet: string, lamports: bigint): void {
    if (this.d.mode.current !== 'SIMULATION') throw new TerminalError('MODE_FORBIDDEN', 'Paper deposits are only available in SIMULATION mode');
    this.d.repos.audit.insert({
      kind: 'SOL_TRANSFER', mode: 'SIMULATION', status: 'PAPER_FILLED', wallet: 'PAPER_FAUCET', lamportsDelta: lamports,
      internal: true, details: { destination: wallet, description: 'paper deposit' },
    });
  }

  // ================================================================ previews

  async previewDistribution(r: DistributionRequest): Promise<Plan> {
    this.d.mode.assertCanPlan();
    const source = r.source ?? this.d.repos.wallets.primary()?.publicKey;
    if (!source) throw new TerminalError('VALIDATION', 'No source wallet: set a primary wallet first');
    const recipients = r.recipients.filter((x) => x !== source);
    const bals = await this.balances([source, ...recipients]);
    const byPk = new Map(bals.map((b) => [b.publicKey, b]));
    const micro = await this.microLamports(r.priority, CU_SOL_TRANSFER * MAX_TRANSFERS_PER_TX, [source]);
    const feePerTx = estimateTxFee({ computeUnits: 300 + CU_SOL_TRANSFER * MAX_TRANSFERS_PER_TX, microLamportsPerCu: micro });
    const gas =
      r.gasReserve === 'auto'
        ? estimateGasReserve({ expectedTxs: r.autoGas?.expectedTxs ?? 4, newTokenAccounts: r.autoGas?.newTokenAccounts ?? 1, priority: r.priority })
        : r.gasReserve ?? 0n;

    const res = planDistribution({
      source: { publicKey: source, lamports: byPk.get(source)?.lamports ?? 0n },
      recipients: recipients.map((pk) => ({ publicKey: pk, lamports: byPk.get(pk)?.lamports ?? 0n })),
      total: r.total,
      spec: r.spec,
      constraints: r.constraints,
      gasReservePerWallet: gas,
      feePerTx,
      rng: this.rng,
    });

    const blockers = [...res.problems];
    for (const t of res.transfers) {
      if (!this.d.destinations.isAllowed(t.to)) blockers.push(`destination ${t.to} is not whitelisted`);
    }
    const legs: PlannedTx[] = res.transfers.map((t, i) => ({
      legId: legId(i),
      kind: 'SOL_TRANSFER',
      batch: t.batch,
      wallet: source,
      offsetMs: 0,
      description: `Send ${formatSol(t.lamports)} SOL → ${this.label(t.to)}${t.notes.length ? ` (${t.notes.join(', ')})` : ''}`,
      lamportsDelta: t.lamports,
      estFeeLamports: res.transfers.findIndex((x) => x.batch === t.batch) === i ? feePerTx : 0n,
      destination: t.to,
    }));

    if (r.simulate !== false && this.d.client && legs.length) {
      await this.simulateTransferBatches(source, legs, micro);
    }

    return this.createPlan({
      kind: 'DISTRIBUTE',
      title: `Distribute ${formatSol(res.totalLamports)} SOL to ${legs.length} wallets`,
      params: {
        source, total: r.total, spec: r.spec, constraints: r.constraints ?? {}, gasReservePerWallet: gas, priority: r.priority,
        microLamports: micro, sourceRemaining: res.sourceRemaining, txCount: res.txCount, concurrency: 1,
      },
      legs,
      warnings: res.warnings,
      blockers,
    });
  }

  async previewTrade(r: TradeRequest): Promise<Plan> {
    this.d.mode.assertCanPlan();
    if (r.mint === WSOL_MINT) throw new TerminalError('VALIDATION', 'Cannot trade SOL against itself');
    if (r.slippageBps < 1 || r.slippageBps > 5_000) throw new TerminalError('VALIDATION', 'slippage must be 1–5000 bps');
    const warnings: string[] = [...(r.extraWarnings ?? [])];
    const blockers: string[] = [...(r.extraBlockers ?? [])];
    const selfTrade = this.d.selfTrade.check(r.mint, r.side);
    if (selfTrade) blockers.push(selfTrade);

    const info = await this.d.tokenInfo(r.mint);
    const bals = await this.balances(r.wallets);
    const holding = (b: WalletBalance) => b.tokens.filter((t) => t.mint === r.mint).reduce((s, t) => s + t.amountRaw, 0n);
    const priorityLamports = priorityLamportsFor(r.priority, CU_SWAP, await this.dynamicPriority(r.priority, [r.mint]));
    const perTxFee = 5_000n + priorityLamports;
    const gasReserve =
      r.gasReserve ?? (r.side === 'BUY' ? estimateGasReserve({ expectedTxs: 3, priority: r.priority, newTokenAccounts: 1 }) : 0n);

    const planned = planOrders({
      side: r.side,
      wallets: bals.map((b) => ({ publicKey: b.publicKey, lamports: b.lamports, tokenRaw: holding(b) })),
      sizing: r.sizing,
      timing: r.timing,
      gasReserve,
      rng: this.rng,
    });
    for (const s of planned.skipped) warnings.push(`${this.label(s.wallet)} skipped: ${s.reason}`);
    if (r.side === 'SELL') {
      for (const b of bals) if (b.lamports < perTxFee) blockers.push(`${this.label(b.publicKey)} has too little SOL to pay the sell fee`);
    }

    const [inputMint, outputMint] = r.side === 'BUY' ? [WSOL_MINT, r.mint] : [r.mint, WSOL_MINT];
    const legs: PlannedTx[] = [];
    await mapLimit(planned.orders.map((o, i) => ({ o, i })), 6, async ({ o, i }) => {
      let quote: SwapQuote | undefined;
      try {
        quote = await this.d.swap.quote({ inputMint, outputMint, amount: o.inAmount, slippageBps: r.slippageBps });
      } catch (e) {
        blockers.push(`${this.label(o.wallet)}: quote failed: ${errorMessage(e)}`);
        return;
      }
      const max = r.maxPriceImpactPct;
      if (max !== undefined && quote.priceImpactPct > max) {
        blockers.push(`${this.label(o.wallet)}: price impact ${quote.priceImpactPct.toFixed(2)}% > max ${max}%`);
      }
      const b = bals.find((x) => x.publicKey === o.wallet)!;
      const needsAta = r.side === 'BUY' && holding(b) === 0n && !b.tokens.some((t) => t.mint === r.mint);
      legs.push({
        legId: legId(i),
        kind: 'SWAP',
        wallet: o.wallet,
        offsetMs: o.offsetMs,
        side: r.side,
        mint: r.mint,
        description:
          r.side === 'BUY'
            ? `Buy ~${fmtToken(quote.outAmount, info.decimals)} ${info.symbol ?? 'tokens'} for ${formatSol(o.inAmount)} SOL (min ${fmtToken(quote.minOutAmount, info.decimals)})${needsAta ? ' + token account rent' : ''}`
            : `Sell ${fmtToken(o.inAmount, info.decimals)} ${info.symbol ?? 'tokens'} for ~${formatSol(quote.outAmount)} SOL (min ${formatSol(quote.minOutAmount)})`,
        lamportsDelta: r.side === 'BUY' ? o.inAmount + (needsAta ? RENT_EXEMPT_TOKEN_ACCOUNT : 0n) : -quote.outAmount,
        tokenDelta: r.side === 'BUY' ? quote.outAmount : -o.inAmount,
        estFeeLamports: perTxFee,
        quote,
      });
    });
    legs.sort((a, b) => a.offsetMs - b.offsetMs || a.legId.localeCompare(b.legId));

    if (r.simulate !== false && this.d.client && this.d.swap.buildsTransactions) {
      await mapLimit(legs, 4, async (leg) => {
        try {
          const built = await this.d.swap.buildSwapTransaction(leg.quote!, leg.wallet, priorityLamports);
          const keys = await this.d.client!.resolveAccountKeys(built.tx);
          const insp = inspectThirdPartyTx(built.tx, keys, leg.wallet);
          if (!insp.ok) blockers.push(`${this.label(leg.wallet)}: swap tx failed safety inspection: ${insp.problems.join('; ')}`);
          leg.simulation = await this.d.client!.simulate(built.tx, {
            wallet: leg.wallet,
            tokenAccount: associatedTokenAddress(r.mint, leg.wallet, info.programId),
          });
          if (!leg.simulation.ok) warnings.push(`${this.label(leg.wallet)}: simulation failed: ${leg.simulation.error}`);
        } catch (e) {
          warnings.push(`${this.label(leg.wallet)}: could not simulate: ${errorMessage(e)}`);
        }
      });
    } else {
      // Offline/paper: derive the expected post-balances arithmetically.
      for (const leg of legs) {
        const b = bals.find((x) => x.publicKey === leg.wallet)!;
        leg.simulation = {
          ok: true,
          error: null,
          logs: ['(estimated: no on-chain simulation available)'],
          unitsConsumed: null,
          postLamports: b.lamports - leg.lamportsDelta - leg.estFeeLamports,
          postTokenRaw: holding(b) + (leg.tokenDelta ?? 0n),
        };
        if (leg.simulation.postLamports! < 0n) blockers.push(`${this.label(leg.wallet)}: insufficient SOL for amount + fees`);
      }
    }

    const totalIn = sumBig(legs.map((l) => (r.side === 'BUY' ? l.quote!.inAmount : l.quote!.outAmount)));
    const concurrency = r.timing.kind === 'simultaneous' ? r.timing.concurrency : r.timing.concurrency ?? 4;
    return this.createPlan({
      kind: r.kind ?? 'TRADE',
      title:
        r.title ??
        (r.side === 'BUY'
          ? `Buy ${info.symbol ?? r.mint.slice(0, 6)} with ${formatSol(totalIn)} SOL across ${legs.length} wallets`
          : `Sell ${info.symbol ?? r.mint.slice(0, 6)} from ${legs.length} wallets (~${formatSol(totalIn)} SOL)`),
      params: {
        mint: r.mint, side: r.side, sizing: r.sizing, timing: r.timing, slippageBps: r.slippageBps, priority: r.priority,
        priorityLamports, decimals: info.decimals, programId: info.programId, symbol: info.symbol, gasReserve, concurrency,
        avgPriceImpactPct: legs.length ? legs.reduce((s, l) => s + l.quote!.priceImpactPct, 0) / legs.length : 0,
      },
      legs,
      warnings,
      blockers,
      strategyTag: r.strategyTag ?? null,
    });
  }

  /** Generic plan creation (used by the position manager for consolidation, closes, rebalances). */
  createPlan(input: CustomPlanInput): Plan {
    const ttl = this.d.security().planTtlSec;
    const createdAt = this.now();
    const legs = input.legs;
    const totals = {
      lamportsOut: sumBig(legs.map((l) => (l.lamportsDelta > 0n ? l.lamportsDelta : 0n))),
      lamportsIn: sumBig(legs.map((l) => (l.lamportsDelta < 0n ? -l.lamportsDelta : 0n))),
      fees: sumBig(legs.map((l) => l.estFeeLamports)),
      tokenOut: sumBig(legs.map((l) => (l.tokenDelta && l.tokenDelta < 0n ? -l.tokenDelta : 0n))),
      tokenIn: sumBig(legs.map((l) => (l.tokenDelta && l.tokenDelta > 0n ? l.tokenDelta : 0n))),
    };
    const blockers = [...(input.blockers ?? [])];
    if (this.d.mode.current === 'LIVE') blockers.push(...this.d.limiter.evaluate(this.outflows(legs)));
    if (!legs.length) blockers.push('plan has no transactions');
    const body = {
      id: randomUUID(),
      kind: input.kind,
      mode: this.d.mode.current,
      createdAt,
      expiresAt: createdAt + ttl * 1000,
      title: input.title,
      params: input.params,
      legs,
      totals,
      warnings: dedupe(input.warnings ?? []),
      blockers: dedupe(blockers),
      strategyTag: input.strategyTag ?? null,
    };
    const plan: Plan = { ...body, hash: hashPlan(body) };
    this.d.repos.plans.save(plan, 'PREVIEW');
    this.log.info('plan created', { planId: plan.id, kind: plan.kind, legs: legs.length, mode: plan.mode, blockers: plan.blockers.length });
    return plan;
  }

  getPlan(id: string): { plan: Plan; status: PlanStatus } {
    const p = this.d.repos.plans.get(id);
    if (!p) throw new TerminalError('PLAN_NOT_FOUND', `Plan ${id} not found`);
    return p;
  }

  cancel(planId: string): void {
    const { status } = this.getPlan(planId);
    if (status === 'PREVIEW') this.d.repos.plans.setStatus(planId, 'CANCELLED');
    else if (this.running.has(planId)) this.cancelled.add(planId);
  }

  // ================================================================ execution

  /**
   * Execute a previewed plan. `confirmHash` must equal the plan hash shown in
   * the preview: if anything about the plan changed, execution is refused.
   */
  execute(planId: string, confirmHash: string): Promise<ExecutionSummary> {
    try {
      return this.start(planId, confirmHash).done;
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /**
   * Validate synchronously (throws on any refusal), then run in the
   * background. Progress is reported through 'leg' / 'plan' events.
   */
  start(planId: string, confirmHash: string): { planId: string; done: Promise<ExecutionSummary> } {
    const { plan, status } = this.getPlan(planId);
    if (status !== 'PREVIEW') throw new TerminalError('VALIDATION', `Plan is ${status}, not executable`);
    if (hashPlan(stripHash(plan)) !== plan.hash || confirmHash !== plan.hash) {
      throw new TerminalError('PLAN_MISMATCH', 'Confirmation does not match the previewed plan');
    }
    if (this.now() > plan.expiresAt) {
      this.d.repos.plans.setStatus(planId, 'EXPIRED');
      throw new TerminalError('PLAN_EXPIRED', 'Plan expired; preview again for fresh quotes');
    }
    const mode = this.d.mode.current;
    if (plan.mode !== mode) throw new TerminalError('MODE_FORBIDDEN', `Plan was previewed in ${plan.mode}; current mode is ${mode}. Preview again.`);
    if (mode === 'READ_ONLY') throw new TerminalError('MODE_FORBIDDEN', 'READ_ONLY mode cannot execute plans');
    if (plan.blockers.length) throw new TerminalError('VALIDATION', `Plan has blockers: ${plan.blockers.join('; ')}`);
    if (mode === 'LIVE') {
      this.d.limiter.assert(this.outflows(plan.legs));
      for (const l of plan.legs) if (l.destination) this.d.destinations.assert(l.destination);
    }
    const mint = plan.params.mint as string | undefined;
    const side = plan.params.side as Side | undefined;
    if ((plan.kind === 'TRADE' || plan.kind === 'EXIT') && mint && side) this.d.selfTrade.assert(mint, side);
    if (this.running.has(planId)) throw new TerminalError('VALIDATION', 'Plan is already executing');
    this.running.add(planId);
    this.d.repos.plans.setStatus(planId, 'EXECUTING');
    return { planId, done: this.run(plan, mode, mint) };
  }

  private async run(plan: Plan, mode: OperatingMode, mint: string | undefined): Promise<ExecutionSummary> {
    const planId = plan.id;
    if (mint && (plan.kind === 'TRADE' || plan.kind === 'EXIT')) this.inFlightMints.add(mint);
    this.emit('plan', { planId, status: 'EXECUTING', at: this.now() });

    const auditIds = new Map<string, number>();
    for (const leg of plan.legs) {
      auditIds.set(
        leg.legId,
        this.d.repos.audit.insert({
          planId, legId: leg.legId, kind: leg.kind, mode, status: 'PLANNED', wallet: leg.wallet, mint: leg.mint ?? null,
          side: leg.side ?? null, lamportsDelta: leg.lamportsDelta, tokenDelta: leg.tokenDelta ?? null,
          internal: !!leg.destination && this.d.repos.wallets.isVaultWallet(leg.destination),
          details: { description: leg.description, destination: leg.destination, decimals: plan.params.decimals, ...(legDetails(leg)) },
        }),
      );
    }

    const results = new Map<string, { status: TxStatus; signature: string | null; error: string | null }>();
    const set = (leg: PlannedTx, status: TxStatus, extra: { signature?: string | null; error?: string | null } = {}) => {
      results.set(leg.legId, { status, signature: extra.signature ?? null, error: extra.error ?? null });
      this.emit('leg', { planId, legId: leg.legId, wallet: leg.wallet, kind: leg.kind, status, signature: extra.signature, error: extra.error, at: this.now() });
    };

    // lanes: per wallet, sequential; across wallets, parallel (bounded)
    const lanes = new Map<string, PlannedTx[]>();
    for (const l of [...plan.legs].sort((a, b) => a.offsetMs - b.offsetMs)) {
      const lane = lanes.get(l.wallet) ?? [];
      lane.push(l);
      lanes.set(l.wallet, lane);
    }
    const start = this.now();
    const concurrency = Math.max(1, Number(plan.params.concurrency ?? 4));
    await mapLimit([...lanes.values()], concurrency, async (lane) => {
      for (const unit of unitsOf(lane)) {
        const wait = start + unit[0]!.offsetMs - this.now();
        if (wait > 0) await sleep(wait);
        if (this.cancelled.has(planId)) {
          for (const leg of unit) {
            this.d.repos.audit.update(auditIds.get(leg.legId)!, { status: 'SKIPPED', error: 'cancelled' });
            set(leg, 'SKIPPED', { error: 'cancelled' });
          }
          continue;
        }
        try {
          await this.runUnit(plan, unit, auditIds, set);
        } catch (e) {
          const msg = errorMessage(e);
          this.log.error('leg failed', { planId, legs: unit.map((l) => l.legId), error: msg });
          for (const leg of unit) {
            if (results.get(leg.legId)?.status && results.get(leg.legId)!.status !== 'PLANNED') continue;
            this.d.repos.audit.update(auditIds.get(leg.legId)!, { status: 'FAILED', error: msg });
            set(leg, 'FAILED', { error: msg });
          }
        }
      }
    });

    this.running.delete(planId);
    this.cancelled.delete(planId);
    if (mint) this.inFlightMints.delete(mint);

    const legs = plan.legs.map((l) => ({ legId: l.legId, wallet: l.wallet, ...(results.get(l.legId) ?? { status: 'SKIPPED' as TxStatus, signature: null, error: null }) }));
    const ok = legs.filter((l) => l.status === 'CONFIRMED' || l.status === 'PAPER_FILLED').length;
    const final: PlanStatus = ok === legs.length ? 'DONE' : ok === 0 ? 'FAILED' : 'PARTIAL';
    this.d.repos.plans.setStatus(planId, final);
    const summary: ExecutionSummary = {
      planId,
      status: final,
      confirmed: legs.filter((l) => l.status === 'CONFIRMED').length,
      paper: legs.filter((l) => l.status === 'PAPER_FILLED').length,
      failed: legs.filter((l) => l.status === 'FAILED' || l.status === 'EXPIRED' || l.status === 'SIM_FAILED').length,
      skipped: legs.filter((l) => l.status === 'SKIPPED').length,
      legs,
    };
    this.emit('plan', { planId, status: final, at: this.now(), summary });
    this.log.info('plan finished', { planId, status: final, ok, total: legs.length });
    return summary;
  }

  // ================================================================ internals

  private async runUnit(
    plan: Plan,
    unit: PlannedTx[],
    auditIds: Map<string, number>,
    set: (leg: PlannedTx, s: TxStatus, x?: { signature?: string | null; error?: string | null }) => void,
  ): Promise<void> {
    const first = unit[0]!;
    const live = this.d.mode.current === 'LIVE';
    if (this.d.mode.current !== plan.mode) throw new TerminalError('MODE_FORBIDDEN', 'mode changed during execution');
    const upd = (leg: PlannedTx, patch: Parameters<Repositories['audit']['update']>[1]) => this.d.repos.audit.update(auditIds.get(leg.legId)!, patch);

    switch (first.kind) {
      case 'SWAP':
        return this.runSwap(plan, first, live, upd, set);

      case 'SOL_TRANSFER': {
        const micro = Number(plan.params.microLamports ?? 0);
        // Sweep legs compute the amount from the fresh balance at execution time.
        const sweepReserve = legDetails(first).sweepReserve;
        if (first.destination && unit.length === 1 && typeof sweepReserve === 'bigint') {
          const reserve = sweepReserve;
          const [bal] = await this.balances([first.wallet]);
          const fee = estimateTxFee({ computeUnits: 300 + CU_SOL_TRANSFER, microLamportsPerCu: micro });
          const amount = (bal?.lamports ?? 0n) - fee - reserve;
          if (amount <= 0n) {
            upd(first, { status: 'SKIPPED', error: 'nothing left to sweep after fees and reserve', lamportsDelta: 0n });
            return set(first, 'SKIPPED', { error: 'nothing to sweep' });
          }
          first.lamportsDelta = amount;
          upd(first, { lamportsDelta: amount });
        }
        if (!live) {
          for (const leg of unit) {
            upd(leg, { status: 'PAPER_FILLED', feeLamports: leg.estFeeLamports });
            set(leg, 'PAPER_FILLED');
          }
          return;
        }
        for (const leg of unit) if (leg.destination) this.d.destinations.assert(leg.destination);
        const bh = await this.client().getLatestBlockhash();
        const built = buildSolTransfers({
          from: first.wallet,
          transfers: unit.map((l) => ({ to: l.destination!, lamports: l.lamportsDelta })),
          blockhash: bh.blockhash,
          microLamportsPerCu: micro,
        });
        return this.signSendRecord(unit, built.tx, bh.lastValidBlockHeight, upd, set);
      }

      case 'TOKEN_TRANSFER': {
        const det = legDetails(first) as { programId: string; decimals: number; sourceTokenAccount: string; closeSource: boolean };
        if (first.mint && this.inFlightMints.has(first.mint)) {
          upd(first, { status: 'SKIPPED', error: 'a trade in this token is executing' });
          return set(first, 'SKIPPED', { error: 'trade in flight for this token' });
        }
        const [bal] = await this.balances([first.wallet]);
        const have = bal?.tokens.filter((t) => t.mint === first.mint).reduce((s, t) => s + t.amountRaw, 0n) ?? 0n;
        const amount = -(first.tokenDelta ?? 0n) > have ? have : -(first.tokenDelta ?? 0n);
        if (amount <= 0n) {
          upd(first, { status: 'SKIPPED', error: 'no tokens left to transfer' });
          return set(first, 'SKIPPED', { error: 'no tokens' });
        }
        if (!live) {
          upd(first, { status: 'PAPER_FILLED', tokenDelta: -amount, feeLamports: first.estFeeLamports });
          return set(first, 'PAPER_FILLED');
        }
        this.d.destinations.assert(first.destination!);
        const bh = await this.client().getLatestBlockhash();
        const built = buildTokenTransfer({
          owner: first.wallet, mint: first.mint!, programId: det.programId, decimals: det.decimals, sourceTokenAccount: det.sourceTokenAccount,
          amount, destinationOwner: first.destination!, closeSourceAfter: det.closeSource && amount === have, blockhash: bh.blockhash,
          microLamportsPerCu: Number(plan.params.microLamports ?? 0),
        });
        return this.signSendRecord([first], built.tx, bh.lastValidBlockHeight, upd, set);
      }

      case 'CLOSE_ACCOUNT': {
        const accounts = (legDetails(first).accounts ?? []) as { tokenAccount: string; programId: string; mint: string }[];
        if (!live) {
          upd(first, { status: 'PAPER_FILLED', feeLamports: first.estFeeLamports });
          return set(first, 'PAPER_FILLED');
        }
        const bh = await this.client().getLatestBlockhash();
        const built = buildCloseAccounts({ owner: first.wallet, accounts, blockhash: bh.blockhash, microLamportsPerCu: Number(plan.params.microLamports ?? 0) });
        return this.signSendRecord([first], built.tx, bh.lastValidBlockHeight, upd, set);
      }
    }
  }

  private async runSwap(
    plan: Plan,
    leg: PlannedTx,
    live: boolean,
    upd: (leg: PlannedTx, patch: Parameters<Repositories['audit']['update']>[1]) => void,
    set: (leg: PlannedTx, s: TxStatus, x?: { signature?: string | null; error?: string | null }) => void,
  ): Promise<void> {
    const mint = leg.mint!;
    const side = leg.side!;
    const decimals = Number(plan.params.decimals);
    const previewed = leg.quote!;
    let inAmount = previewed.inAmount;
    if (side === 'SELL') {
      const [bal] = await this.balances([leg.wallet]);
      const have = bal?.tokens.filter((t) => t.mint === mint).reduce((s, t) => s + t.amountRaw, 0n) ?? 0n;
      if (have < inAmount) inAmount = have;
      if (inAmount <= 0n) {
        upd(leg, { status: 'SKIPPED', error: 'no tokens to sell' });
        return set(leg, 'SKIPPED', { error: 'no tokens to sell' });
      }
    }
    // Fresh quote: previews go stale fast on new pools.
    const quote = await this.d.swap.quote({ inputMint: previewed.inputMint, outputMint: previewed.outputMint, amount: inAmount, slippageBps: previewed.slippageBps });
    const scaledMin = inAmount === previewed.inAmount ? previewed.minOutAmount : (previewed.minOutAmount * inAmount) / previewed.inAmount;
    if (quote.outAmount < scaledMin) {
      const msg = `price moved beyond slippage since preview (now ${quote.outAmount}, min ${scaledMin})`;
      upd(leg, { status: 'SKIPPED', error: msg });
      return set(leg, 'SKIPPED', { error: msg });
    }

    if (!live) {
      // Optional on-chain dry run with the real provider, then a paper fill at the quote.
      if (this.d.client && this.d.swap.buildsTransactions) {
        try {
          const built = await this.d.swap.buildSwapTransaction(quote, leg.wallet, BigInt(String(plan.params.priorityLamports ?? 0)));
          const sim = await this.d.client.simulate(built.tx, { wallet: leg.wallet });
          if (!sim.ok) {
            upd(leg, { status: 'SIM_FAILED', error: sim.error, details: { logs: sim.logs } });
            return set(leg, 'SIM_FAILED', { error: sim.error });
          }
        } catch (e) {
          this.log.warn('paper swap dry-run unavailable', { error: errorMessage(e) });
        }
      }
      const lamports = side === 'BUY' ? quote.inAmount : quote.outAmount;
      const tokens = side === 'BUY' ? quote.outAmount : quote.inAmount;
      this.recordFill(plan, leg, side, tokens, decimals, lamports, leg.estFeeLamports, null, true);
      upd(leg, {
        status: 'PAPER_FILLED',
        lamportsDelta: side === 'BUY' ? lamports : -lamports,
        tokenDelta: side === 'BUY' ? tokens : -tokens,
        feeLamports: leg.estFeeLamports,
        details: { quote: { out: quote.outAmount, impact: quote.priceImpactPct, route: quote.routeLabel } },
      });
      this.d.onPaperFill?.(quote);
      return set(leg, 'PAPER_FILLED');
    }

    const built = await this.d.swap.buildSwapTransaction(quote, leg.wallet, BigInt(String(plan.params.priorityLamports ?? 0)));
    const keys = await this.client().resolveAccountKeys(built.tx);
    const insp = inspectThirdPartyTx(built.tx, keys, leg.wallet);
    if (!insp.ok) throw new TerminalError('TX_REJECTED', `swap transaction failed safety inspection: ${insp.problems.join('; ')}`);
    const signed = await this.d.signer.sign(leg.wallet, built.tx);
    upd(leg, { status: 'SUBMITTED' });
    const res = await this.client().sendAndConfirm(signed, {
      lastValidBlockHeight: built.lastValidBlockHeight,
      skipPreflight: true,
      onSubmitted: (sig) => {
        upd(leg, { signature: sig });
        set(leg, 'SUBMITTED', { signature: sig });
      },
    });
    if (res.status !== 'CONFIRMED') {
      upd(leg, { status: res.status, signature: res.signature, error: res.error, feeLamports: res.feeLamports });
      return set(leg, res.status, { signature: res.signature, error: res.error });
    }
    const deltas = await this.client().getTxBalanceDeltas(res.signature, leg.wallet, mint).catch(() => null);
    const fee = deltas?.fee ?? res.feeLamports ?? leg.estFeeLamports;
    const tokens = deltas ? (side === 'BUY' ? deltas.tokenDelta : -deltas.tokenDelta) : side === 'BUY' ? quote.outAmount : quote.inAmount;
    const lamports = side === 'BUY' ? quote.inAmount : deltas ? deltas.lamportsDelta + fee : quote.outAmount;
    this.recordFill(plan, leg, side, tokens, decimals, lamports, fee, res.signature, false);
    upd(leg, {
      status: 'CONFIRMED', signature: res.signature, feeLamports: fee,
      lamportsDelta: side === 'BUY' ? lamports : -lamports, tokenDelta: side === 'BUY' ? tokens : -tokens,
    });
    set(leg, 'CONFIRMED', { signature: res.signature });
  }

  private recordFill(plan: Plan, leg: PlannedTx, side: Side, tokens: bigint, decimals: number, lamports: bigint, fee: bigint, signature: string | null, paper: boolean): void {
    this.d.repos.fills.insert({
      wallet: leg.wallet, mint: leg.mint!, side, tokenAmountRaw: tokens, decimals, lamports, feeLamports: fee, signature, paper,
      strategyTag: plan.strategyTag, planId: plan.id, at: this.now(),
    });
    if (tokens > 0n) {
      this.emit('fill', { wallet: leg.wallet, mint: leg.mint!, side, solPerToken: Number(lamports) / 1e9 / (Number(tokens) / 10 ** decimals), paper });
    }
  }

  private async signSendRecord(
    unit: PlannedTx[],
    tx: VersionedTransaction,
    lastValidBlockHeight: number,
    upd: (leg: PlannedTx, patch: Parameters<Repositories['audit']['update']>[1]) => void,
    set: (leg: PlannedTx, s: TxStatus, x?: { signature?: string | null; error?: string | null }) => void,
  ): Promise<void> {
    const signed = await this.d.signer.sign(unit[0]!.wallet, tx);
    for (const l of unit) upd(l, { status: 'SUBMITTED' });
    const res = await this.client().sendAndConfirm(signed, {
      lastValidBlockHeight,
      onSubmitted: (sig) => unit.forEach((l) => (upd(l, { signature: sig }), set(l, 'SUBMITTED', { signature: sig }))),
    });
    unit.forEach((l, i) => {
      upd(l, { status: res.status, signature: res.signature, error: res.error, feeLamports: i === 0 ? res.feeLamports : 0n });
      set(l, res.status, { signature: res.signature, error: res.error });
    });
  }

  private async simulateTransferBatches(source: string, legs: PlannedTx[], micro: number): Promise<void> {
    const batches = new Map<number, PlannedTx[]>();
    for (const l of legs) batches.set(l.batch ?? 0, [...(batches.get(l.batch ?? 0) ?? []), l]);
    await mapLimit([...batches.values()], 4, async (batch) => {
      const built = buildSolTransfers({
        from: source, transfers: batch.map((l) => ({ to: l.destination!, lamports: l.lamportsDelta })), blockhash: DUMMY_BLOCKHASH, microLamportsPerCu: micro,
      });
      batch[0]!.simulation = await this.d.client!.simulate(built.tx, { wallet: source });
    });
  }

  private outflows(legs: PlannedTx[]): Outflow[] {
    return legs
      .filter((l) => l.lamportsDelta > 0n)
      .map((l) => ({ wallet: l.wallet, lamports: l.lamportsDelta, internal: !!l.destination && this.d.repos.wallets.isVaultWallet(l.destination) }));
  }

  private async dynamicPriority(p: PrioritySettings, accounts: string[]): Promise<number | null> {
    if (!this.d.client || p.level === 'none' || p.level === 'custom') return null;
    const pct = { low: 25, medium: 50, high: 75, turbo: 95 }[p.level];
    return this.d.client.getPriorityFeePercentile(accounts, pct);
  }

  private async microLamports(p: PrioritySettings, cu: number, accounts: string[]): Promise<number> {
    return microLamportsFor(p, cu, await this.dynamicPriority(p, accounts));
  }

  private client(): SolanaClient {
    if (!this.d.client) throw new TerminalError('RPC_UNAVAILABLE', 'LIVE execution requires an RPC connection');
    return this.d.client;
  }

  private label(pk: string): string {
    return this.d.repos.wallets.byPublicKey(pk)?.label ?? `${pk.slice(0, 4)}…${pk.slice(-4)}`;
  }
}

// ---------------------------------------------------------------- helpers

export function hashPlan(body: Omit<Plan, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function stripHash(p: Plan): Omit<Plan, 'hash'> {
  const { hash: _h, ...rest } = p;
  return rest;
}

export function legDetails(leg: PlannedTx): Record<string, unknown> {
  return leg.details ?? {};
}

function unitsOf(lane: PlannedTx[]): PlannedTx[][] {
  const out: PlannedTx[][] = [];
  for (const l of lane) {
    const last = out[out.length - 1];
    if (l.kind === 'SOL_TRANSFER' && l.batch !== undefined && last && last[0]!.kind === 'SOL_TRANSFER' && last[0]!.batch === l.batch) last.push(l);
    else out.push([l]);
  }
  return out;
}

function legId(i: number): string {
  return `t${String(i).padStart(4, '0')}`;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function fmtToken(raw: bigint, decimals: number): string {
  const n = Number(raw) / 10 ** decimals;
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}K` : n.toPrecision(4);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  });
  await Promise.all(workers);
}
