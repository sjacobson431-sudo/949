import type { Fill, PositionLot } from '@term/core';

export interface TradeCycle {
  wallet: string;
  mint: string;
  strategyTag: string | null;
  openedAt: number;
  closedAt: number | null;
  /** Lamports spent on buys (incl. fees) during the cycle. */
  invested: bigint;
  /** Realized P&L inside the cycle. */
  realized: bigint;
}

export interface RealizedEvent {
  wallet: string;
  mint: string;
  strategyTag: string | null;
  at: number;
  lamports: bigint;
}

export interface LedgerResult {
  lots: Map<string, PositionLot>;
  cycles: TradeCycle[];
  realizedEvents: RealizedEvent[];
  /** Sells larger than the tracked position (tokens acquired outside this tool). */
  untrackedSells: number;
}

export const lotKey = (wallet: string, mint: string) => `${wallet}:${mint}`;

/**
 * Average-cost ledger per (wallet, mint). Buy fees are capitalised into cost;
 * sell fees reduce proceeds. A cycle opens when a position goes 0 → >0 and
 * closes when it returns to 0; closed cycles are the "trades" for analytics.
 */
export function buildLedger(fills: Fill[]): LedgerResult {
  const lots = new Map<string, PositionLot>();
  const open = new Map<string, TradeCycle>();
  const cycles: TradeCycle[] = [];
  const realizedEvents: RealizedEvent[] = [];
  let untrackedSells = 0;

  const sorted = [...fills].sort((a, b) => a.at - b.at || a.id - b.id);
  for (const f of sorted) {
    const k = lotKey(f.wallet, f.mint);
    let lot = lots.get(k);
    if (!lot) {
      lot = { wallet: f.wallet, mint: f.mint, decimals: f.decimals, qtyRaw: 0n, costLamports: 0n, realizedLamports: 0n, openedAt: null, buys: 0, sells: 0 };
      lots.set(k, lot);
    }
    if (f.side === 'BUY') {
      if (lot.qtyRaw === 0n) {
        const c: TradeCycle = { wallet: f.wallet, mint: f.mint, strategyTag: f.strategyTag, openedAt: f.at, closedAt: null, invested: 0n, realized: 0n };
        open.set(k, c);
        cycles.push(c);
      }
      const newQty = lot.qtyRaw + f.tokenAmountRaw;
      lot.openedAt =
        lot.openedAt === null || lot.qtyRaw === 0n
          ? f.at
          : Math.round((lot.openedAt * Number(lot.qtyRaw) + f.at * Number(f.tokenAmountRaw)) / Number(newQty));
      lot.qtyRaw = newQty;
      const cost = f.lamports + f.feeLamports;
      lot.costLamports += cost;
      lot.buys++;
      open.get(k)!.invested += cost;
    } else {
      lot.sells++;
      const qtySold = f.tokenAmountRaw <= lot.qtyRaw ? f.tokenAmountRaw : lot.qtyRaw;
      if (f.tokenAmountRaw > lot.qtyRaw) untrackedSells++;
      const costOut = lot.qtyRaw > 0n ? (lot.costLamports * qtySold) / lot.qtyRaw : 0n;
      const realized = f.lamports - f.feeLamports - costOut;
      lot.realizedLamports += realized;
      lot.qtyRaw -= qtySold;
      lot.costLamports -= costOut;
      realizedEvents.push({ wallet: f.wallet, mint: f.mint, strategyTag: f.strategyTag ?? open.get(k)?.strategyTag ?? null, at: f.at, lamports: realized });
      const c = open.get(k);
      if (c) {
        c.realized += realized;
        if (lot.qtyRaw === 0n) {
          c.closedAt = f.at;
          open.delete(k);
        }
      }
      if (lot.qtyRaw === 0n) {
        lot.costLamports = 0n;
        lot.openedAt = null;
      }
    }
  }
  return { lots, cycles, realizedEvents, untrackedSells };
}
