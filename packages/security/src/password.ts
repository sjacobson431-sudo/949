export interface PasswordCheck {
  ok: boolean;
  /** Rough entropy estimate in bits. */
  bits: number;
  problems: string[];
}

const COMMON = ['password', '123456', 'qwerty', 'letmein', 'solana', 'phantom', 'wallet', 'bitcoin', 'crypto', 'admin'];

/** Minimum bar for a vault password: >= 12 chars and ~60 bits estimated entropy. */
export function checkPasswordStrength(pw: string): PasswordCheck {
  const problems: string[] = [];
  if (pw.length < 12) problems.push('must be at least 12 characters');
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  const unique = new Set(pw).size;
  const bits = Math.round(Math.min(pw.length, unique * 2) * Math.log2(Math.max(pool, 2)));
  if (bits < 60) problems.push('too predictable (estimated entropy < 60 bits); use a longer passphrase');
  const lower = pw.toLowerCase();
  if (COMMON.some((c) => lower.includes(c))) problems.push('contains a common word');
  return { ok: problems.length === 0, bits, problems };
}
