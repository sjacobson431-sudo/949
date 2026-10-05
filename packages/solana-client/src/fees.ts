import {
  BASE_FEE_LAMPORTS,
  PRIORITY_MICROLAMPORTS,
  RENT_EXEMPT_TOKEN_ACCOUNT,
  CU_SWAP,
  type PrioritySettings,
} from '@term/core';

/** Total fee for a tx: base per signature + compute-unit price × limit. */
export function estimateTxFee(opts: { signatures?: number; computeUnits: number; microLamportsPerCu: number }): bigint {
  const base = BASE_FEE_LAMPORTS * BigInt(opts.signatures ?? 1);
  const prio = (BigInt(opts.computeUnits) * BigInt(Math.ceil(opts.microLamportsPerCu)) + 999_999n) / 1_000_000n;
  return base + prio;
}

export function microLamportsFor(p: PrioritySettings, computeUnits: number, dynamicEstimate: number | null = null): number {
  if (p.level === 'custom') {
    const cap = p.maxLamports ?? 0n;
    return computeUnits > 0 ? Number((cap * 1_000_000n) / BigInt(computeUnits)) : 0;
  }
  const fallback = PRIORITY_MICROLAMPORTS[p.level];
  if (p.level === 'none') return 0;
  // With a live estimate, never go below it for the chosen level, but don't exceed 5× the static table.
  if (dynamicEstimate !== null) return Math.min(Math.max(dynamicEstimate, fallback / 10), fallback * 5);
  return fallback;
}

/** Priority fee in lamports for a swap at a given level (what Jupiter's `prioritizationFeeLamports` expects). */
export function priorityLamportsFor(p: PrioritySettings, computeUnits = CU_SWAP, dynamicEstimate: number | null = null): bigint {
  if (p.level === 'custom') return p.maxLamports ?? 0n;
  return (BigInt(computeUnits) * BigInt(Math.ceil(microLamportsFor(p, computeUnits, dynamicEstimate)))) / 1_000_000n;
}

export interface GasReserveInput {
  /** Number of future transactions each wallet is expected to sign (buys + sells + transfers). */
  expectedTxs: number;
  priority: PrioritySettings;
  computeUnitsPerTx?: number;
  /** Token accounts the wallet will need to create (one per new token held). */
  newTokenAccounts?: number;
  /** Extra safety multiplier on fees. */
  safetyMultiplier?: number;
}

/**
 * Lamports a wallet must hold in addition to its trading capital so that it
 * can pay fees, rent for new token accounts and (optionally) WSOL wrapping.
 */
export function estimateGasReserve(i: GasReserveInput): bigint {
  const cu = i.computeUnitsPerTx ?? CU_SWAP;
  const perTx = estimateTxFee({ computeUnits: cu, microLamportsPerCu: microLamportsFor(i.priority, cu) });
  const mult = BigInt(Math.round((i.safetyMultiplier ?? 1.5) * 100));
  const fees = (perTx * BigInt(i.expectedTxs) * mult) / 100n;
  // + temporary WSOL account rent during swaps (refunded on close, but must be available)
  const rent = RENT_EXEMPT_TOKEN_ACCOUNT * BigInt((i.newTokenAccounts ?? 1) + 1);
  return fees + rent;
}
