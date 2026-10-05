'use client';

import { useEffect, useMemo, useState } from 'react';
import { PlanPreview } from '@/components/PlanPreview';
import { WalletPicker } from '@/components/WalletPicker';
import { Copy, ErrorBox } from '@/components/ui';
import { download, get, patch, post } from '@/lib/api';
import { ago, pnlClass, short, signedSol, sol, solToLamports, tokenAmt } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Audit, Balance, Plan, Wallet, WalletView } from '@/lib/types';

type AllocKind = 'equal' | 'random' | 'weighted' | 'percentage';

export default function WalletsPage() {
  const { status } = useSession();
  const [showArchived, setShowArchived] = useState(false);
  const wallets = useApi<Wallet[]>(`/api/wallets${showArchived ? '?archived=1' : ''}`, [showArchived]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refreshBalances = async () => {
    try {
      setBalances(await post<Balance[]>('/api/balances/refresh'));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    void refreshBalances();
  }, [status?.mode]);

  const bal = useMemo(() => new Map(balances.map((b) => [b.publicKey, b])), [balances]);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setErr(null);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      await wallets.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // ---- generate / import
  const [genCount, setGenCount] = useState('10');
  const [genGroup, setGenGroup] = useState('');
  const [genPrefix, setGenPrefix] = useState('w');
  const [importSecret, setImportSecret] = useState('');
  const [importLabel, setImportLabel] = useState('');
  // ---- bulk
  const [bulkGroup, setBulkGroup] = useState('');
  // ---- export
  const [exportPw, setExportPw] = useState('');

  const totalSol = balances.reduce((s, b) => s + BigInt(b.lamports), 0n).toString();

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="row between">
        <h1>Wallets <span className="muted">({wallets.data?.length ?? 0} · {sol(totalSol)} SOL)</span></h1>
        <div className="row">
          <label className="row"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> show archived</label>
          <button onClick={refreshBalances}>Refresh balances</button>
          <button onClick={() => download('/api/wallets/export.csv', 'wallets.csv')}>Export public CSV</button>
        </div>
      </div>
      <ErrorBox error={err ?? wallets.error} />
      {msg && <div className="alert info">{msg}</div>}

      <div className="grid g3">
        <form className="card grid" style={{ gap: 8 }} onSubmit={(e) => (e.preventDefault(), run(() => post('/api/wallets/generate', { count: Number(genCount), group: genGroup || null, labelPrefix: genPrefix }), `Generated ${genCount} wallets`))}>
          <h2>Generate wallets</h2>
          <div className="row">
            <label className="field">Count<input value={genCount} onChange={(e) => setGenCount(e.target.value)} size={5} /></label>
            <label className="field">Group<input value={genGroup} onChange={(e) => setGenGroup(e.target.value)} size={10} /></label>
            <label className="field">Label prefix<input value={genPrefix} onChange={(e) => setGenPrefix(e.target.value)} size={6} /></label>
          </div>
          <button className="primary">Generate (keys encrypted locally)</button>
        </form>
        <form className="card grid" style={{ gap: 8 }} onSubmit={(e) => (e.preventDefault(), run(async () => { await post('/api/wallets/import', { secret: importSecret, label: importLabel || undefined }); setImportSecret(''); }, 'Imported'))}>
          <h2>Import wallet</h2>
          <input type="password" placeholder="secret key (base58 or [..] JSON)" value={importSecret} onChange={(e) => setImportSecret(e.target.value)} autoComplete="off" />
          <input placeholder="label" value={importLabel} onChange={(e) => setImportLabel(e.target.value)} />
          <button disabled={!importSecret}>Import</button>
          <span className="muted">Sent only to the local engine (127.0.0.1) and stored encrypted.</span>
        </form>
        <div className="card grid" style={{ gap: 8 }}>
          <h2>Selected ({selected.length})</h2>
          <div className="row">
            <input placeholder="group" value={bulkGroup} onChange={(e) => setBulkGroup(e.target.value)} size={10} />
            <button disabled={!selected.length} onClick={() => run(() => post('/api/wallets/bulk', { publicKeys: selected, patch: { groupName: bulkGroup || null } }), 'Group updated')}>Set group</button>
            <button disabled={!selected.length} onClick={() => run(() => post('/api/wallets/bulk', { publicKeys: selected, patch: { archived: true } }), 'Archived')}>Archive</button>
            <button disabled={!selected.length} onClick={() => run(() => post('/api/wallets/bulk', { publicKeys: selected, patch: { archived: false } }), 'Unarchived')}>Unarchive</button>
          </div>
          <div className="row">
            <input type="password" placeholder="export password" value={exportPw} onChange={(e) => setExportPw(e.target.value)} autoComplete="new-password" />
            <button
              disabled={!selected.length || !exportPw}
              onClick={() =>
                run(async () => {
                  const bundle = await post('/api/wallets/export', { publicKeys: selected, exportPassword: exportPw });
                  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `wallets-export-${Date.now()}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                  setExportPw('');
                }, 'Encrypted export downloaded')
              }
            >Export encrypted</button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="scroll">
          <table>
            <thead>
              <tr><th /><th>Label</th><th>Group</th><th>Tags</th><th>Public key</th><th className="num">SOL</th><th className="num">Tokens</th><th>Source</th><th /></tr>
            </thead>
            <tbody>
              {(wallets.data ?? []).map((w) => {
                const b = bal.get(w.publicKey);
                const sel = selected.includes(w.publicKey);
                return (
                  <tr key={w.publicKey} className={sel ? 'selected' : ''}>
                    <td><input type="checkbox" checked={sel} onChange={() => setSelected(sel ? selected.filter((x) => x !== w.publicKey) : [...selected, w.publicKey])} /></td>
                    <td>
                      {w.isPrimary && <span className="badge info">primary</span>}{' '}
                      <span style={{ cursor: 'pointer' }} onClick={() => { const l = prompt('Label', w.label); if (l) void run(() => patch(`/api/wallets/${w.publicKey}`, { label: l })); }}>{w.label}</span>
                      {w.archived && <span className="badge"> archived</span>}
                    </td>
                    <td className="muted">{w.groupName ?? ''}</td>
                    <td className="muted">{w.tags.join(', ')}</td>
                    <td><Copy text={w.publicKey} label={w.publicKey} /></td>
                    <td className="num">{b ? sol(b.lamports) : '—'}</td>
                    <td className="num">{b ? b.tokens.filter((t) => t.amountRaw !== '0').length : '—'}</td>
                    <td className="muted">{w.source}</td>
                    <td className="row">
                      <button className="ghost" onClick={() => setDetail(w.publicKey)}>Details</button>
                      {!w.isPrimary && <button className="ghost" onClick={() => run(() => post(`/api/wallets/${w.publicKey}/primary`), 'Primary wallet changed')}>Make primary</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {detail && <WalletDetail pk={detail} onClose={() => setDetail(null)} />}
      <DistributePanel wallets={wallets.data ?? []} balances={balances} onDone={refreshBalances} />
    </div>
  );
}

function WalletDetail({ pk, onClose }: { pk: string; onClose: () => void }) {
  const d = useApi<{ wallet: Wallet; view: WalletView | null; audit: Audit[]; chainHistory: { signature: string; blockTime: number | null; err: unknown }[] }>(`/api/wallets/${pk}`, [pk]);
  const v = d.data?.view;
  return (
    <div className="card grid" style={{ gap: 12 }}>
      <div className="row between"><h2>{d.data?.wallet.label} · {short(pk)}</h2><button className="ghost" onClick={onClose}>Close</button></div>
      {v && (
        <div className="grid g4">
          <div><div className="muted">SOL</div><div className="mono">{sol(v.lamports)}</div></div>
          <div><div className="muted">Value</div><div className="mono">{sol(v.valueLamports)}</div></div>
          <div><div className="muted">Realized</div><div className={`mono ${pnlClass(v.realizedLamports)}`}>{signedSol(v.realizedLamports)}</div></div>
          <div><div className="muted">Unrealized</div><div className={`mono ${pnlClass(v.unrealizedLamports)}`}>{signedSol(v.unrealizedLamports)}</div></div>
        </div>
      )}
      <div className="grid g2">
        <div>
          <h3>Holdings</h3>
          <table>
            <thead><tr><th>Token</th><th className="num">Amount</th><th className="num">Entry</th><th className="num">Current</th><th className="num">Value</th><th className="num">P&amp;L</th></tr></thead>
            <tbody>
              {(v?.holdings ?? []).map((h) => (
                <tr key={h.mint}>
                  <td>{h.symbol ?? short(h.mint)}</td>
                  <td className="num">{tokenAmt(h.balanceRaw, h.decimals)}</td>
                  <td className="num">{h.tracked ? h.avgEntrySolPerToken.toPrecision(4) : 'untracked'}</td>
                  <td className="num">{h.currentSolPerToken?.toPrecision(4) ?? '—'}</td>
                  <td className="num">{sol(h.valueLamports)}</td>
                  <td className={`num ${pnlClass(h.unrealizedLamports)}`}>{signedSol(h.unrealizedLamports)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h3>Transaction history</h3>
          <div className="scroll" style={{ maxHeight: 260 }}>
            <table>
              <tbody>
                {(d.data?.audit ?? []).map((a) => (
                  <tr key={a.id}><td>{ago(a.createdAt)}</td><td>{a.kind}</td><td><span className={`badge ${a.status}`}>{a.status}</span></td><td style={{ whiteSpace: 'normal' }}>{a.details.description ?? ''}</td></tr>
                ))}
                {(d.data?.chainHistory ?? []).map((c) => (
                  <tr key={c.signature}><td>{c.blockTime ? ago(c.blockTime * 1000) : ''}</td><td>on-chain</td><td>{c.err ? <span className="badge FAILED">failed</span> : <span className="badge ok">ok</span>}</td><td><a href={`https://solscan.io/tx/${c.signature}`} target="_blank" rel="noreferrer noopener">{c.signature.slice(0, 16)}…</a></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function DistributePanel({ wallets, balances, onDone }: { wallets: Wallet[]; balances: Balance[]; onDone: () => void }) {
  const { status } = useSession();
  const [recipients, setRecipients] = useState<string[]>([]);
  const [kind, setKind] = useState<AllocKind>('equal');
  const [total, setTotal] = useState('1');
  const [rmin, setRmin] = useState('0.05');
  const [rmax, setRmax] = useState('0.15');
  const [weights, setWeights] = useState('');
  const [minBal, setMinBal] = useState('');
  const [maxBal, setMaxBal] = useState('');
  const [gas, setGas] = useState<'auto' | 'none' | 'custom'>('auto');
  const [gasCustom, setGasCustom] = useState('0.01');
  const [expectedTxs, setExpectedTxs] = useState('4');
  const [priority, setPriority] = useState('low');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const primary = wallets.find((w) => w.isPrimary);

  const preview = async () => {
    setErr(null);
    try {
      let spec: unknown = { kind: 'equal' };
      if (kind === 'random') spec = { kind: 'random', min: solToLamports(rmin), max: solToLamports(rmax) };
      if (kind === 'weighted' || kind === 'percentage') {
        // "label:value" pairs, one per line or comma separated
        const m: Record<string, number> = {};
        for (const part of weights.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)) {
          const [l, v] = part.split(':');
          const w = wallets.find((x) => x.label === l?.trim() || x.publicKey === l?.trim());
          if (w) m[w.publicKey] = Number(v);
        }
        spec = kind === 'weighted' ? { kind, weights: m } : { kind, pcts: m };
      }
      setPlan(
        await post<Plan>('/api/plans/distribute', {
          recipients,
          total: kind === 'random' ? '0' : solToLamports(total),
          spec,
          constraints: { minWalletBalance: minBal ? solToLamports(minBal) : undefined, maxWalletBalance: maxBal ? solToLamports(maxBal) : undefined },
          gasReserve: gas === 'auto' ? 'auto' : gas === 'none' ? '0' : solToLamports(gasCustom),
          autoGas: { expectedTxs: Number(expectedTxs), newTokenAccounts: 1 },
          priority: { level: priority },
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="card grid" style={{ gap: 12 }}>
      <h2>Capital distribution — from {primary ? `${primary.label} (${sol(balances.find((b) => b.publicKey === primary.publicKey)?.lamports)} SOL)` : 'primary wallet'}</h2>
      {status?.mode === 'READ_ONLY' && <div className="alert info">Switch to SIMULATION or LIVE to plan transfers.</div>}
      <WalletPicker wallets={wallets} balances={balances} selected={recipients} onChange={setRecipients} />
      <div className="row">
        <label className="field">Allocation
          <select value={kind} onChange={(e) => setKind(e.target.value as AllocKind)}>
            <option value="equal">Equal</option><option value="percentage">Percentage</option><option value="weighted">Weighted</option><option value="random">Random range</option>
          </select>
        </label>
        {kind !== 'random' ? <label className="field">Total SOL<input value={total} onChange={(e) => setTotal(e.target.value)} size={8} /></label> : (
          <>
            <label className="field">Min SOL / wallet<input value={rmin} onChange={(e) => setRmin(e.target.value)} size={7} /></label>
            <label className="field">Max SOL / wallet<input value={rmax} onChange={(e) => setRmax(e.target.value)} size={7} /></label>
          </>
        )}
        <label className="field">Min wallet balance<input value={minBal} onChange={(e) => setMinBal(e.target.value)} placeholder="SOL" size={7} /></label>
        <label className="field">Max wallet balance<input value={maxBal} onChange={(e) => setMaxBal(e.target.value)} placeholder="SOL" size={7} /></label>
        <label className="field">Gas reserve
          <select value={gas} onChange={(e) => setGas(e.target.value as typeof gas)}><option value="auto">Auto</option><option value="none">None</option><option value="custom">Custom</option></select>
        </label>
        {gas === 'auto' && <label className="field">Expected txs / wallet<input value={expectedTxs} onChange={(e) => setExpectedTxs(e.target.value)} size={4} /></label>}
        {gas === 'custom' && <label className="field">SOL / wallet<input value={gasCustom} onChange={(e) => setGasCustom(e.target.value)} size={6} /></label>}
        <label className="field">Priority
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>{['none', 'low', 'medium', 'high'].map((p) => <option key={p}>{p}</option>)}</select>
        </label>
      </div>
      {(kind === 'weighted' || kind === 'percentage') && (
        <textarea rows={3} placeholder={kind === 'weighted' ? 'w002:3, w003:1, …  (label:weight)' : 'w002:50, w003:50  (label:percent, must total 100)'} value={weights} onChange={(e) => setWeights(e.target.value)} />
      )}
      <div className="row">
        <button className="primary" disabled={!recipients.length || status?.mode === 'READ_ONLY'} onClick={preview}>Preview distribution</button>
      </div>
      <ErrorBox error={err} />
      {plan && <PlanPreview plan={plan} wallets={wallets} onDone={onDone} onDiscard={() => setPlan(null)} />}
    </div>
  );
}
