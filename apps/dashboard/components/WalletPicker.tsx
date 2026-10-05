'use client';

import { useMemo, useState } from 'react';
import { sol, tokenAmt } from '@/lib/format';
import type { Balance, Wallet } from '@/lib/types';

export function WalletPicker({
  wallets,
  balances,
  selected,
  onChange,
  mint,
  excludePrimary = true,
}: {
  wallets: Wallet[];
  balances?: Balance[];
  selected: string[];
  onChange: (pks: string[]) => void;
  /** Show this token's holdings column. */
  mint?: string;
  excludePrimary?: boolean;
}) {
  const [filter, setFilter] = useState('');
  const [group, setGroup] = useState('');
  const bal = useMemo(() => new Map((balances ?? []).map((b) => [b.publicKey, b])), [balances]);
  const groups = [...new Set(wallets.map((w) => w.groupName).filter(Boolean))] as string[];
  const visible = wallets.filter(
    (w) =>
      (!excludePrimary || !w.isPrimary) &&
      (!group || w.groupName === group) &&
      (!filter || w.label.toLowerCase().includes(filter.toLowerCase()) || w.publicKey.startsWith(filter)),
  );
  const sel = new Set(selected);
  const toggle = (pk: string) => onChange(sel.has(pk) ? selected.filter((x) => x !== pk) : [...selected, pk]);
  const holding = (pk: string) => {
    const t = bal.get(pk)?.tokens.filter((x) => x.mint === mint) ?? [];
    return { raw: t.reduce((s, x) => s + BigInt(x.amountRaw), 0n).toString(), decimals: t[0]?.decimals ?? 0 };
  };

  return (
    <div className="grid" style={{ gap: 8 }}>
      <div className="row">
        <select value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">All groups</option>
          {groups.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
        <input placeholder="filter label / pubkey" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button type="button" onClick={() => onChange([...new Set([...selected, ...visible.map((w) => w.publicKey)])])}>Select shown</button>
        {mint && (
          <button type="button" onClick={() => onChange(visible.filter((w) => holding(w.publicKey).raw !== '0').map((w) => w.publicKey))}>Holders only</button>
        )}
        <button type="button" onClick={() => onChange([])}>None</button>
        <span className="muted">{selected.length} selected</span>
      </div>
      <div className="scroll" style={{ maxHeight: 260 }}>
        <table>
          <thead>
            <tr>
              <th />
              <th>Label</th>
              <th>Group</th>
              <th>Public key</th>
              <th className="num">SOL</th>
              {mint && <th className="num">Holding</th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((w) => {
              const h = mint ? holding(w.publicKey) : null;
              return (
                <tr key={w.publicKey} className={sel.has(w.publicKey) ? 'selected' : ''} onClick={() => toggle(w.publicKey)} style={{ cursor: 'pointer' }}>
                  <td><input type="checkbox" readOnly checked={sel.has(w.publicKey)} /></td>
                  <td>{w.label}</td>
                  <td className="muted">{w.groupName ?? ''}</td>
                  <td className="muted">{w.publicKey.slice(0, 6)}…{w.publicKey.slice(-4)}</td>
                  <td className="num">{bal.get(w.publicKey) ? sol(bal.get(w.publicKey)!.lamports) : '—'}</td>
                  {h && <td className="num">{tokenAmt(h.raw, h.decimals)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
