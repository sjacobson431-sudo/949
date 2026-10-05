'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { PlanPreview } from '@/components/PlanPreview';
import { WalletPicker } from '@/components/WalletPicker';
import { ErrorBox, Stat } from '@/components/ui';
import { del, get, post } from '@/lib/api';
import { pct, pnlClass, price, short, signedSol, sol, solToLamports, tokenAmt } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Balance, Plan, TokenExposure, Wallet } from '@/lib/types';

interface ExitRule {
  id: number; mint: string; wallets: string[]; active: boolean; strategyTag: string | null;
  spec: { takeProfits: { gainPct: number; sellPct: number }[]; stopLossPct?: number; trailingStopPct?: number; trailingActivationPct?: number };
  state: { firedTiers: number[]; peakSolPerToken: number; stopped: boolean };
}

function PositionsInner() {
  const params = useSearchParams();
  const { status, subscribe } = useSession();
  const tokens = useApi<TokenExposure[]>('/api/portfolio/tokens', [status?.mode]);
  const wallets = useApi<Wallet[]>('/api/wallets?archived=1');
  const [mint, setMint] = useState<string | null>(params.get('mint'));
  const [detail, setDetail] = useState<{ token: TokenExposure; exitRules: ExitRule[] } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [sellPct, setSellPct] = useState('25');
  const [slippage, setSlippage] = useState('500');
  const [priority, setPriority] = useState('high');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [tokenDest, setTokenDest] = useState('');
  const [tp, setTp] = useState('50:25, 100:25, 200:25');
  const [sl, setSl] = useState('30');
  const [trail, setTrail] = useState('');
  const [trailAct, setTrailAct] = useState('');

  const loadDetail = async (m: string) => {
    try {
      const d = await get(`/api/portfolio/tokens/${m}`);
      setDetail(d);
      setSelected(d.token.wallets.map((w: { wallet: string }) => w.wallet));
    } catch (e) {
      setDetail(null);
      setErr((e as Error).message);
    }
  };
  const refreshAll = async () => {
    await post('/api/balances/refresh').catch(() => undefined);
    await tokens.reload();
    if (mint) await loadDetail(mint);
  };
  useEffect(() => {
    void refreshAll();
    return subscribe((m) => {
      if (m.type === 'plan' && ['DONE', 'PARTIAL', 'FAILED'].includes(m.data.status)) void refreshAll();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mint, status?.mode]);

  const exec = { slippageBps: Number(slippage), priority: { level: priority }, timing: { kind: 'simultaneous', concurrency: 8 } };
  const act = async (fn: () => Promise<Plan | Plan[]>) => {
    setErr(null);
    try {
      const r = await fn();
      setPlans(Array.isArray(r) ? r : [r]);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const t = detail?.token;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="row between">
        <h1>Positions</h1>
        <button className="danger" disabled={status?.mode === 'READ_ONLY'} onClick={() => act(() => post('/api/plans/emergency-exit', {}))}>EMERGENCY EXIT (all tokens)</button>
      </div>
      <ErrorBox error={err} />

      <div className="card">
        <table>
          <thead><tr><th>Token</th><th className="num">Amount</th><th className="num">Avg entry</th><th className="num">Current</th><th className="num">Value</th><th className="num">P&amp;L</th><th className="num">Return</th><th className="num">Wallets</th></tr></thead>
          <tbody>
            {(tokens.data ?? []).map((x) => (
              <tr key={x.mint} className={x.mint === mint ? 'selected' : ''} style={{ cursor: 'pointer' }} onClick={() => (setMint(x.mint), setPlans([]))}>
                <td>{x.symbol ?? short(x.mint)}</td>
                <td className="num">{tokenAmt(x.totalRaw, x.decimals)}</td>
                <td className="num">{price(x.avgEntrySolPerToken)}</td>
                <td className="num">{price(x.currentSolPerToken)}</td>
                <td className="num">{sol(x.valueLamports)}</td>
                <td className={`num ${pnlClass(x.totalPnlLamports)}`}>{signedSol(x.totalPnlLamports)}</td>
                <td className={`num ${pnlClass(x.returnPct)}`}>{pct(x.returnPct)}</td>
                <td className="num">{x.wallets.length}</td>
              </tr>
            ))}
            {!tokens.data?.length && <tr><td colSpan={8} className="muted">No open positions</td></tr>}
          </tbody>
        </table>
      </div>

      {t && (
        <>
          <div className="grid g6">
            <Stat label="Total exposure" value={tokenAmt(t.totalRaw, t.decimals)} sub={t.symbol ?? short(t.mint)} />
            <Stat label="Value" value={`${sol(t.valueLamports)} SOL`} />
            <Stat label="Avg entry (SOL)" value={price(t.avgEntrySolPerToken)} sub={`now ${price(t.currentSolPerToken)}`} />
            <Stat label="Realized" value={signedSol(t.realizedLamports)} cls={pnlClass(t.realizedLamports)} />
            <Stat label="Unrealized" value={signedSol(t.unrealizedLamports)} cls={pnlClass(t.unrealizedLamports)} />
            <Stat label="Return" value={pct(t.returnPct)} cls={pnlClass(t.returnPct)} sub={`total ${signedSol(t.totalPnlLamports)}`} />
          </div>

          <div className="card">
            <h2>Every wallet holding {t.symbol ?? short(t.mint)}</h2>
            <div className="scroll">
              <table>
                <thead><tr><th /><th>Wallet</th><th className="num">Amount</th><th className="num">% of position</th><th className="num">Entry</th><th className="num">Unrealized</th><th className="num">Sell amount (raw)</th></tr></thead>
                <tbody>
                  {t.wallets.map((w) => {
                    const sel = selected.includes(w.wallet);
                    return (
                      <tr key={w.wallet} className={sel ? 'selected' : ''}>
                        <td><input type="checkbox" checked={sel} onChange={() => setSelected(sel ? selected.filter((x) => x !== w.wallet) : [...selected, w.wallet])} /></td>
                        <td>{w.label} <span className="muted">{short(w.wallet)}</span></td>
                        <td className="num">{tokenAmt(w.raw, t.decimals)}</td>
                        <td className="num"><div className="bar" style={{ width: 80, display: 'inline-block', marginRight: 6 }}><i style={{ width: `${w.pctOfPosition}%` }} /></div>{w.pctOfPosition.toFixed(1)}%</td>
                        <td className="num">{price(w.avgEntrySolPerToken)}</td>
                        <td className={`num ${pnlClass(w.unrealizedLamports)}`}>{signedSol(w.unrealizedLamports)}</td>
                        <td className="num"><input size={14} placeholder={w.raw} value={amounts[w.wallet] ?? ''} onChange={(e) => setAmounts({ ...amounts, [w.wallet]: e.target.value })} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid g3">
            <div className="card grid" style={{ gap: 8 }}>
              <h2>Sell</h2>
              <div className="row">
                <label className="field">Slippage bps<input value={slippage} onChange={(e) => setSlippage(e.target.value)} size={5} /></label>
                <label className="field">Priority<select value={priority} onChange={(e) => setPriority(e.target.value)}>{['none', 'low', 'medium', 'high', 'turbo'].map((p) => <option key={p}>{p}</option>)}</select></label>
              </div>
              <div className="row">
                {['25', '50', '100'].map((p) => <button key={p} onClick={() => setSellPct(p)} className={sellPct === p ? 'primary' : ''}>{p}%</button>)}
                <input value={sellPct} onChange={(e) => setSellPct(e.target.value)} size={4} />%
              </div>
              <button disabled={!selected.length} onClick={() => act(() => post('/api/plans/sell-percent', { mint: t.mint, pct: Number(sellPct), wallets: selected, ...exec }))}>
                Sell {sellPct}% from {selected.length} selected wallet(s)
              </button>
              <button
                disabled={!Object.values(amounts).some(Boolean)}
                onClick={() => act(() => post('/api/plans/sell-amounts', { mint: t.mint, amounts: Object.fromEntries(Object.entries(amounts).filter(([, v]) => v)), ...exec }))}
              >Sell entered amounts</button>
            </div>
            <div className="card grid" style={{ gap: 8 }}>
              <h2>Move / consolidate tokens</h2>
              <label className="field">Destination wallet
                <select value={tokenDest} onChange={(e) => setTokenDest(e.target.value)}>
                  <option value="">primary</option>
                  {(wallets.data ?? []).map((w) => <option key={w.publicKey} value={w.publicKey}>{w.label}</option>)}
                </select>
              </label>
              <button disabled={!selected.length} onClick={() => act(() => post('/api/plans/consolidate', { wallets: selected, tokenDestination: tokenDest || undefined, includeSol: false, tokens: [t.mint], closeEmptyAccounts: false }))}>
                Consolidate {t.symbol ?? 'token'} into one wallet
              </button>
              <button disabled={selected.length < 2} onClick={() => act(() => post('/api/plans/rebalance', { mint: t.mint, wallets: selected }))}>Rebalance equally across selected</button>
            </div>
            <form
              className="card grid"
              style={{ gap: 8 }}
              onSubmit={async (e) => {
                e.preventDefault();
                setErr(null);
                try {
                  const takeProfits = tp.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
                    const [g, p] = s.split(':').map(Number);
                    return { gainPct: g!, sellPct: p! };
                  });
                  await post('/api/exit-rules', {
                    mint: t.mint, wallets: selected, spec: { takeProfits, stopLossPct: sl ? Number(sl) : undefined, trailingStopPct: trail ? Number(trail) : undefined, trailingActivationPct: trailAct ? Number(trailAct) : undefined },
                  });
                  await loadDetail(t.mint);
                } catch (x) {
                  setErr((x as Error).message);
                }
              }}
            >
              <h2>Exit strategy</h2>
              <label className="field">Take profits (gain%:sell% of position)<input value={tp} onChange={(e) => setTp(e.target.value)} /></label>
              <div className="row">
                <label className="field">Stop loss −%<input value={sl} onChange={(e) => setSl(e.target.value)} size={4} /></label>
                <label className="field">Trailing %<input value={trail} onChange={(e) => setTrail(e.target.value)} size={4} /></label>
                <label className="field">Arm at +%<input value={trailAct} onChange={(e) => setTrailAct(e.target.value)} size={4} /></label>
              </div>
              <button disabled={!selected.length}>Add rule for {selected.length} wallet(s)</button>
            </form>
          </div>

          {detail.exitRules.length > 0 && (
            <div className="card">
              <h2>Active exit rules</h2>
              <table>
                <thead><tr><th>#</th><th>Wallets</th><th>Take profits</th><th>Stop</th><th>Trailing</th><th>Fired</th><th /></tr></thead>
                <tbody>
                  {detail.exitRules.map((r) => (
                    <tr key={r.id}>
                      <td>{r.id}</td>
                      <td>{r.wallets.length}</td>
                      <td>{r.spec.takeProfits.map((x, i) => <span key={i} className={`badge ${r.state.firedTiers.includes(i) ? 'ok' : ''}`}>+{x.gainPct}%→{x.sellPct}% </span>)}</td>
                      <td>{r.spec.stopLossPct ? `−${r.spec.stopLossPct}%` : '—'}</td>
                      <td>{r.spec.trailingStopPct ? `${r.spec.trailingStopPct}%${r.spec.trailingActivationPct ? ` after +${r.spec.trailingActivationPct}%` : ''}` : '—'}</td>
                      <td>{r.state.firedTiers.length}/{r.spec.takeProfits.length}</td>
                      <td><button className="ghost" onClick={async () => (await del(`/api/exit-rules/${r.id}`), loadDetail(t.mint))}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">Rules evaluate on every price tick. Enable auto-execution in Strategies → Automation; otherwise a plan is prepared for your confirmation.</p>
            </div>
          )}
        </>
      )}

      {plans.map((p) => <PlanPreview key={p.id} plan={p} wallets={wallets.data ?? []} onDone={refreshAll} onDiscard={() => setPlans(plans.filter((x) => x.id !== p.id))} />)}

      <ConsolidateSol wallets={wallets.data ?? []} />
    </div>
  );
}

function ConsolidateSol({ wallets }: { wallets: Wallet[] }) {
  const { status } = useSession();
  const [balances, setBalances] = useState<Balance[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [reserve, setReserve] = useState('0');
  const [includeTokens, setIncludeTokens] = useState(true);
  const [close, setClose] = useState(true);
  const [dest, setDest] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    post<Balance[]>('/api/balances/refresh').then(setBalances).catch(() => undefined);
  }, [status?.mode]);
  return (
    <div className="card grid" style={{ gap: 10 }}>
      <h2>Wallet consolidation — SOL, tokens, rent reclaim</h2>
      <WalletPicker wallets={wallets.filter((w) => !w.archived)} balances={balances} selected={selected} onChange={setSelected} />
      <div className="row">
        <label className="field">SOL destination
          <select value={dest} onChange={(e) => setDest(e.target.value)}>
            <option value="">primary</option>
            {wallets.map((w) => <option key={w.publicKey} value={w.publicKey}>{w.label}</option>)}
          </select>
        </label>
        <label className="field">Leave SOL reserve<input value={reserve} onChange={(e) => setReserve(e.target.value)} size={6} /></label>
        <label className="row"><input type="checkbox" checked={includeTokens} onChange={(e) => setIncludeTokens(e.target.checked)} /> move all tokens</label>
        <label className="row"><input type="checkbox" checked={close} onChange={(e) => setClose(e.target.checked)} /> close empty token accounts (reclaim rent)</label>
        <button
          className="primary"
          disabled={!selected.length || status?.mode === 'READ_ONLY'}
          onClick={async () => {
            setErr(null);
            try {
              setPlan(await post('/api/plans/consolidate', { wallets: selected, solDestination: dest || undefined, solReserve: solToLamports(reserve), tokens: includeTokens, closeEmptyAccounts: close }));
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >Preview consolidation</button>
      </div>
      <ErrorBox error={err} />
      {plan && (
        <>
          <table>
            <thead><tr><th>Wallet</th><th className="num">Start SOL</th><th className="num">Tokens moved</th><th className="num">Accounts closed</th><th className="num">Rent reclaimed</th><th className="num">Fees</th><th className="num">Sweep</th><th className="num">Left</th></tr></thead>
            <tbody>
              {(plan.params.perWallet as any[]).map((w) => (
                <tr key={w.wallet}>
                  <td>{wallets.find((x) => x.publicKey === w.wallet)?.label ?? short(w.wallet)}</td>
                  <td className="num">{sol(w.startLamports)}</td><td className="num">{w.tokensMoved.length}</td><td className="num">{w.accountsClosed}</td>
                  <td className="num">{sol(w.rentReclaimed, 6)}</td><td className="num">{sol(w.fees, 6)}</td><td className="num">{sol(w.sweepLamports)}</td><td className="num">{sol(w.remainingLamports)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <PlanPreview plan={plan} wallets={wallets} onDone={() => post<Balance[]>('/api/balances/refresh').then(setBalances)} onDiscard={() => setPlan(null)} />
        </>
      )}
    </div>
  );
}

export default function PositionsPage() {
  return (
    <Suspense>
      <PositionsInner />
    </Suspense>
  );
}
