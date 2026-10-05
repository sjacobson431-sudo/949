'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { PlanPreview } from '@/components/PlanPreview';
import { RiskPanel } from '@/components/RiskPanel';
import { WalletPicker } from '@/components/WalletPicker';
import { ErrorBox } from '@/components/ui';
import { post } from '@/lib/api';
import { sol, solToLamports } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Balance, Plan, RiskReport, Strategy, TokenAnalysis, Wallet } from '@/lib/types';

const STEPS = ['Mint', 'Analysis', 'Wallets', 'Capital', 'Allocation', 'Slippage', 'Preview', 'Simulate', 'Confirm', 'Execute', 'Monitor'];

function TradeInner() {
  const params = useSearchParams();
  const { status } = useSession();
  const wallets = useApi<Wallet[]>('/api/wallets');
  const strategies = useApi<Strategy[]>('/api/strategies');
  const [balances, setBalances] = useState<Balance[]>([]);
  const [mint, setMint] = useState(params.get('mint') ?? '');
  const [analysis, setAnalysis] = useState<{ analysis: TokenAnalysis; risk: RiskReport } | null>(null);
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [selected, setSelected] = useState<string[]>([]);
  const [sizingKind, setSizingKind] = useState<'total' | 'fixed' | 'percentOfWallet'>('total');
  const [amount, setAmount] = useState('1');
  const [alloc, setAlloc] = useState<'equal' | 'random'>('equal');
  const [rmin, setRmin] = useState('0.05');
  const [rmax, setRmax] = useState('0.2');
  const [slippage, setSlippage] = useState('300');
  const [maxImpact, setMaxImpact] = useState('5');
  const [priority, setPriority] = useState('medium');
  const [timingKind, setTimingKind] = useState<'simultaneous' | 'staggered'>('simultaneous');
  const [concurrency, setConcurrency] = useState('8');
  const [interval, setInterval_] = useState('2000');
  const [jitter, setJitter] = useState('750');
  const [strategy, setStrategy] = useState('');
  const [enforceRisk, setEnforceRisk] = useState(true);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [executed, setExecuted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    post<Balance[]>('/api/balances/refresh').then(setBalances).catch(() => undefined);
  }, [status?.mode]);

  // Apply a strategy preset's parameters.
  useEffect(() => {
    const s = strategies.data?.find((x) => x.id === strategy);
    if (!s) return;
    setSlippage(String(s.slippageBps));
    setPriority(s.priority.level);
    setMaxImpact(String(s.risk.maxPriceImpactPct));
    setSizingKind('fixed');
    setAmount(String(Number(s.perWalletLamports) / 1e9));
    if (s.timing.kind === 'staggered') {
      setTimingKind('staggered');
      setInterval_(String(s.timing.intervalMs));
      setJitter(String(s.timing.jitterMs));
    } else {
      setTimingKind('simultaneous');
      setConcurrency(String(s.timing.concurrency));
    }
  }, [strategy, strategies.data]);

  const analyze = async () => {
    setErr(null);
    setBusy(true);
    try {
      const preset = strategies.data?.find((x) => x.id === strategy);
      setAnalysis(await post('/api/tokens/analyze', { mint: mint.trim(), policy: preset?.risk }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    setErr(null);
    setBusy(true);
    setExecuted(false);
    try {
      const unit = (v: string) => (side === 'BUY' ? solToLamports(v) : v);
      const sizing =
        sizingKind === 'percentOfWallet'
          ? { kind: 'percentOfWallet', pct: Number(amount) }
          : sizingKind === 'fixed'
            ? { kind: 'fixed', amount: unit(amount) }
            : { kind: 'total', total: unit(amount), allocation: alloc === 'random' ? { kind: 'random', min: unit(rmin), max: unit(rmax) } : { kind: 'equal' } };
      const timing =
        timingKind === 'simultaneous'
          ? { kind: 'simultaneous', concurrency: Number(concurrency) }
          : { kind: 'staggered', intervalMs: Number(interval), jitterMs: Number(jitter), concurrency: Number(concurrency) };
      const r = await post<{ plan: Plan; risk: RiskReport | null }>('/api/plans/trade', {
        mint: mint.trim(), side, wallets: selected, sizing, timing, slippageBps: Number(slippage), priority: { level: priority },
        maxPriceImpactPct: Number(maxImpact), strategyTag: strategy || null, enforceRisk,
      });
      setPlan(r.plan);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const step = !mint ? 0 : !analysis ? 1 : !selected.length ? 2 : !plan ? 6 : executed ? 10 : 8;
  const selectedSol = balances.filter((b) => selected.includes(b.publicKey)).reduce((s, b) => s + BigInt(b.lamports), 0n).toString();

  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Trade</h1>
      <div className="steps">{STEPS.map((s, i) => <span key={s} className={i < step ? 'done' : i === step ? 'cur' : ''}>{i + 1}. {s}</span>)}</div>
      {status?.mode === 'READ_ONLY' && <div className="alert info">READ-ONLY mode: you can analyze tokens, but switch to SIMULATION or LIVE to preview trades.</div>}

      <div className="card grid" style={{ gap: 10 }}>
        <h2>1. Token</h2>
        <form className="row" onSubmit={(e) => (e.preventDefault(), analyze())}>
          <input style={{ flex: 1, minWidth: 320 }} placeholder="Paste token mint address" value={mint} onChange={(e) => (setMint(e.target.value), setAnalysis(null), setPlan(null))} />
          <label className="field">Strategy preset
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              <option value="">(manual)</option>
              {(strategies.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <button className="primary" disabled={!mint.trim() || busy}>2. Run analysis</button>
        </form>
      </div>
      {analysis && <RiskPanel analysis={analysis.analysis} risk={analysis.risk} />}

      {analysis && (
        <div className="card grid" style={{ gap: 12 }}>
          <div className="row between">
            <h2>3. Wallets</h2>
            <div className="row">
              <button className={side === 'BUY' ? 'primary' : ''} onClick={() => setSide('BUY')}>BUY</button>
              <button className={side === 'SELL' ? 'danger' : ''} onClick={() => setSide('SELL')}>SELL</button>
            </div>
          </div>
          <WalletPicker wallets={wallets.data ?? []} balances={balances} selected={selected} onChange={setSelected} mint={mint.trim()} />
          <span className="muted">Selected wallets hold {sol(selectedSol)} SOL.</span>

          <h2>4–5. Capital & allocation</h2>
          <div className="row">
            <label className="field">Sizing
              <select value={sizingKind} onChange={(e) => setSizingKind(e.target.value as typeof sizingKind)}>
                <option value="total">Total {side === 'BUY' ? 'SOL' : 'tokens (raw)'} across wallets</option>
                <option value="fixed">Fixed {side === 'BUY' ? 'SOL' : 'raw tokens'} per wallet</option>
                <option value="percentOfWallet">% of each wallet</option>
              </select>
            </label>
            <label className="field">{sizingKind === 'percentOfWallet' ? 'Percent' : side === 'BUY' ? 'SOL' : 'Raw amount'}<input value={amount} onChange={(e) => setAmount(e.target.value)} size={10} /></label>
            {sizingKind === 'total' && (
              <label className="field">Allocation
                <select value={alloc} onChange={(e) => setAlloc(e.target.value as typeof alloc)}><option value="equal">Equal{side === 'SELL' ? ' (pro-rata holdings)' : ''}</option><option value="random">Random range</option></select>
              </label>
            )}
            {sizingKind === 'total' && alloc === 'random' && (
              <>
                <label className="field">Min / wallet<input value={rmin} onChange={(e) => setRmin(e.target.value)} size={7} /></label>
                <label className="field">Max / wallet<input value={rmax} onChange={(e) => setRmax(e.target.value)} size={7} /></label>
              </>
            )}
          </div>

          <h2>6. Slippage, priority & timing</h2>
          <div className="row">
            <label className="field">Max slippage (bps)<input value={slippage} onChange={(e) => setSlippage(e.target.value)} size={6} /></label>
            <label className="field">Max price impact %<input value={maxImpact} onChange={(e) => setMaxImpact(e.target.value)} size={5} /></label>
            <label className="field">Priority fee
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>{['none', 'low', 'medium', 'high', 'turbo'].map((p) => <option key={p}>{p}</option>)}</select>
            </label>
            <label className="field">Execution
              <select value={timingKind} onChange={(e) => setTimingKind(e.target.value as typeof timingKind)}><option value="simultaneous">Simultaneous</option><option value="staggered">Staggered</option></select>
            </label>
            <label className="field">Concurrency<input value={concurrency} onChange={(e) => setConcurrency(e.target.value)} size={4} /></label>
            {timingKind === 'staggered' && (
              <>
                <label className="field">Interval ms<input value={interval} onChange={(e) => setInterval_(e.target.value)} size={6} /></label>
                <label className="field">Jitter ± ms<input value={jitter} onChange={(e) => setJitter(e.target.value)} size={6} /></label>
              </>
            )}
            <label className="row"><input type="checkbox" checked={enforceRisk} onChange={(e) => setEnforceRisk(e.target.checked)} /> enforce risk policy</label>
          </div>
          <div className="row">
            <button className="primary" disabled={busy || !selected.length || status?.mode === 'READ_ONLY'} onClick={preview}>
              {busy ? 'Quoting & simulating…' : '7–8. Preview & simulate'}
            </button>
          </div>
        </div>
      )}
      <ErrorBox error={err} />
      {plan && <PlanPreview plan={plan} wallets={wallets.data ?? []} onDone={() => (setExecuted(true), post<Balance[]>('/api/balances/refresh').then(setBalances))} onDiscard={() => setPlan(null)} />}
    </div>
  );
}

export default function TradePage() {
  return (
    <Suspense>
      <TradeInner />
    </Suspense>
  );
}
