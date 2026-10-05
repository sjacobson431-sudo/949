'use client';

import { useState } from 'react';
import { ErrorBox } from '@/components/ui';
import { del, post, put } from '@/lib/api';
import { sol, solToLamports } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Security {
  limits: { perTxLamports: string; perWalletDailyLamports: string; globalDailyLamports: string };
  whitelistEnabled: boolean; requireConfirmation: boolean; idleLockMinutes: number; maxSessionHours: number; selfTradeCooldownSec: number; planTtlSec: number;
}

export default function SettingsPage() {
  const { status } = useSession();
  const sec = useApi<Security>('/api/settings/security');
  const wl = useApi<{ address: string; label: string; createdAt: number }[]>('/api/whitelist');
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [addr, setAddr] = useState('');
  const [addrLabel, setAddrLabel] = useState('');
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setErr(null);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await Promise.all([sec.reload(), wl.reload()]);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const s = sec.data;
  const f = (k: string, fallback: string) => form[k] ?? fallback;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Settings</h1>
      <ErrorBox error={err} />
      {msg && <div className="alert info">{msg}</div>}
      {s && (
        <div className="grid g2">
          <div className="card grid" style={{ gap: 8 }}>
            <h2>Spending limits (LIVE)</h2>
            <label className="field">Max SOL per transaction<input value={f('perTx', sol(s.limits.perTxLamports, 9))} onChange={set('perTx')} /></label>
            <label className="field">Max SOL per wallet per 24h<input value={f('perWallet', sol(s.limits.perWalletDailyLamports, 9))} onChange={set('perWallet')} /></label>
            <label className="field">Max SOL all wallets per 24h (external outflows)<input value={f('global', sol(s.limits.globalDailyLamports, 9))} onChange={set('global')} /></label>
            <button
              onClick={() =>
                run(
                  () =>
                    put('/api/settings/security', {
                      limits: {
                        perTxLamports: solToLamports(f('perTx', sol(s.limits.perTxLamports, 9)).replace(/,/g, '')),
                        perWalletDailyLamports: solToLamports(f('perWallet', sol(s.limits.perWalletDailyLamports, 9)).replace(/,/g, '')),
                        globalDailyLamports: solToLamports(f('global', sol(s.limits.globalDailyLamports, 9)).replace(/,/g, '')),
                      },
                    }),
                  'Limits saved',
                )
              }
            >Save limits</button>
          </div>
          <div className="card grid" style={{ gap: 8 }}>
            <h2>Session & safety</h2>
            <label className="field">Auto-lock after idle (minutes)<input value={f('idle', String(s.idleLockMinutes))} onChange={set('idle')} /></label>
            <label className="field">Max session length (hours)<input value={f('maxS', String(s.maxSessionHours))} onChange={set('maxS')} /></label>
            <label className="field">Plan expiry (seconds)<input value={f('ttl', String(s.planTtlSec))} onChange={set('ttl')} /></label>
            <label className="field">Self-trade guard cooldown (seconds)<input value={f('stg', String(s.selfTradeCooldownSec))} onChange={set('stg')} /></label>
            <label className="row"><input type="checkbox" checked={s.whitelistEnabled} onChange={(e) => run(() => put('/api/settings/security', { whitelistEnabled: e.target.checked }), 'Saved')} /> Restrict transfers to vault wallets + whitelist</label>
            <button
              onClick={() =>
                run(
                  () =>
                    put('/api/settings/security', {
                      idleLockMinutes: Number(f('idle', String(s.idleLockMinutes))),
                      maxSessionHours: Number(f('maxS', String(s.maxSessionHours))),
                      planTtlSec: Number(f('ttl', String(s.planTtlSec))),
                      selfTradeCooldownSec: Number(f('stg', String(s.selfTradeCooldownSec))),
                    }),
                  'Saved',
                )
              }
            >Save</button>
          </div>
        </div>
      )}
      <div className="grid g2">
        <div className="card grid" style={{ gap: 8 }}>
          <h2>Destination whitelist</h2>
          <div className="row">
            <input placeholder="address" value={addr} onChange={(e) => setAddr(e.target.value)} style={{ flex: 1 }} />
            <input placeholder="label" value={addrLabel} onChange={(e) => setAddrLabel(e.target.value)} size={12} />
            <button onClick={() => run(() => post('/api/whitelist', { address: addr.trim(), label: addrLabel || 'external' }), 'Whitelisted')}>Add</button>
          </div>
          <table>
            <tbody>
              {(wl.data ?? []).map((w) => (
                <tr key={w.address}><td>{w.label}</td><td className="mono">{w.address}</td><td><button className="ghost" onClick={() => run(() => del(`/api/whitelist/${w.address}`), 'Removed')}>Remove</button></td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card grid" style={{ gap: 8 }}>
          <h2>Vault password</h2>
          <input type="password" placeholder="current password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoComplete="current-password" />
          <input type="password" placeholder="new password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
          <button onClick={() => run(async () => { await post('/api/vault/password', { oldPassword: oldPw, newPassword: newPw }); setOldPw(''); setNewPw(''); }, 'Password changed; all keys re-encrypted')}>Change password</button>
          <h2 style={{ marginTop: 12 }}>RPC endpoints</h2>
          <table>
            <thead><tr><th>Label</th><th>URL</th><th>State</th><th className="num">Latency</th><th>Last error</th></tr></thead>
            <tbody>
              {(status?.rpc ?? []).map((r) => (
                <tr key={r.label}><td>{r.label}</td><td className="muted">{r.url}</td><td><span className={`badge ${r.state === 'closed' ? 'ok' : 'critical'}`}>{r.state === 'closed' ? 'healthy' : r.state}</span></td><td className="num">{r.ewmaLatencyMs ? `${Math.round(r.ewmaLatencyMs)}ms` : '—'}</td><td className="muted">{r.lastError ?? ''}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Configure endpoints with TERM_RPC_URLS (comma-separated; first is primary).</p>
        </div>
      </div>
    </div>
  );
}
