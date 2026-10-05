import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { CU_SOL_TRANSFER, CU_TOKEN_TRANSFER, MAX_TRANSFERS_PER_TX } from '@term/core';
import { estimateTxFee } from './fees';

export interface BuiltTx {
  tx: VersionedTransaction;
  computeUnits: number;
  microLamportsPerCu: number;
  estFeeLamports: bigint;
}

function computeBudget(units: number, microLamports: number): TransactionInstruction[] {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (microLamports > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.ceil(microLamports) }));
  return ixs;
}

function compile(payer: string, blockhash: string, ixs: TransactionInstruction[]): VersionedTransaction {
  const msg = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  return new VersionedTransaction(msg);
}

/** One tx paying many destinations from a single wallet (≤ MAX_TRANSFERS_PER_TX). */
export function buildSolTransfers(p: {
  from: string;
  transfers: { to: string; lamports: bigint }[];
  blockhash: string;
  microLamportsPerCu: number;
}): BuiltTx {
  if (p.transfers.length === 0 || p.transfers.length > MAX_TRANSFERS_PER_TX) {
    throw new Error(`transfers per tx must be 1..${MAX_TRANSFERS_PER_TX}`);
  }
  const cu = 300 + CU_SOL_TRANSFER * p.transfers.length;
  const ixs = [
    ...computeBudget(cu, p.microLamportsPerCu),
    ...p.transfers.map((t) =>
      SystemProgram.transfer({ fromPubkey: new PublicKey(p.from), toPubkey: new PublicKey(t.to), lamports: t.lamports }),
    ),
  ];
  return {
    tx: compile(p.from, p.blockhash, ixs),
    computeUnits: cu,
    microLamportsPerCu: p.microLamportsPerCu,
    estFeeLamports: estimateTxFee({ computeUnits: cu, microLamportsPerCu: p.microLamportsPerCu }),
  };
}

/** SPL transfer (creating the destination ATA idempotently), optionally closing the emptied source. */
export function buildTokenTransfer(p: {
  owner: string;
  mint: string;
  programId: string;
  decimals: number;
  sourceTokenAccount: string;
  amount: bigint;
  destinationOwner: string;
  closeSourceAfter: boolean;
  blockhash: string;
  microLamportsPerCu: number;
}): BuiltTx & { destinationAta: string } {
  const owner = new PublicKey(p.owner);
  const mint = new PublicKey(p.mint);
  const prog = new PublicKey(p.programId);
  const destOwner = new PublicKey(p.destinationOwner);
  const destAta = getAssociatedTokenAddressSync(mint, destOwner, true, prog);
  const cu = CU_TOKEN_TRANSFER + (p.closeSourceAfter ? 5_000 : 0);
  const ixs = [
    ...computeBudget(cu, p.microLamportsPerCu),
    createAssociatedTokenAccountIdempotentInstruction(owner, destAta, destOwner, mint, prog),
    createTransferCheckedInstruction(new PublicKey(p.sourceTokenAccount), mint, destAta, owner, p.amount, p.decimals, [], prog),
  ];
  if (p.closeSourceAfter) ixs.push(createCloseAccountInstruction(new PublicKey(p.sourceTokenAccount), owner, owner, [], prog));
  return {
    tx: compile(p.owner, p.blockhash, ixs),
    computeUnits: cu,
    microLamportsPerCu: p.microLamportsPerCu,
    estFeeLamports: estimateTxFee({ computeUnits: cu, microLamportsPerCu: p.microLamportsPerCu }),
    destinationAta: destAta.toBase58(),
  };
}

/** Close empty token accounts, reclaiming rent to the owner. */
export function buildCloseAccounts(p: {
  owner: string;
  accounts: { tokenAccount: string; programId: string }[];
  blockhash: string;
  microLamportsPerCu: number;
}): BuiltTx {
  const owner = new PublicKey(p.owner);
  const cu = 1_000 + 3_500 * p.accounts.length;
  const ixs = [
    ...computeBudget(cu, p.microLamportsPerCu),
    ...p.accounts.map((a) => createCloseAccountInstruction(new PublicKey(a.tokenAccount), owner, owner, [], new PublicKey(a.programId))),
  ];
  return {
    tx: compile(p.owner, p.blockhash, ixs),
    computeUnits: cu,
    microLamportsPerCu: p.microLamportsPerCu,
    estFeeLamports: estimateTxFee({ computeUnits: cu, microLamportsPerCu: p.microLamportsPerCu }),
  };
}

export function associatedTokenAddress(mint: string, owner: string, programId: string): string {
  return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, new PublicKey(programId)).toBase58();
}
