import {
  CU_SOL_TRANSFER,
  CU_TOKEN_TRANSFER,
  formatSol,
  RENT_EXEMPT_SYSTEM_ACCOUNT,
  RENT_EXEMPT_TOKEN_ACCOUNT,
  WSOL_MINT,
  type PlannedTx,
  type WalletBalance,
} from '@term/core';
import { estimateTxFee } from '@term/solana-client';

export interface ConsolidationInput {
  balances: WalletBalance[];
  /** Receives SOL. */
  solDestination: string;
  /** Receives SPL tokens (defaults to solDestination). */
  tokenDestination?: string;
  includeSol: boolean;
  /** true = all tokens, array = only these mints, false = none. */
  tokens: boolean | string[];
  closeEmptyAccounts: boolean;
  /** SOL left behind in each source wallet. */
  solReserve: bigint;
  microLamportsPerCu: number;
  /** Mints for which the token destination already has a token account. */
  destinationHasAccount?: Set<string>;
  labelOf?: (pk: string) => string;
}

export interface WalletConsolidation {
  wallet: string;
  startLamports: bigint;
  tokensMoved: { mint: string; amountRaw: bigint }[];
  accountsClosed: number;
  rentReclaimed: bigint;
  rentPaid: bigint;
  fees: bigint;
  sweepLamports: bigint;
  remainingLamports: bigint;
}

export interface ConsolidationPlanResult {
  legs: PlannedTx[];
  wallets: WalletConsolidation[];
  expectedSolReceived: bigint;
  totalFees: bigint;
  totalRentReclaimed: bigint;
  warnings: string[];
}

const CLOSES_PER_TX = 20;

/**
 * Plans: per source wallet, (1) move tokens to the token destination and
 * close the emptied accounts, (2) close already-empty accounts and unwrap
 * WSOL, (3) sweep remaining SOL minus fees and reserve. Legs for one wallet
 * execute sequentially, so the sweep sees the reclaimed rent.
 */
export function planConsolidation(i: ConsolidationInput): ConsolidationPlanResult {
  const warnings: string[] = [];
  const legs: PlannedTx[] = [];
  const tokenDest = i.tokenDestination ?? i.solDestination;
  const label = i.labelOf ?? ((pk: string) => `${pk.slice(0, 4)}…${pk.slice(-4)}`);
  let reserve = i.solReserve;
  if (reserve > 0n && reserve < RENT_EXEMPT_SYSTEM_ACCOUNT) {
    warnings.push(`reserve raised to rent-exempt minimum ${formatSol(RENT_EXEMPT_SYSTEM_ACCOUNT)} SOL (a non-zero balance below it is invalid)`);
    reserve = RENT_EXEMPT_SYSTEM_ACCOUNT;
  }
  const destHas = new Set(i.destinationHasAccount ?? []);
  const wantMint = (m: string) => (i.tokens === true ? true : i.tokens === false ? false : i.tokens.includes(m));
  const tokenFee = estimateTxFee({ computeUnits: CU_TOKEN_TRANSFER + 5_000, microLamportsPerCu: i.microLamportsPerCu });
  const sweepFee = estimateTxFee({ computeUnits: 300 + CU_SOL_TRANSFER, microLamportsPerCu: i.microLamportsPerCu });
  const out: WalletConsolidation[] = [];
  let n = 0;
  const id = () => `t${String(n++).padStart(4, '0')}`;

  for (const b of i.balances) {
    const w: WalletConsolidation = {
      wallet: b.publicKey, startLamports: b.lamports, tokensMoved: [], accountsClosed: 0, rentReclaimed: 0n, rentPaid: 0n, fees: 0n, sweepLamports: 0n, remainingLamports: b.lamports,
    };
    let lamports = b.lamports;

    if (b.publicKey !== tokenDest) {
      for (const t of b.tokens) {
        if (t.mint === WSOL_MINT || t.amountRaw === 0n || !wantMint(t.mint)) continue;
        const ataRent = destHas.has(t.mint) ? 0n : RENT_EXEMPT_TOKEN_ACCOUNT;
        destHas.add(t.mint);
        legs.push({
          legId: id(), kind: 'TOKEN_TRANSFER', wallet: b.publicKey, offsetMs: 0, mint: t.mint,
          description: `Move ${t.amountRaw} raw ${t.mint.slice(0, 6)}… → ${label(tokenDest)} and close source account`,
          lamportsDelta: ataRent - RENT_EXEMPT_TOKEN_ACCOUNT, tokenDelta: -t.amountRaw, estFeeLamports: tokenFee, destination: tokenDest,
          details: { programId: t.programId, decimals: t.decimals, sourceTokenAccount: t.tokenAccount, closeSource: true },
        });
        lamports += RENT_EXEMPT_TOKEN_ACCOUNT - ataRent - tokenFee;
        w.tokensMoved.push({ mint: t.mint, amountRaw: t.amountRaw });
        w.accountsClosed++;
        w.rentReclaimed += RENT_EXEMPT_TOKEN_ACCOUNT;
        w.rentPaid += ataRent;
        w.fees += tokenFee;
      }
    }

    if (i.closeEmptyAccounts) {
      // Empty accounts, plus WSOL accounts (closing unwraps their SOL).
      const closable = b.tokens.filter((t) => t.amountRaw === 0n || t.mint === WSOL_MINT);
      for (let k = 0; k < closable.length; k += CLOSES_PER_TX) {
        const chunk = closable.slice(k, k + CLOSES_PER_TX);
        const reclaim = chunk.reduce((s, t) => s + RENT_EXEMPT_TOKEN_ACCOUNT + (t.mint === WSOL_MINT ? t.amountRaw : 0n), 0n);
        const fee = estimateTxFee({ computeUnits: 1_000 + 3_500 * chunk.length, microLamportsPerCu: i.microLamportsPerCu });
        legs.push({
          legId: id(), kind: 'CLOSE_ACCOUNT', wallet: b.publicKey, offsetMs: 0,
          description: `Close ${chunk.length} token account(s), reclaim ~${formatSol(reclaim)} SOL`,
          lamportsDelta: -reclaim, estFeeLamports: fee,
          details: { accounts: chunk.map((t) => ({ tokenAccount: t.tokenAccount, programId: t.programId, mint: t.mint })) },
        });
        lamports += reclaim - fee;
        w.accountsClosed += chunk.length;
        w.rentReclaimed += reclaim;
        w.fees += fee;
      }
    }

    if (i.includeSol && b.publicKey !== i.solDestination) {
      const sweep = lamports - sweepFee - reserve;
      if (sweep > 0n) {
        legs.push({
          legId: id(), kind: 'SOL_TRANSFER', wallet: b.publicKey, offsetMs: 0,
          description: `Sweep ~${formatSol(sweep)} SOL → ${label(i.solDestination)} (leave ${formatSol(reserve)})`,
          lamportsDelta: sweep, estFeeLamports: sweepFee, destination: i.solDestination,
          details: { sweepReserve: reserve },
        });
        w.sweepLamports = sweep;
        w.fees += sweepFee;
        lamports -= sweep + sweepFee;
      } else if (lamports > reserve) {
        warnings.push(`${label(b.publicKey)}: balance too small to sweep after fees`);
      }
    }
    w.remainingLamports = lamports;
    if (w.tokensMoved.length || w.accountsClosed || w.sweepLamports) out.push(w);
  }

  return {
    legs,
    wallets: out,
    expectedSolReceived: out.reduce((s, w) => s + w.sweepLamports, 0n),
    totalFees: out.reduce((s, w) => s + w.fees, 0n),
    totalRentReclaimed: out.reduce((s, w) => s + w.rentReclaimed, 0n),
    warnings,
  };
}

/** Equalise a token's holdings across wallets via transfers (largest surplus → largest deficit). */
export function planTokenRebalance(
  holdings: { wallet: string; raw: bigint; tokenAccount: string; programId: string; decimals: number }[],
  mint: string,
  microLamportsPerCu: number,
): PlannedTx[] {
  if (holdings.length < 2) return [];
  const total = holdings.reduce((s, h) => s + h.raw, 0n);
  const target = total / BigInt(holdings.length);
  const surplus = holdings.filter((h) => h.raw > target).map((h) => ({ ...h, extra: h.raw - target })).sort((a, b) => (b.extra > a.extra ? 1 : -1));
  const deficit = holdings.filter((h) => h.raw < target).map((h) => ({ ...h, need: target - h.raw })).sort((a, b) => (b.need > a.need ? 1 : -1));
  const fee = estimateTxFee({ computeUnits: CU_TOKEN_TRANSFER, microLamportsPerCu });
  const legs: PlannedTx[] = [];
  let n = 0;
  for (const s of surplus) {
    for (const d of deficit) {
      if (s.extra <= 0n) break;
      if (d.need <= 0n) continue;
      const amt = s.extra < d.need ? s.extra : d.need;
      // ignore dust moves (< 0.1% of target)
      if (target > 0n && amt * 1000n < target) continue;
      legs.push({
        legId: `t${String(n++).padStart(4, '0')}`, kind: 'TOKEN_TRANSFER', wallet: s.wallet, offsetMs: 0, mint,
        description: `Rebalance: move ${amt} raw → ${d.wallet.slice(0, 4)}…`,
        lamportsDelta: RENT_EXEMPT_TOKEN_ACCOUNT, tokenDelta: -amt, estFeeLamports: fee, destination: d.wallet,
        details: { programId: s.programId, decimals: s.decimals, sourceTokenAccount: s.tokenAccount, closeSource: false },
      });
      s.extra -= amt;
      d.need -= amt;
    }
  }
  return legs;
}
