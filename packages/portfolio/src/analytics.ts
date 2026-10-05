import { lamportsToSol, type Fill } from '@term/core';
import { buildLedger, type TradeCycle } from './ledger';

export interface TradeStats {
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgWinnerLamports: bigint | null;
  avgLoserLamports: bigint | null;
  /** gross profit / gross loss; null when there are no losses. */
  profitFactor: number | null;
  totalRealizedLamports: bigint;
  maxDrawdownLamports: bigint;
  maxDrawdownPct: number | null;
  bestTrade: TradeCycle | null;
  worstTrade: TradeCycle | null;
  avgHoldingMs: number | null;
  pnlByToken: Record<string, bigint>;
  pnlByWallet: Record<string, bigint>;
  pnlByStrategy: Record<string, bigint>;
  equityCurve: { at: number; cumulativeLamports: bigint }[];
}

/** Max peak-to-trough decline of a cumulative series. */
export function maxDrawdown(series: bigint[], base = 0n): { abs: bigint; pct: number | null } {
  let peak = base;
  let worst = 0n;
  let worstPct: number | null = null;
  for (const v of series) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > worst) {
      worst = dd;
      worstPct = peak > 0n ? Number((dd * 10_000n) / peak) / 100 : null;
    }
  }
  return { abs: worst, pct: worstPct };
}

/**
 * Trading performance from recorded fills. A "trade" is a closed cycle
 * (position opened from flat and returned to flat) per wallet+mint.
 * `capitalBase` (lamports) lets drawdown % be measured against starting capital.
 */
export function computeTradeStats(fills: Fill[], opts: { capitalBase?: bigint } = {}): TradeStats {
  const { cycles, realizedEvents } = buildLedger(fills);
  const closed = cycles.filter((c) => c.closedAt !== null);
  const winners = closed.filter((c) => c.realized > 0n);
  const losers = closed.filter((c) => c.realized <= 0n);
  const sum = (xs: TradeCycle[]) => xs.reduce((s, c) => s + c.realized, 0n);
  const grossWin = sum(winners);
  const grossLoss = -sum(losers);

  const byKey = (key: (e: (typeof realizedEvents)[number]) => string) => {
    const out: Record<string, bigint> = {};
    for (const e of realizedEvents) out[key(e)] = (out[key(e)] ?? 0n) + e.lamports;
    return out;
  };

  const events = [...realizedEvents].sort((a, b) => a.at - b.at);
  let cum = 0n;
  const equityCurve = events.map((e) => ({ at: e.at, cumulativeLamports: (cum += e.lamports) }));
  const base = opts.capitalBase ?? 0n;
  const dd = maxDrawdown(equityCurve.map((p) => base + p.cumulativeLamports), base);

  const best = closed.reduce<TradeCycle | null>((b, c) => (b === null || c.realized > b.realized ? c : b), null);
  const worst = closed.reduce<TradeCycle | null>((w, c) => (w === null || c.realized < w.realized ? c : w), null);

  return {
    closedTrades: closed.length,
    openTrades: cycles.length - closed.length,
    wins: winners.length,
    losses: losers.length,
    winRatePct: closed.length ? Math.round((winners.length / closed.length) * 10_000) / 100 : null,
    avgWinnerLamports: winners.length ? grossWin / BigInt(winners.length) : null,
    avgLoserLamports: losers.length ? -grossLoss / BigInt(losers.length) : null,
    profitFactor: grossLoss > 0n ? Math.round((Number(grossWin) / Number(grossLoss)) * 100) / 100 : null,
    totalRealizedLamports: realizedEvents.reduce((s, e) => s + e.lamports, 0n),
    maxDrawdownLamports: dd.abs,
    maxDrawdownPct: dd.pct,
    bestTrade: best,
    worstTrade: worst,
    avgHoldingMs: closed.length ? Math.round(closed.reduce((s, c) => s + (c.closedAt! - c.openedAt), 0) / closed.length) : null,
    pnlByToken: byKey((e) => e.mint),
    pnlByWallet: byKey((e) => e.wallet),
    pnlByStrategy: byKey((e) => e.strategyTag ?? 'manual'),
    equityCurve,
  };
}

const csvEscape = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n';
}

export function tradesCsv(fills: Fill[], symbolOf: (mint: string) => string | null = () => null): string {
  const { cycles } = buildLedger(fills);
  return toCsv(
    ['wallet', 'mint', 'symbol', 'strategy', 'opened_at', 'closed_at', 'holding_minutes', 'invested_sol', 'realized_pnl_sol', 'return_pct', 'status'],
    cycles.map((c) => [
      c.wallet,
      c.mint,
      symbolOf(c.mint) ?? '',
      c.strategyTag ?? 'manual',
      new Date(c.openedAt).toISOString(),
      c.closedAt ? new Date(c.closedAt).toISOString() : '',
      c.closedAt ? ((c.closedAt - c.openedAt) / 60_000).toFixed(1) : '',
      lamportsToSol(c.invested).toFixed(9),
      lamportsToSol(c.realized).toFixed(9),
      c.invested > 0n ? ((Number(c.realized) / Number(c.invested)) * 100).toFixed(2) : '',
      c.closedAt ? 'closed' : 'open',
    ]),
  );
}

export function fillsCsv(fills: Fill[]): string {
  return toCsv(
    ['time', 'wallet', 'mint', 'side', 'token_amount_raw', 'decimals', 'sol', 'fee_sol', 'signature', 'paper', 'strategy', 'plan_id'],
    fills.map((f) => [
      new Date(f.at).toISOString(),
      f.wallet,
      f.mint,
      f.side,
      f.tokenAmountRaw.toString(),
      f.decimals,
      lamportsToSol(f.lamports).toFixed(9),
      lamportsToSol(f.feeLamports).toFixed(9),
      f.signature ?? '',
      f.paper,
      f.strategyTag ?? '',
      f.planId ?? '',
    ]),
  );
}

export function pnlBreakdownCsv(stats: TradeStats): string {
  const rows: unknown[][] = [];
  for (const [dim, m] of [
    ['token', stats.pnlByToken],
    ['wallet', stats.pnlByWallet],
    ['strategy', stats.pnlByStrategy],
  ] as const) {
    for (const [k, v] of Object.entries(m)) rows.push([dim, k, lamportsToSol(v).toFixed(9)]);
  }
  return toCsv(['dimension', 'key', 'realized_pnl_sol'], rows);
}
