'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { LineChart, Stat } from '@/components/ui';
import { post } from '@/lib/api';
import { lamportsToSol, pct, pnlClass, signedSol, sol, tokenAmt, usd } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Summary, TokenExposure, WalletView } from '@/lib/types';

export default function DashboardPage() {
  const { status, alerts, subscribe } = useSession();
  const summary = useApi<Summary>('/api/portfolio/summary', [status?.mode], 30_000);
  const tokens = useApi<TokenExposure[]>('/api/portfolio/tokens', [status?.mode], 30_000);
  const wallets = useApi<WalletView[]>('/api/portfolio/wallets', [status?.mode], 60_000);

  const refresh = async () => {
    await post('/api/balances/refresh');
    await Promise.all([summary.reload(), tokens.reload(), wallets.reload()]);
  };
  useEffect(() => {
    void refresh();
    return subscribe((m) => {
      if (m.type === 'plan' && ['DONE', 'PARTIAL', 'FAILED'].includes(m.data.status)) void refresh();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.mode]);

  const s = summary.data;
  const toUsd = (l: string | null | undefined) => (s?.solUsd && l != null ? usd(lamportsToSol(l) * s.solUsd) : '—');
  const invested = s ? Number(s.totalLamports) - Number(s.realizedLamports) - Number(s.unrealizedLamports) : 0;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="row between">
        <h1>Dashboard {s?.paper && <span className="badge warn">paper portfolio</span>}</h1>
        <button onClick={refresh}>Refresh balances</button>
      </div>
      <div className="grid g6">
        <Stat label="Total value" value={`${sol(s?.totalLamports)} SOL`} sub={toUsd(s?.totalLamports)} />
        <Stat label="SOL" value={sol(s?.solLamports)} sub={toUsd(s?.solLamports)} />
        <Stat label="Tokens" value={sol(s?.tokensLamports)} sub={`${s?.tokenCount ?? 0} tokens`} />
        <Stat label="Realized P&L" value={signedSol(s?.realizedLamports)} cls={pnlClass(s?.realizedLamports)} sub={toUsd(s?.realizedLamports)} />
        <Stat label="Unrealized P&L" value={signedSol(s?.unrealizedLamports)} cls={pnlClass(s?.unrealizedLamports)} sub={toUsd(s?.unrealizedLamports)} />
        <Stat label="24h P&L" value={signedSol(s?.dailyPnlLamports)} cls={pnlClass(s?.dailyPnlLamports)} sub={s?.dailyPnlLamports == null ? 'no snapshot 24h ago' : invested > 0 ? pct((Number(s.dailyPnlLamports) / invested) * 100) : ''} />
      </div>

      <div className="card">
        <h2>Portfolio performance (SOL)</h2>
        <LineChart points={(s?.performance ?? []).map((p) => ({ x: p.at, y: lamportsToSol(p.totalLamports) }))} format={(y) => y.toFixed(3)} />
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="row between"><h2>Token holdings</h2><Link href="/positions">Manage →</Link></div>
          <table>
            <thead><tr><th>Token</th><th className="num">Amount</th><th className="num">Value</th><th className="num">P&amp;L</th><th className="num">Return</th><th className="num">Wallets</th></tr></thead>
            <tbody>
              {(tokens.data ?? []).map((t) => (
                <tr key={t.mint}>
                  <td><Link href={`/positions?mint=${t.mint}`}>{t.symbol ?? t.mint.slice(0, 6)}</Link></td>
                  <td className="num">{tokenAmt(t.totalRaw, t.decimals)}</td>
                  <td className="num">{sol(t.valueLamports)}</td>
                  <td className={`num ${pnlClass(t.totalPnlLamports)}`}>{signedSol(t.totalPnlLamports)}</td>
                  <td className={`num ${pnlClass(t.returnPct)}`}>{pct(t.returnPct)}</td>
                  <td className="num">{t.wallets.length}</td>
                </tr>
              ))}
              {!tokens.data?.length && <tr><td colSpan={6} className="muted">No token positions</td></tr>}
            </tbody>
          </table>
          {!!s?.unpricedTokens.length && <p className="warn">{s.unpricedTokens.length} token(s) have no price and are valued at 0.</p>}
        </div>
        <div className="card">
          <div className="row between"><h2>Wallets by value</h2><Link href="/wallets">All →</Link></div>
          <div className="scroll" style={{ maxHeight: 320 }}>
            <table>
              <thead><tr><th>Wallet</th><th className="num">SOL</th><th className="num">Value</th><th className="num">Unrealized</th></tr></thead>
              <tbody>
                {[...(wallets.data ?? [])].sort((a, b) => Number(b.valueLamports) - Number(a.valueLamports)).slice(0, 50).map((w) => (
                  <tr key={w.wallet.publicKey}>
                    <td>{w.wallet.isPrimary ? '★ ' : ''}{w.wallet.label}</td>
                    <td className="num">{sol(w.lamports)}</td>
                    <td className="num">{sol(w.valueLamports)}</td>
                    <td className={`num ${pnlClass(w.unrealizedLamports)}`}>{signedSol(w.unrealizedLamports)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="card">
          <h2>Automation alerts</h2>
          {alerts.slice(0, 10).map((a, i) => (
            <div key={i} className={`alert ${a.data.executed ? 'info' : 'warn'}`} style={{ marginBottom: 6 }}>
              {new Date(a.at).toLocaleTimeString()} · {a.data.kind} #{a.data.ruleId} · {a.data.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
