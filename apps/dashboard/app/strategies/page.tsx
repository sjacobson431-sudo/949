'use client';

import { useState } from 'react';
import { ErrorBox } from '@/components/ui';
import { del, post, put } from '@/lib/api';
import { short, sol, solToLamports } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import type { Strategy } from '@/lib/types';

const blank = (s?: Strategy) => JSON.stringify(
  s
    ? { ...s, builtin: undefined, id: s.builtin ? `${s.id}-custom` : s.id, name: s.builtin ? `${s.name} (custom)` : s.name }
    : null,
  null,
  2,
);

export default function StrategiesPage() {
  const strategies = useApi<Strategy[]>('/api/strategies');
  const automation = useApi<{ autoExecute: boolean; allowLive: boolean; slippageBps: number; priority: { level: string } }>('/api/automation');
  const triggers = useApi<{ id: number; mint: string; side: string; condition: string; priceSol: number; active: boolean; firedAt: number | null }[]>('/api/triggers');
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tMint, setTMint] = useState('');
  const [tSide, setTSide] = useState('BUY');
  const [tCond, setTCond] = useState('PRICE_LTE');
  const [tPrice, setTPrice] = useState('');
  const [tWallets, setTWallets] = useState('');
  const [tSol, setTSol] = useState('0.1');

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await Promise.all([strategies.reload(), automation.reload(), triggers.reload()]);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const a = automation.data;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Strategies</h1>
      <ErrorBox error={err} />
      <div className="grid g3">
        {(strategies.data ?? []).map((s) => (
          <div key={s.id} className="card grid" style={{ gap: 6 }}>
            <div className="row between"><h3 style={{ margin: 0 }}>{s.name}</h3>{s.builtin ? <span className="badge">built-in</span> : <span className="badge info">custom</span>}</div>
            <div className="mono">size {sol(s.perWalletLamports)} SOL/wallet · max {sol(s.maxTotalLamports)} SOL</div>
            <div className="mono">slippage {s.slippageBps} bps · priority {s.priority.level} · {s.timing.kind === 'staggered' ? `staggered ${s.timing.intervalMs}ms ±${s.timing.jitterMs}` : `simultaneous ×${s.timing.concurrency}`}</div>
            <div className="mono">risk ≤ {s.risk.maxScore} · liq ≥ ${s.risk.minLiquidityUsd} · top10 ≤ {s.risk.maxTop10Pct}% · impact ≤ {s.risk.maxPriceImpactPct}%</div>
            <div className="mono">exits {s.exits.takeProfits.map((t) => `+${t.gainPct}%→${t.sellPct}%`).join(' ')} {s.exits.stopLossPct ? `SL −${s.exits.stopLossPct}%` : ''} {s.exits.trailingStopPct ? `TS ${s.exits.trailingStopPct}%` : ''}</div>
            <div className="row">
              <button onClick={() => setEditing(blank(s))}>{s.builtin ? 'Customize copy' : 'Edit'}</button>
              {!s.builtin && <button className="ghost" onClick={() => run(() => del(`/api/strategies/${s.id}`))}>Delete</button>}
            </div>
          </div>
        ))}
      </div>
      {editing !== null && (
        <div className="card grid" style={{ gap: 8 }}>
          <h2>Custom strategy (every parameter editable; amounts in lamports)</h2>
          <textarea rows={24} value={editing} onChange={(e) => setEditing(e.target.value)} />
          <div className="row">
            <button className="primary" onClick={() => run(async () => { const s = JSON.parse(editing); await put(`/api/strategies/${s.id}`, s); setEditing(null); })}>Save</button>
            <button onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="grid g2">
        <div className="card grid" style={{ gap: 8 }}>
          <h2>Automation (exit rules & trigger orders)</h2>
          {a && (
            <>
              <label className="row"><input type="checkbox" checked={a.autoExecute} onChange={(e) => run(() => put('/api/automation', { autoExecute: e.target.checked }))} /> Auto-execute when a rule fires (otherwise: prepare plan + alert)</label>
              <label className="row"><input type="checkbox" checked={a.allowLive} onChange={(e) => run(() => put('/api/automation', { allowLive: e.target.checked }))} /> <span className={a.allowLive ? 'neg' : ''}>Allow auto-execution in LIVE mode (unattended signing)</span></label>
              <div className="row">
                <label className="field">Exit slippage bps<input defaultValue={a.slippageBps} size={6} onBlur={(e) => run(() => put('/api/automation', { slippageBps: Number(e.target.value) }))} /></label>
                <label className="field">Priority<select value={a.priority.level} onChange={(e) => run(() => put('/api/automation', { priority: { level: e.target.value } }))}>{['none', 'low', 'medium', 'high', 'turbo'].map((p) => <option key={p}>{p}</option>)}</select></label>
              </div>
              <p className="muted">Spending limits, whitelist and the self-trade guard still apply to automated plans.</p>
            </>
          )}
        </div>
        <div className="card grid" style={{ gap: 8 }}>
          <h2>Limit-style trigger orders</h2>
          <div className="row">
            <input placeholder="mint" value={tMint} onChange={(e) => setTMint(e.target.value)} />
            <select value={tSide} onChange={(e) => setTSide(e.target.value)}><option>BUY</option><option>SELL</option></select>
            <select value={tCond} onChange={(e) => setTCond(e.target.value)}><option value="PRICE_LTE">price ≤</option><option value="PRICE_GTE">price ≥</option></select>
            <input placeholder="SOL per token" value={tPrice} onChange={(e) => setTPrice(e.target.value)} size={10} />
          </div>
          <div className="row">
            <input placeholder="wallet pubkeys, comma-separated" value={tWallets} onChange={(e) => setTWallets(e.target.value)} style={{ flex: 1 }} />
            <input placeholder={tSide === 'BUY' ? 'SOL / wallet' : '% to sell'} value={tSol} onChange={(e) => setTSol(e.target.value)} size={8} />
            <button
              onClick={() =>
                run(() =>
                  post('/api/triggers', {
                    mint: tMint.trim(), side: tSide, condition: tCond, priceSol: Number(tPrice),
                    request: {
                      wallets: tWallets.split(',').map((s) => s.trim()).filter(Boolean),
                      sizing: tSide === 'BUY' ? { kind: 'fixed', amount: solToLamports(tSol) } : { kind: 'percentOfWallet', pct: Number(tSol) },
                      timing: { kind: 'simultaneous', concurrency: 8 }, slippageBps: 500, priority: { level: 'high' }, strategyTag: 'trigger',
                    },
                  }),
                )
              }
            >Add</button>
          </div>
          <table>
            <tbody>
              {(triggers.data ?? []).map((t) => (
                <tr key={t.id}>
                  <td>#{t.id}</td><td>{t.side}</td><td>{short(t.mint)}</td><td>{t.condition === 'PRICE_LTE' ? '≤' : '≥'} {t.priceSol}</td>
                  <td>{t.active ? <span className="badge info">armed</span> : t.firedAt ? <span className="badge ok">fired</span> : <span className="badge">cancelled</span>}</td>
                  <td>{t.active && <button className="ghost" onClick={() => run(() => del(`/api/triggers/${t.id}`))}>Cancel</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Evaluated client-side on price ticks (not an on-chain limit order); executes via the normal plan pipeline.</p>
        </div>
      </div>
    </div>
  );
}
