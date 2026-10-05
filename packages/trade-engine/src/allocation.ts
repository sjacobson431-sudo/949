import {
  MAX_TRANSFERS_PER_TX,
  RENT_EXEMPT_SYSTEM_ACCOUNT,
  TerminalError,
  cryptoRng,
  seededRng,
  sumBig,
  type AllocationConstraints,
  type AllocationSpec,
  type Rng,
} from '@term/core';

/**
 * Split `total` across `keys` according to `spec`. Integer math; any rounding
 * remainder goes to the largest share so the result sums exactly to `total`
 * (except `random`, whose total is the sum of the random draws).
 */
export function splitAmount(total: bigint, keys: string[], spec: AllocationSpec, rng: Rng = cryptoRng): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (!keys.length) return out;
  switch (spec.kind) {
    case 'equal': {
      const each = total / BigInt(keys.length);
      keys.forEach((k) => out.set(k, each));
      break;
    }
    case 'percentage': {
      const sum = keys.reduce((s, k) => s + (spec.pcts[k] ?? 0), 0);
      if (Math.abs(sum - 100) > 0.01) throw new TerminalError('VALIDATION', `percentages sum to ${sum.toFixed(2)}, expected 100`);
      proportional(total, keys, keys.map((k) => spec.pcts[k] ?? 0), out);
      return out;
    }
    case 'weighted': {
      const ws = keys.map((k) => Math.max(0, spec.weights[k] ?? 0));
      const sum = ws.reduce((a, b) => a + b, 0);
      if (sum <= 0) throw new TerminalError('VALIDATION', 'weights must contain at least one positive value');
      proportional(total, keys, ws, out);
      return out;
    }
    case 'random': {
      if (spec.min < 0n || spec.max < spec.min) throw new TerminalError('VALIDATION', 'random range requires 0 <= min <= max');
      const r = spec.seed !== undefined ? seededRng(spec.seed) : rng;
      const span = spec.max - spec.min;
      keys.forEach((k) => out.set(k, spec.min + (span * BigInt(Math.floor(r.next() * 1e9))) / 1_000_000_000n));
      return out; // total is the sum of draws
    }
  }
  // assign rounding dust to the largest share
  const diff = total - sumBig(out.values());
  if (diff !== 0n) {
    let maxK = keys[0]!;
    for (const k of keys) if ((out.get(k) ?? 0n) > (out.get(maxK) ?? 0n)) maxK = k;
    out.set(maxK, (out.get(maxK) ?? 0n) + diff);
  }
  return out;
}

/** Largest-remainder apportionment: exact sum, each share within 1 unit of its ideal. */
function proportional(total: bigint, keys: string[], weights: number[], out: Map<string, bigint>): void {
  const scaled = weights.map((w) => BigInt(Math.round(Math.max(0, w) * 1e9)));
  const sum = scaled.reduce((a, b) => a + b, 0n);
  if (sum === 0n) throw new TerminalError('VALIDATION', 'weights must contain at least one positive value');
  const floors = scaled.map((w) => (total * w) / sum);
  const rems = scaled.map((w, i) => ({ i, r: (total * w) % sum }));
  let left = total - floors.reduce((a, b) => a + b, 0n);
  rems.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (const { i } of rems) {
    if (left <= 0n) break;
    floors[i]!++;
    left--;
  }
  keys.forEach((k, i) => out.set(k, floors[i]!));
}

export interface DistributionInput {
  source: { publicKey: string; lamports: bigint };
  recipients: { publicKey: string; lamports: bigint }[];
  /** Trading capital to distribute (ignored for `random`). */
  total: bigint;
  spec: AllocationSpec;
  constraints?: AllocationConstraints;
  /** Added on top of each recipient's allocation so it can pay for its own trades. */
  gasReservePerWallet?: bigint;
  /** Fee for one batched transfer tx. */
  feePerTx: bigint;
  rng?: Rng;
}

export interface DistributionTransfer {
  to: string;
  lamports: bigint;
  currentLamports: bigint;
  postLamports: bigint;
  batch: number;
  notes: string[];
}

export interface DistributionPlanResult {
  transfers: DistributionTransfer[];
  txCount: number;
  totalLamports: bigint;
  totalFees: bigint;
  sourceRemaining: bigint;
  warnings: string[];
  /** Hard problems: the plan must not execute. */
  problems: string[];
}

/** Capital-allocation engine for primary → wallets SOL distribution. */
export function planDistribution(i: DistributionInput): DistributionPlanResult {
  const warnings: string[] = [];
  const problems: string[] = [];
  const c = i.constraints ?? {};
  const gas = i.gasReservePerWallet ?? 0n;
  const recipients = i.recipients.filter((r) => r.publicKey !== i.source.publicKey);
  if (recipients.length !== i.recipients.length) warnings.push('source wallet excluded from recipients');
  if (c.minWalletBalance !== undefined && c.maxWalletBalance !== undefined && c.minWalletBalance > c.maxWalletBalance) {
    problems.push('min wallet balance exceeds max wallet balance');
  }

  const shares = splitAmount(i.total, recipients.map((r) => r.publicKey), i.spec, i.rng);
  const transfers: DistributionTransfer[] = [];
  for (const r of recipients) {
    const notes: string[] = [];
    let amt = (shares.get(r.publicKey) ?? 0n) + gas;
    if (c.minWalletBalance !== undefined && r.lamports + amt < c.minWalletBalance) {
      amt = c.minWalletBalance - r.lamports;
      notes.push('raised to min balance');
    }
    if (c.maxWalletBalance !== undefined && r.lamports + amt > c.maxWalletBalance) {
      amt = c.maxWalletBalance > r.lamports ? c.maxWalletBalance - r.lamports : 0n;
      notes.push('capped at max balance');
    }
    if (amt > 0n && r.lamports === 0n && amt < RENT_EXEMPT_SYSTEM_ACCOUNT) {
      amt = RENT_EXEMPT_SYSTEM_ACCOUNT;
      notes.push('raised to rent-exempt minimum for a new account');
    }
    if (amt <= 0n) continue;
    transfers.push({ to: r.publicKey, lamports: amt, currentLamports: r.lamports, postLamports: r.lamports + amt, batch: 0, notes });
  }
  transfers.forEach((t, idx) => (t.batch = Math.floor(idx / MAX_TRANSFERS_PER_TX)));
  const txCount = transfers.length ? transfers[transfers.length - 1]!.batch + 1 : 0;
  const totalLamports = sumBig(transfers.map((t) => t.lamports));
  const totalFees = i.feePerTx * BigInt(txCount);
  const sourceRemaining = i.source.lamports - totalLamports - totalFees;
  const reserve = c.sourceReserve ?? RENT_EXEMPT_SYSTEM_ACCOUNT;
  if (sourceRemaining < reserve) {
    problems.push(
      `source would be left with ${sourceRemaining} lamports, below the required reserve of ${reserve} (need ${reserve - sourceRemaining} more)`,
    );
  }
  if (!transfers.length) warnings.push('nothing to transfer: all recipients already satisfy the constraints');
  return { transfers, txCount, totalLamports, totalFees, sourceRemaining, warnings, problems };
}
