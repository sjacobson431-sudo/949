import { cryptoRng, pctOf, TerminalError, uniform, type ExecutionTiming, type OrderSizing, type Rng, type Side } from '@term/core';
import { splitAmount } from './allocation';

export interface WalletHolding {
  publicKey: string;
  lamports: bigint;
  /** Raw token balance of the traded mint (for sells). */
  tokenRaw: bigint;
}

export interface OrderIntent {
  wallet: string;
  side: Side;
  /** Lamports in for BUY, raw tokens in for SELL. */
  inAmount: bigint;
  offsetMs: number;
  notes: string[];
}

export interface PlanOrdersInput {
  side: Side;
  wallets: WalletHolding[];
  sizing: OrderSizing;
  timing: ExecutionTiming;
  /** Lamports each wallet must keep for fees/rent (BUY only). */
  gasReserve: bigint;
  /** Minimum order size; smaller orders are skipped (dust). */
  minOrder?: bigint;
  rng?: Rng;
}

export interface PlanOrdersResult {
  orders: OrderIntent[];
  skipped: { wallet: string; reason: string }[];
  totalIn: bigint;
}

/** Turns "buy 5 SOL across these 40 wallets, staggered" into concrete per-wallet orders. */
export function planOrders(i: PlanOrdersInput): PlanOrdersResult {
  const rng = i.rng ?? cryptoRng;
  const skipped: PlanOrdersResult['skipped'] = [];
  const available = (w: WalletHolding) => (i.side === 'BUY' ? (w.lamports > i.gasReserve ? w.lamports - i.gasReserve : 0n) : w.tokenRaw);

  let wanted = new Map<string, bigint>();
  switch (i.sizing.kind) {
    case 'fixed':
      for (const w of i.wallets) wanted.set(w.publicKey, i.sizing.amount);
      break;
    case 'percentOfWallet': {
      if (i.sizing.pct <= 0 || i.sizing.pct > 100) throw new TerminalError('VALIDATION', 'percent must be in (0, 100]');
      for (const w of i.wallets) wanted.set(w.publicKey, pctOf(available(w), i.sizing.pct));
      break;
    }
    case 'perWallet':
      for (const w of i.wallets) wanted.set(w.publicKey, i.sizing.amounts[w.publicKey] ?? 0n);
      break;
    case 'total': {
      const keys = i.wallets.map((w) => w.publicKey);
      // Sells default to "proportional to holdings" unless an explicit split was given.
      const spec =
        i.side === 'SELL' && i.sizing.allocation.kind === 'equal'
          ? { kind: 'weighted' as const, weights: Object.fromEntries(i.wallets.map((w) => [w.publicKey, Number(w.tokenRaw)])) }
          : i.sizing.allocation;
      wanted = splitAmount(i.sizing.total, keys, spec, rng);
      break;
    }
  }

  const orders: OrderIntent[] = [];
  for (const w of i.wallets) {
    const want = wanted.get(w.publicKey) ?? 0n;
    const avail = available(w);
    const notes: string[] = [];
    let amt = want;
    if (amt > avail) {
      amt = avail;
      notes.push(i.side === 'BUY' ? 'reduced to available SOL after gas reserve' : 'reduced to wallet holdings');
    }
    if (amt <= 0n || amt < (i.minOrder ?? 1n)) {
      skipped.push({ wallet: w.publicKey, reason: i.side === 'BUY' ? 'insufficient SOL after gas reserve' : 'no tokens to sell' });
      continue;
    }
    orders.push({ wallet: w.publicKey, side: i.side, inAmount: amt, offsetMs: 0, notes });
  }

  applyTiming(orders, i.timing, rng);
  return { orders, skipped, totalIn: orders.reduce((s, o) => s + o.inAmount, 0n) };
}

/**
 * simultaneous: all at t=0 (the executor bounds concurrency).
 * staggered: order i at i*interval ± jitter (never negative), in shuffled
 * wallet order so execution isn't always in the same sequence.
 */
export function applyTiming(orders: { offsetMs: number }[], timing: ExecutionTiming, rng: Rng = cryptoRng): void {
  if (timing.kind === 'simultaneous') {
    for (const o of orders) o.offsetMs = 0;
    return;
  }
  // Fisher–Yates shuffle of slot assignment
  const slots = orders.map((_, i) => i);
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [slots[i], slots[j]] = [slots[j]!, slots[i]!];
  }
  orders.forEach((o, i) => {
    const base = slots[i]! * timing.intervalMs;
    const jitter = timing.jitterMs > 0 ? uniform(rng, -timing.jitterMs, timing.jitterMs) : 0;
    o.offsetMs = Math.max(0, Math.round(base + jitter));
  });
}
