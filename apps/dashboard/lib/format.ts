export function lamportsToSol(l: string | null | undefined): number {
  return l == null ? 0 : Number(l) / 1e9;
}

export function sol(l: string | null | undefined, digits = 4): string {
  if (l == null) return '—';
  const v = lamportsToSol(l);
  return v.toLocaleString('en-US', { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits });
}

export function signedSol(l: string | null | undefined, digits = 4): string {
  if (l == null) return '—';
  const v = lamportsToSol(l);
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: digits })}`;
}

export function usd(v: number | null | undefined): string {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(a < 1 ? 6 : 2)}`;
}

export function tokenAmt(raw: string | null | undefined, decimals: number): string {
  if (raw == null) return '—';
  const v = Number(raw) / 10 ** decimals;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export function price(v: number | null | undefined): string {
  if (v == null) return '—';
  if (v === 0) return '0';
  return v < 0.0001 ? v.toExponential(3) : v.toPrecision(5);
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function short(pk: string | null | undefined): string {
  if (!pk) return '—';
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const m = ms / 60000;
  if (m < 60) return `${m.toFixed(1)}m`;
  if (m < 1440) return `${(m / 60).toFixed(1)}h`;
  return `${(m / 1440).toFixed(1)}d`;
}

/** "1.5" SOL → lamports string (no float error). */
export function solToLamports(s: string): string {
  const t = s.trim();
  if (!/^\d*(\.\d*)?$/.test(t) || t === '' || t === '.') throw new Error(`Invalid SOL amount "${s}"`);
  const [i = '0', f = ''] = t.split('.');
  return (BigInt(i || '0') * 1_000_000_000n + BigInt((f + '000000000').slice(0, 9))).toString();
}

export const pnlClass = (l: string | number | null | undefined) => {
  const v = typeof l === 'number' ? l : l == null ? 0 : Number(l);
  return v > 0 ? 'pos' : v < 0 ? 'neg' : '';
};
