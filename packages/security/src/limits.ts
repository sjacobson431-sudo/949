import { formatSol, TerminalError, type Side, type SpendingLimits } from '@term/core';

export interface OutflowHistory {
  /** Lamports that left `wallet` (or all wallets when null) via confirmed/submitted txs since `sinceMs`. */
  outflowSince(wallet: string | null, sinceMs: number): bigint;
}

export interface Outflow {
  wallet: string;
  lamports: bigint;
  /** Transfers between vault wallets don't count toward the global cap. */
  internal?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_LIMITS: SpendingLimits = {
  perTxLamports: 5_000_000_000n, // 5 SOL
  perWalletDailyLamports: 20_000_000_000n, // 20 SOL
  globalDailyLamports: 100_000_000_000n, // 100 SOL
};

/** Enforces per-tx, per-wallet-daily and global-daily SOL outflow caps. */
export class SpendingLimiter {
  constructor(
    private limits: SpendingLimits,
    private readonly history: OutflowHistory,
    private readonly now: () => number = Date.now,
  ) {}

  setLimits(l: SpendingLimits): void {
    this.limits = l;
  }

  getLimits(): SpendingLimits {
    return this.limits;
  }

  /** Returns a list of violations (empty = OK). */
  evaluate(outflows: Outflow[]): string[] {
    const v: string[] = [];
    const since = this.now() - DAY_MS;
    const perWallet = new Map<string, bigint>();
    let externalTotal = 0n;
    for (const o of outflows) {
      if (o.lamports > this.limits.perTxLamports) {
        v.push(`tx from ${short(o.wallet)} sends ${formatSol(o.lamports)} SOL > per-tx limit ${formatSol(this.limits.perTxLamports)}`);
      }
      perWallet.set(o.wallet, (perWallet.get(o.wallet) ?? 0n) + o.lamports);
      if (!o.internal) externalTotal += o.lamports;
    }
    for (const [w, amt] of perWallet) {
      const used = this.history.outflowSince(w, since);
      if (used + amt > this.limits.perWalletDailyLamports) {
        v.push(
          `${short(w)} would spend ${formatSol(used + amt)} SOL in 24h > per-wallet daily limit ${formatSol(this.limits.perWalletDailyLamports)}`,
        );
      }
    }
    const globalUsed = this.history.outflowSince(null, since);
    if (globalUsed + externalTotal > this.limits.globalDailyLamports) {
      v.push(
        `plan brings 24h spend to ${formatSol(globalUsed + externalTotal)} SOL > global daily limit ${formatSol(this.limits.globalDailyLamports)}`,
      );
    }
    return v;
  }

  assert(outflows: Outflow[]): void {
    const v = this.evaluate(outflows);
    if (v.length) throw new TerminalError('LIMIT_EXCEEDED', v.join('; '), { violations: v });
  }
}

export interface DestinationLookup {
  isVaultWallet(address: string): boolean;
  isWhitelisted(address: string): boolean;
}

/** Transfers may only target vault wallets or explicitly whitelisted addresses. */
export class DestinationPolicy {
  constructor(
    private readonly lookup: DestinationLookup,
    public enabled = true,
  ) {}

  isAllowed(address: string): boolean {
    return !this.enabled || this.lookup.isVaultWallet(address) || this.lookup.isWhitelisted(address);
  }

  assert(address: string): void {
    if (!this.isAllowed(address)) {
      throw new TerminalError('NOT_WHITELISTED', `Destination ${address} is not a vault wallet or whitelisted address`);
    }
  }
}

export interface TradeActivityLookup {
  /** Most recent time (ms) any vault wallet traded `mint` on `side`, or null. */
  lastTradeAt(mint: string, side: Side): number | null;
}

/**
 * Wash-trade guard: refuses to buy a mint that any of your wallets sold
 * within the cooldown (and vice versa). Trading against yourself only
 * fabricates volume and pays fees.
 */
export class SelfTradeGuard {
  constructor(
    private readonly lookup: TradeActivityLookup,
    public cooldownSec: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(mint: string, side: Side): string | null {
    if (this.cooldownSec <= 0) return null;
    const opposite: Side = side === 'BUY' ? 'SELL' : 'BUY';
    const last = this.lookup.lastTradeAt(mint, opposite);
    if (last === null) return null;
    const ago = (this.now() - last) / 1000;
    if (ago < this.cooldownSec) {
      return `self-trade guard: your wallets ${opposite === 'SELL' ? 'sold' : 'bought'} this token ${Math.round(ago)}s ago (cooldown ${this.cooldownSec}s)`;
    }
    return null;
  }

  assert(mint: string, side: Side): void {
    const r = this.check(mint, side);
    if (r) throw new TerminalError('SELF_TRADE_BLOCKED', r);
  }
}

function short(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}
