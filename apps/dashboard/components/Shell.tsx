'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useSession } from '@/lib/session';
import type { Mode } from '@/lib/types';
import { LockScreen } from './LockScreen';

const NAV = [
  ['/', 'Dashboard'],
  ['/wallets', 'Wallets'],
  ['/tokens', 'Tokens'],
  ['/trade', 'Trade'],
  ['/positions', 'Positions'],
  ['/transactions', 'Transactions'],
  ['/strategies', 'Strategies'],
  ['/analytics', 'Analytics'],
  ['/settings', 'Settings'],
] as const;

const MODE_TEXT: Record<Mode, string> = {
  LIVE: '● LIVE TRADING — REAL FUNDS — TRANSACTIONS WILL BE SIGNED AND SENT',
  SIMULATION: '◐ SIMULATION — paper fills only, nothing is signed',
  READ_ONLY: '○ READ-ONLY — viewing only',
};

export function Shell({ children }: { children: ReactNode }) {
  const { status, ready, lock, setMode, wsConnected, hasToken } = useSession();
  const path = usePathname();
  const [askLive, setAskLive] = useState(false);
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const mode = status?.mode ?? 'READ_ONLY';

  useEffect(() => {
    document.body.dataset.mode = mode;
  }, [mode]);

  if (!ready) return <div className="lock muted">Connecting to engine…</div>;
  if (!status) {
    return (
      <div className="lock">
        <div className="card">
          <h3>Engine offline</h3>
          <p className="muted">Start the engine API: <code>pnpm api</code> (listens on 127.0.0.1:8787).</p>
        </div>
      </div>
    );
  }
  if (!status.unlocked || !hasToken) return <LockScreen />;

  const change = async (m: Mode) => {
    setErr(null);
    if (m === 'LIVE') return setAskLive(true);
    try {
      await setMode(m);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <>
      <div className={`mode-banner ${mode}`} role="status" aria-live="polite">
        <span>{MODE_TEXT[mode]}</span>
        <span className="spacer" />
        {status.offline && <span>OFFLINE</span>}
        <select value={mode} onChange={(e) => change(e.target.value as Mode)} aria-label="Operating mode">
          <option value="READ_ONLY">READ-ONLY</option>
          <option value="SIMULATION">SIMULATION</option>
          <option value="LIVE" disabled={status.offline}>LIVE</option>
        </select>
        <button onClick={lock}>Lock</button>
      </div>
      {err && <div className="alert error">{err}</div>}
      {askLive && (
        <div className="modal-bg">
          <form
            className="modal grid"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await setMode('LIVE', pw);
                setAskLive(false);
              } catch (x) {
                setErr((x as Error).message);
              } finally {
                setPw('');
              }
            }}
          >
            <h3 style={{ color: 'var(--neg)' }}>Enable LIVE trading</h3>
            <p className="muted">
              Transactions will be signed with your vault keys and broadcast to mainnet. Spending limits and confirmation still apply. Re-enter your vault password.
            </p>
            <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Vault password" autoComplete="current-password" />
            {err && <div className="alert error">{err}</div>}
            <div className="row">
              <button type="submit" className="danger">Enter LIVE mode</button>
              <button type="button" onClick={() => (setAskLive(false), setPw(''), setErr(null))}>Cancel</button>
            </div>
          </form>
        </div>
      )}
      <div className="layout">
        <nav className="sidebar">
          <div className="brand">SOL·TERM</div>
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} className={path === href ? 'active' : ''}>
              {label}
            </Link>
          ))}
          <div className="foot">
            <span>{status.walletCount} wallets</span>
            <span>SOL {status.solUsd ? `$${status.solUsd.toFixed(2)}` : '—'}</span>
            <span>WS {wsConnected ? 'connected' : 'disconnected'}</span>
            {status.rpc.map((r) => (
              <span key={r.label}>
                RPC {r.label}: <span className={r.state === 'closed' ? 'pos' : 'neg'}>{r.state === 'closed' ? 'up' : r.state}</span>
                {r.ewmaLatencyMs ? ` ${Math.round(r.ewmaLatencyMs)}ms` : ''}
              </span>
            ))}
            {status.idleRemainingMs !== null && <span>auto-lock in {Math.ceil(status.idleRemainingMs / 60000)}m</span>}
          </div>
        </nav>
        <main className="main">{children}</main>
      </div>
    </>
  );
}
