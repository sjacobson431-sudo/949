'use client';

import { useEffect, useState } from 'react';
import { ErrorBox } from '@/components/ui';
import { signedSol, short, sol, tokenAmt } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Audit, Wallet } from '@/lib/types';

export default function TransactionsPage() {
  const { subscribe } = useSession();
  const [wallet, setWallet] = useState('');
  const [mint, setMint] = useState('');
  const [mode, setMode] = useState('');
  const [offset, setOffset] = useState(0);
  const q = new URLSearchParams({ limit: '200', offset: String(offset), ...(wallet && { wallet }), ...(mint && { mint }), ...(mode && { mode }) });
  const audit = useApi<Audit[]>(`/api/transactions?${q}`, [q.toString()]);
  const wallets = useApi<Wallet[]>('/api/wallets?archived=1');
  const plans = useApi<{ id: string; kind: string; mode: string; status: string; title: string; createdAt: number }[]>('/api/plans');
  const label = new Map((wallets.data ?? []).map((w) => [w.publicKey, w.label]));

  useEffect(() => subscribe((m) => {
    if (m.type === 'leg' || m.type === 'plan') {
      void audit.reload();
      void plans.reload();
    }
  }), [subscribe, audit, plans]);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Transactions</h1>
      <div className="card">
        <h2>Plans</h2>
        <div className="scroll" style={{ maxHeight: 220 }}>
          <table>
            <thead><tr><th>Created</th><th>Kind</th><th>Mode</th><th>Status</th><th>Title</th></tr></thead>
            <tbody>
              {(plans.data ?? []).map((p) => (
                <tr key={p.id}><td>{new Date(p.createdAt).toLocaleString()}</td><td>{p.kind}</td><td>{p.mode}</td><td><span className={`badge ${p.status}`}>{p.status}</span></td><td>{p.title}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card grid" style={{ gap: 10 }}>
        <div className="row">
          <h2 style={{ margin: 0 }}>Audit trail</h2>
          <select value={wallet} onChange={(e) => (setWallet(e.target.value), setOffset(0))}>
            <option value="">All wallets</option>
            {(wallets.data ?? []).map((w) => <option key={w.publicKey} value={w.publicKey}>{w.label}</option>)}
          </select>
          <input placeholder="mint filter" value={mint} onChange={(e) => (setMint(e.target.value.trim()), setOffset(0))} />
          <select value={mode} onChange={(e) => (setMode(e.target.value), setOffset(0))}>
            <option value="">All modes</option><option value="LIVE">LIVE</option><option value="SIMULATION">SIMULATION</option>
          </select>
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 200))}>‹ Newer</button>
          <button disabled={(audit.data?.length ?? 0) < 200} onClick={() => setOffset(offset + 200)}>Older ›</button>
        </div>
        <ErrorBox error={audit.error} />
        <div className="scroll" style={{ maxHeight: 640 }}>
          <table>
            <thead><tr><th>Time</th><th>Mode</th><th>Kind</th><th>Status</th><th>Wallet</th><th>Description</th><th className="num">SOL Δ</th><th className="num">Token Δ</th><th className="num">Fee</th><th>Signature</th><th>Error</th></tr></thead>
            <tbody>
              {(audit.data ?? []).map((a) => (
                <tr key={a.id}>
                  <td>{new Date(a.createdAt).toLocaleString()}</td>
                  <td><span className={`badge ${a.mode === 'LIVE' ? 'critical' : 'warn'}`}>{a.mode}</span></td>
                  <td>{a.kind}{a.side ? ` ${a.side}` : ''}</td>
                  <td><span className={`badge ${a.status}`}>{a.status}</span></td>
                  <td>{label.get(a.wallet) ?? short(a.wallet)}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 240 }}>{a.details.description ?? ''}</td>
                  <td className="num">{signedSol(String(-BigInt(a.lamportsDelta)))}</td>
                  <td className="num">{a.tokenDelta ? tokenAmt(a.tokenDelta, a.details.decimals ?? 0) : ''}</td>
                  <td className="num">{a.feeLamports ? sol(a.feeLamports, 6) : ''}</td>
                  <td>{a.signature ? <a href={`https://solscan.io/tx/${a.signature}`} target="_blank" rel="noreferrer noopener">{a.signature.slice(0, 10)}…</a> : ''}</td>
                  <td className="neg" style={{ whiteSpace: 'normal' }}>{a.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
