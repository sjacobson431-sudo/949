import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '@term/core';
import { associatedTokenAddress } from './tx-builder';

export interface InspectionResult {
  ok: boolean;
  problems: string[];
}

/**
 * Safety check for transactions built by third parties (e.g. Jupiter /swap).
 * Refuses to sign when:
 *  - the fee payer is not the expected wallet;
 *  - the wallet must sign but isn't the only required signer;
 *  - a top-level System transfer sends SOL anywhere other than the wallet
 *    itself or its own WSOL accounts;
 *  - a top-level SPL Transfer/TransferChecked moves tokens out of the wallet
 *    to an account that isn't allowed (swaps move tokens via CPI only).
 */
export function inspectThirdPartyTx(
  tx: VersionedTransaction,
  accountKeys: string[],
  wallet: string,
  extraAllowedDestinations: string[] = [],
): InspectionResult {
  const problems: string[] = [];
  const msg = tx.message;
  const payer = msg.staticAccountKeys[0]?.toBase58();
  if (payer !== wallet) problems.push(`fee payer ${payer} is not the signing wallet ${wallet}`);
  if (msg.header.numRequiredSignatures !== 1) problems.push(`tx requires ${msg.header.numRequiredSignatures} signatures (expected 1)`);

  const allowed = new Set<string>([
    wallet,
    associatedTokenAddress(WSOL_MINT, wallet, TOKEN_PROGRAM_ID),
    associatedTokenAddress(WSOL_MINT, wallet, TOKEN_2022_PROGRAM_ID),
    ...extraAllowedDestinations,
  ]);

  for (const ix of msg.compiledInstructions) {
    const program = accountKeys[ix.programIdIndex];
    const data = Buffer.from(ix.data);
    if (program === SYSTEM_PROGRAM_ID) {
      const kind = data.length >= 4 ? data.readUInt32LE(0) : -1;
      // 2 = Transfer, 11 = TransferWithSeed
      if (kind === 2 || kind === 11) {
        const to = accountKeys[ix.accountKeyIndexes[kind === 2 ? 1 : 2]!];
        if (!to || !allowed.has(to)) problems.push(`unexpected SOL transfer to ${to}`);
      }
      // 0 = CreateAccount: funding a new account with more than ~rent is a drain vector
      if (kind === 0 && data.length >= 12 && data.readBigUInt64LE(4) > 10_000_000n) {
        problems.push(`CreateAccount funds a new account with ${data.readBigUInt64LE(4)} lamports`);
      }
      // 1 = Assign, 10 = AssignWithSeed: changing the wallet's owner program would hijack it
      if (kind === 1 || kind === 10) {
        const target = accountKeys[ix.accountKeyIndexes[0]!];
        if (target === wallet) problems.push('instruction re-assigns the wallet account owner');
      }
    } else if (program === TOKEN_PROGRAM_ID || program === TOKEN_2022_PROGRAM_ID) {
      const tag = data[0];
      // 3 = Transfer, 12 = TransferChecked
      if (tag === 3 || tag === 12) {
        const dest = accountKeys[ix.accountKeyIndexes[tag === 3 ? 1 : 2]!];
        if (!dest || !allowed.has(dest)) problems.push(`unexpected top-level token transfer to ${dest}`);
      }
      // 6 = SetAuthority on an account the wallet owns
      if (tag === 6) problems.push('instruction changes a token account authority');
      // 4 = Approve, 13 = ApproveChecked: delegating spending rights
      if (tag === 4 || tag === 13) problems.push('instruction approves a token delegate');
    }
  }
  return { ok: problems.length === 0, problems };
}

export function isValidPublicKey(s: string): boolean {
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}
