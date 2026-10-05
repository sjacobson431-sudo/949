export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Parse a decimal SOL string/number into lamports without float rounding surprises. */
export function solToLamports(sol: string | number): bigint {
  return decimalToRaw(typeof sol === 'number' ? sol.toFixed(9) : sol, 9);
}

export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / 1e9;
}

export function formatSol(lamports: bigint, digits = 4): string {
  return rawToDecimalString(lamports, 9, digits);
}

/** "12.5" with 6 decimals -> 12500000n. Truncates extra precision. */
export function decimalToRaw(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '' || s === '-' || s === '.') {
    throw new Error(`Invalid decimal amount: "${value}"`);
  }
  const negative = s.startsWith('-');
  const [intPart = '0', fracPart = ''] = (negative ? s.slice(1) : s).split('.');
  const frac = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  const raw = BigInt(intPart || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0');
  return negative ? -raw : raw;
}

export function rawToDecimalString(raw: bigint, decimals: number, maxFractionDigits = decimals): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const int = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, Math.max(0, maxFractionDigits));
  frac = frac.replace(/0+$/, '');
  return `${negative ? '-' : ''}${int.toString()}${frac ? '.' + frac : ''}`;
}

export function rawToUi(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** Multiply a bigint by a percentage (0-100, float) rounding down. */
export function pctOf(amount: bigint, pct: number): bigint {
  if (pct <= 0) return 0n;
  if (pct >= 100) return amount;
  // 1e6 precision on the percentage
  return (amount * BigInt(Math.round(pct * 1_000_000))) / 100_000_000n;
}

export function bpsOf(amount: bigint, bps: number): bigint {
  return (amount * BigInt(Math.round(bps))) / 10_000n;
}

export function minBig(...xs: bigint[]): bigint {
  return xs.reduce((a, b) => (b < a ? b : a));
}

export function maxBig(...xs: bigint[]): bigint {
  return xs.reduce((a, b) => (b > a ? b : a));
}

export function sumBig(xs: Iterable<bigint>): bigint {
  let t = 0n;
  for (const x of xs) t += x;
  return t;
}

export function clampBig(x: bigint, lo: bigint, hi: bigint): bigint {
  return x < lo ? lo : x > hi ? hi : x;
}
