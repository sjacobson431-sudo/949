'use client';

import { pct, usd } from '@/lib/format';
import type { RiskReport, TokenAnalysis } from '@/lib/types';
import { Copy } from './ui';

const age = (s: number | null) => (s == null ? '—' : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`);

export function RiskPanel({ analysis: a, risk }: { analysis: TokenAnalysis; risk: RiskReport }) {
  const ratio = a.txns1h.buys + a.txns1h.sells ? Math.round((a.txns1h.buys / (a.txns1h.buys + a.txns1h.sells)) * 100) : null;
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="card grid" style={{ gap: 10 }}>
        <div className="row between">
          <div>
            <h3 style={{ margin: 0 }}>{a.symbol ?? '?'} <span className="muted">{a.name ?? ''}</span></h3>
            <Copy text={a.mint} label={a.mint} />
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="mono" style={{ fontSize: 26, fontWeight: 700 }}>{risk.score}<span className="muted" style={{ fontSize: 13 }}>/100</span></div>
            <span className={`badge ${risk.grade}`}>{risk.grade} RISK</span>{' '}
            <span className={`badge ${risk.passesPolicy ? 'ok' : 'critical'}`}>{risk.passesPolicy ? 'passes policy' : 'fails policy'}</span>
          </div>
        </div>
        <div className="risk-meter" aria-label={`risk ${risk.score} of 100`}><i style={{ left: `calc(${risk.score}% - 1px)` }} /></div>
        {risk.blockers.length > 0 && (
          <div className="alert error"><b>Trade blocked by policy:</b><ul className="plain">{risk.blockers.map((b) => <li key={b}>{b}</li>)}</ul></div>
        )}
        {a.warnings.map((w) => <div key={w} className="alert warn">{w}</div>)}
      </div>

      <div className="grid g6">
        {[
          ['Price', a.priceUsd ? usd(a.priceUsd) : '—'],
          ['Liquidity', usd(a.totalLiquidityUsd)],
          ['Market cap', usd(a.marketCapUsd)],
          ['FDV', usd(a.fdvUsd)],
          ['Age', age(a.tokenAgeSec)],
          ['Liq. change', pct(a.liquidityChangePct)],
          ['Top 10', `${a.top10Pct.toFixed(1)}%`],
          ['Top holder', `${a.topHolderPct.toFixed(1)}%`],
          ['Clustered', `${a.clusteredHolderPct.toFixed(1)}%`],
          ['Buys/Sells 1h', `${a.txns1h.buys}/${a.txns1h.sells}${ratio !== null ? ` (${ratio}%)` : ''}`],
          ['Trades 24h', String(a.txns24h.buys + a.txns24h.sells)],
          ['Decimals', String(a.mintInfo.decimals)],
        ].map(([k, v]) => (
          <div key={k} className="card stat"><div className="label">{k}</div><div className="mono" style={{ marginTop: 4 }}>{v}</div></div>
        ))}
      </div>

      <div className="grid g2">
        <div className="card">
          <h2>Score breakdown</h2>
          <table>
            <thead><tr><th>Factor</th><th className="num">Points</th><th>Detail</th></tr></thead>
            <tbody>
              {risk.factors.map((f) => (
                <tr key={f.id}>
                  <td><span className={`badge ${f.severity}`}>{f.severity}</span> {f.label}</td>
                  <td className="num">{f.points}/{f.maxPoints}</td>
                  <td style={{ whiteSpace: 'normal' }}>{f.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid" style={{ gap: 14 }}>
          <div className="card">
            <h2>Authorities</h2>
            <div className="mono">Mint: {a.mintInfo.mintAuthority ? <span className="neg">ACTIVE {a.mintInfo.mintAuthority.slice(0, 8)}…</span> : <span className="pos">revoked</span>}</div>
            <div className="mono">Freeze: {a.mintInfo.freezeAuthority ? <span className="neg">ACTIVE {a.mintInfo.freezeAuthority.slice(0, 8)}…</span> : <span className="pos">revoked</span>}</div>
            {a.mintInfo.extensions.length > 0 && <div className="mono">Extensions: {a.mintInfo.extensions.join(', ')}</div>}
          </div>
          <div className="card">
            <h2>Pools</h2>
            <table>
              <thead><tr><th>DEX</th><th>Pair</th><th className="num">Liquidity</th><th className="num">Vol 24h</th></tr></thead>
              <tbody>
                {a.pools.map((p) => (
                  <tr key={p.pairAddress}><td>{p.dex}</td><td>/{p.quoteSymbol} <Copy text={p.pairAddress} /></td><td className="num">{usd(p.liquidityUsd)}</td><td className="num">{usd(p.volume24hUsd)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h2>Top holders</h2>
            <div className="scroll" style={{ maxHeight: 220 }}>
              <table>
                <thead><tr><th>Owner</th><th className="num">% supply</th><th /></tr></thead>
                <tbody>
                  {a.holders.map((h) => (
                    <tr key={h.tokenAccount}><td>{h.owner ? <Copy text={h.owner} /> : '?'}</td><td className="num">{h.pctOfSupply.toFixed(2)}%</td><td className="muted">{h.isProgramOrPool ? 'pool/program' : ''}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
