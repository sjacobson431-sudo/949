'use client';

import { LineChart, PnlBars, Stat } from '@/components/ui';
import { download } from '@/lib/api';
import { duration, lamportsToSol, pnlClass, short, signedSol } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Wallet } from '@/lib/types';

interface Cycle { wallet: string; mint: string; strategyTag: string | null; openedAt: number; closedAt: number | null; invested: string; realized: string }
interface Stats {
  closedTrades: number; openTrades: number; wins: number; losses: number; winRatePct: number | null; avgWinnerLamports: string | null; avgLoserLamports: string | null;
  profitFactor: number | null; totalRealizedLamports: string; maxDrawdownLamports: string; maxDrawdownPct: number | null; bestTrade: Cycle | null; worstTrade: Cycle | null;
  avgHoldingMs: number | null; pnlByToken: Record<string, string>; pnlByWallet: Record<string, string>; pnlByStrategy: Record<string, string>;
  equityCurve: { at: number; cumulativeLamports: string }[]; fillCount: number; paper: boolean;
}

const toRows = (m: Record<string, string>, label: (k: string) => string = (k) => k) =>
  Object.entries(m).map(([k, v]) => ({ key: label(k), value: lamportsToSol(v) })).sort((a, b) => b.value - a.value);

export default function AnalyticsPage() {
  const { status } = useSession();
  const s = useApi<Stats>('/api/analytics', [status?.mode]);
  const wallets = useApi<Wallet[]>('/api/wallets?archived=1');
  const tokens = useApi<{ mint: string; meta: { symbol: string | null } | null }[]>('/api/tokens/recent');
  const wl = new Map((wallets.data ?? []).map((w) => [w.publicKey, w.label]));
  const sym = new Map((tokens.data ?? []).map((t) => [t.mint, t.meta?.symbol ?? null]));
  const d = s.data;
  const fmt = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(4)} SOL`;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="row between">
        <h1>Analytics {d?.paper && <span className="badge warn">paper trades</span>}</h1>
        <div className="row">
          <button onClick={() => download('/api/analytics/trades.csv', 'trades.csv')}>Trades CSV</button>
          <button onClick={() => download('/api/analytics/fills.csv', 'fills.csv')}>Fills CSV</button>
          <button onClick={() => download('/api/analytics/pnl.csv', 'pnl.csv')}>P&amp;L CSV</button>
        </div>
      </div>
      <div className="grid g6">
        <Stat label="Win rate" value={d?.winRatePct == null ? '—' : `${d.winRatePct}%`} sub={`${d?.wins ?? 0}W / ${d?.losses ?? 0}L · ${d?.openTrades ?? 0} open`} />
        <Stat label="Profit factor" value={d?.profitFactor == null ? (d?.wins ? '∞' : '—') : d.profitFactor.toFixed(2)} />
        <Stat label="Realized P&L" value={signedSol(d?.totalRealizedLamports)} cls={pnlClass(d?.totalRealizedLamports)} sub={`${d?.fillCount ?? 0} fills`} />
        <Stat label="Avg winner / loser" value={signedSol(d?.avgWinnerLamports)} cls="pos" sub={signedSol(d?.avgLoserLamports)} />
        <Stat label="Max drawdown" value={`−${(lamportsToSol(d?.maxDrawdownLamports) || 0).toFixed(4)}`} cls="neg" sub={d?.maxDrawdownPct == null ? '' : `${d.maxDrawdownPct}% of peak`} />
        <Stat label="Avg holding" value={duration(d?.avgHoldingMs)} />
      </div>
      <div className="grid g2">
        <Stat label="Best trade" value={signedSol(d?.bestTrade?.realized)} cls="pos" sub={d?.bestTrade ? `${sym.get(d.bestTrade.mint) ?? short(d.bestTrade.mint)} · ${wl.get(d.bestTrade.wallet) ?? short(d.bestTrade.wallet)}` : ''} />
        <Stat label="Worst trade" value={signedSol(d?.worstTrade?.realized)} cls="neg" sub={d?.worstTrade ? `${sym.get(d.worstTrade.mint) ?? short(d.worstTrade.mint)} · ${wl.get(d.worstTrade.wallet) ?? short(d.worstTrade.wallet)}` : ''} />
      </div>
      <div className="card">
        <h2>Cumulative realized P&amp;L (SOL)</h2>
        <LineChart points={(d?.equityCurve ?? []).map((p) => ({ x: p.at, y: lamportsToSol(p.cumulativeLamports) }))} format={(y) => y.toFixed(3)} />
      </div>
      <div className="grid g3">
        <div className="card"><h2>P&amp;L by token</h2><PnlBars rows={toRows(d?.pnlByToken ?? {}, (k) => sym.get(k) ?? short(k))} format={fmt} /></div>
        <div className="card"><h2>P&amp;L by wallet</h2><div className="scroll" style={{ maxHeight: 400 }}><PnlBars rows={toRows(d?.pnlByWallet ?? {}, (k) => wl.get(k) ?? short(k))} format={fmt} /></div></div>
        <div className="card"><h2>P&amp;L by strategy</h2><PnlBars rows={toRows(d?.pnlByStrategy ?? {})} format={fmt} /></div>
      </div>
    </div>
  );
}
