'use client';

import { useEffect, useMemo, useState } from 'react';
import { post } from '@/lib/api';
import { sol, signedSol, short } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { Plan, Wallet } from '@/lib/types';
import { ErrorBox } from './ui';

const explorer = (sig: string) => `https://solscan.io/tx/${sig}`;
const TERMINAL = new Set(['CONFIRMED', 'PAPER_FILLED', 'FAILED', 'EXPIRED', 'SKIPPED', 'SIM_FAILED']);

/**
 * Shows every transaction of a plan before execution (amounts, fees,
 * simulation result, expected balances), gates execution behind explicit
 * confirmation (typed "LIVE" in LIVE mode), then streams per-leg results.
 */
export function PlanPreview({ plan, wallets, onDone, onDiscard }: { plan: Plan; wallets?: Wallet[]; onDone?: () => void; onDiscard?: () => void }) {
  const { status, legEvents } = useSession();
  const [reviewed, setReviewed] = useState(false);
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const label = useMemo(() => new Map((wallets ?? []).map((w) => [w.publicKey, w.label])), [wallets]);
  const live = plan.mode === 'LIVE';
  const remaining = Math.max(0, Math.round((plan.expiresAt - now) / 1000));
  const events = legEvents.filter((e) => e.planId === plan.id);
  const latest = new Map<string, (typeof events)[number]>();
  for (const e of [...events].reverse()) latest.set(e.legId, e);
  const finished = running && plan.legs.every((l) => TERMINAL.has(latest.get(l.legId)?.status ?? ''));

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    if (finished) onDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  const canExecute = !running && reviewed && plan.blockers.length === 0 && remaining > 0 && plan.mode === status?.mode && (!live || typed === 'LIVE');

  const execute = async () => {
    setErr(null);
    try {
      setRunning(true);
      await post(`/api/plans/${plan.id}/execute`, { hash: plan.hash });
    } catch (e) {
      setRunning(false);
      setErr((e as Error).message);
    }
  };

  return (
    <div className="card grid" style={{ gap: 12, borderColor: live ? 'var(--live)' : undefined }}>
      <div className="row between">
        <div>
          <h3 style={{ margin: 0 }}>{plan.title}</h3>
          <span className="muted mono">
            plan {plan.id.slice(0, 8)} · <span className={`badge ${live ? 'critical' : 'warn'}`}>{plan.mode}</span> · {running ? 'executing' : remaining > 0 ? `expires in ${remaining}s` : 'EXPIRED — preview again'}
          </span>
        </div>
        {!running && onDiscard && <button className="ghost" onClick={onDiscard}>Discard</button>}
        {running && !finished && <button onClick={() => post(`/api/plans/${plan.id}/cancel`)}>Cancel remaining</button>}
      </div>

      <div className="grid g4">
        <div><div className="muted">SOL out</div><div className="mono">{sol(plan.totals.lamportsOut)}</div></div>
        <div><div className="muted">SOL in (est.)</div><div className="mono">{sol(plan.totals.lamportsIn)}</div></div>
        <div><div className="muted">Network fees (est.)</div><div className="mono">{sol(plan.totals.fees, 6)}</div></div>
        <div>
          {plan.params.sourceRemaining !== undefined && (<><div className="muted">Primary remaining</div><div className="mono">{sol(plan.params.sourceRemaining)}</div></>)}
          {plan.params.expectedSolReceived !== undefined && (<><div className="muted">Expected received</div><div className="mono">{sol(plan.params.expectedSolReceived)}</div></>)}
          {plan.params.avgPriceImpactPct !== undefined && (<><div className="muted">Avg price impact</div><div className="mono">{Number(plan.params.avgPriceImpactPct).toFixed(2)}%</div></>)}
        </div>
      </div>

      {plan.blockers.length > 0 && (
        <div className="alert error">
          <b>Blocked — this plan cannot execute:</b>
          <ul className="plain">{plan.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </div>
      )}
      {plan.warnings.length > 0 && (
        <div className="alert warn">
          <ul className="plain" style={{ margin: 0 }}>{plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}

      <div className="scroll" style={{ maxHeight: 360 }}>
        <table>
          <thead>
            <tr>
              <th>Leg</th><th>Wallet</th><th>When</th><th>Transaction</th><th className="num">SOL Δ</th><th className="num">Fee</th><th>Simulation</th><th className="num">SOL after</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {plan.legs.map((l) => {
              const ev = latest.get(l.legId);
              return (
                <tr key={l.legId}>
                  <td>{l.legId}{l.batch !== undefined ? <span className="muted"> b{l.batch}</span> : null}</td>
                  <td>{label.get(l.wallet) ?? short(l.wallet)}</td>
                  <td className="muted">{l.offsetMs ? `+${(l.offsetMs / 1000).toFixed(1)}s` : 'now'}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 260 }}>{l.description}</td>
                  <td className="num">{signedSol(String(-BigInt(l.lamportsDelta)))}</td>
                  <td className="num">{sol(l.estFeeLamports, 6)}</td>
                  <td>{l.simulation ? (l.simulation.ok ? <span className="badge ok">ok{l.simulation.unitsConsumed ? ` ${l.simulation.unitsConsumed}cu` : ''}</span> : <span className="badge critical" title={l.simulation.logs.join('\n')}>{l.simulation.error}</span>) : <span className="muted">—</span>}</td>
                  <td className="num">{l.simulation?.postLamports != null ? sol(l.simulation.postLamports) : '—'}</td>
                  <td>
                    {ev ? (
                      <>
                        <span className={`badge ${ev.status}`}>{ev.status}</span>{' '}
                        {ev.signature && <a href={explorer(ev.signature)} target="_blank" rel="noreferrer noopener">{ev.signature.slice(0, 8)}…</a>}
                        {ev.error && <span className="neg"> {ev.error}</span>}
                      </>
                    ) : running ? <span className="muted">queued</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ErrorBox error={err} />
      {!running && (
        <div className="row">
          <label className="row"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> I reviewed every transaction above</label>
          {live && <input placeholder='type "LIVE" to sign & send' value={typed} onChange={(e) => setTyped(e.target.value)} />}
          <button className={live ? 'danger' : 'primary'} disabled={!canExecute} onClick={execute}>
            {live ? `Sign & send ${plan.legs.length} leg(s)` : `Execute ${plan.legs.length} paper leg(s)`}
          </button>
          {plan.mode !== status?.mode && <span className="warn">Mode changed since preview — preview again.</span>}
        </div>
      )}
      {finished && <div className="alert info">Execution finished. {events.filter((e) => e.status === 'CONFIRMED' || e.status === 'PAPER_FILLED').length}/{plan.legs.length} legs succeeded.</div>}
    </div>
  );
}
