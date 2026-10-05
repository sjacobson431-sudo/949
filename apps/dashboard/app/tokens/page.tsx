'use client';

import Link from 'next/link';
import { useState } from 'react';
import { RiskPanel } from '@/components/RiskPanel';
import { ErrorBox } from '@/components/ui';
import { post } from '@/lib/api';
import { ago, short, usd } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import type { RiskReport, TokenAnalysis } from '@/lib/types';

export default function TokensPage() {
  const [mint, setMint] = useState('');
  const [res, setRes] = useState<{ analysis: TokenAnalysis; risk: RiskReport } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const recent = useApi<{ mint: string; at: number; liquidityUsd: number; riskScore: number | null; meta: { symbol: string | null } | null; price: { usd: number } | null }[]>('/api/tokens/recent');

  const analyze = async (m = mint) => {
    setErr(null);
    setBusy(true);
    try {
      setRes(await post('/api/tokens/analyze', { mint: m.trim() }));
      void recent.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Tokens</h1>
      <form className="row" onSubmit={(e) => (e.preventDefault(), analyze())}>
        <input style={{ flex: 1, minWidth: 320 }} placeholder="Paste token mint address" value={mint} onChange={(e) => setMint(e.target.value)} />
        <button className="primary" disabled={busy || !mint.trim()}>{busy ? 'Analyzing…' : 'Analyze'}</button>
        {res && <Link href={`/trade?mint=${res.analysis.mint}`}><button type="button">Trade this token →</button></Link>}
      </form>
      <ErrorBox error={err} />
      {res && <RiskPanel analysis={res.analysis} risk={res.risk} />}
      <div className="card">
        <h2>Recently analyzed</h2>
        <table>
          <thead><tr><th>Token</th><th>Mint</th><th className="num">Liquidity</th><th className="num">Price</th><th className="num">Risk</th><th>When</th></tr></thead>
          <tbody>
            {(recent.data ?? []).map((t) => (
              <tr key={t.mint} style={{ cursor: 'pointer' }} onClick={() => (setMint(t.mint), analyze(t.mint))}>
                <td>{t.meta?.symbol ?? '?'}</td>
                <td className="muted">{short(t.mint)}</td>
                <td className="num">{usd(t.liquidityUsd)}</td>
                <td className="num">{usd(t.price?.usd)}</td>
                <td className="num">{t.riskScore ?? '—'}</td>
                <td className="muted">{ago(t.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
