import bs58 from 'bs58';
import {
  AddressLookupTableAccount,
  PublicKey,
  VersionedTransaction,
  type AccountInfo,
  type ParsedAccountData,
} from '@solana/web3.js';
import {
  errorMessage,
  silentLogger,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type HolderInfo,
  type Logger,
  type MintInfo,
  type SimulationResult,
  type TokenBalance,
  type WalletBalance,
} from '@term/core';
import { RpcPool } from './rpc-pool';

export interface SendResult {
  signature: string;
  status: 'CONFIRMED' | 'FAILED' | 'EXPIRED';
  error: string | null;
  slot: number | null;
  feeLamports: bigint | null;
}

export interface SendOptions {
  lastValidBlockHeight: number;
  /** Skip RPC preflight (we simulate ourselves beforehand). */
  skipPreflight?: boolean;
  rebroadcastMs?: number;
  pollMs?: number;
  onSubmitted?: (signature: string) => void;
}

const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

/** Read/simulate/send façade over the RPC pool. Never sees private keys. */
export class SolanaClient {
  constructor(
    readonly pool: RpcPool,
    private readonly log: Logger = silentLogger,
  ) {}

  // ------------------------------------------------------------ balances

  /** Lamport balances for many wallets in batches of 100. */
  async getLamports(addresses: string[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (let i = 0; i < addresses.length; i += 100) {
      const chunk = addresses.slice(i, i + 100);
      const infos = await this.pool.call('getMultipleAccountsInfo', (c) => c.getMultipleAccountsInfo(chunk.map((a) => new PublicKey(a))));
      chunk.forEach((a, j) => out.set(a, BigInt(infos[j]?.lamports ?? 0)));
    }
    return out;
  }

  async getTokenBalances(owner: string): Promise<TokenBalance[]> {
    const res: TokenBalance[] = [];
    for (const programId of TOKEN_PROGRAMS) {
      const r = await this.pool.call('getParsedTokenAccountsByOwner', (c) =>
        c.getParsedTokenAccountsByOwner(new PublicKey(owner), { programId: new PublicKey(programId) }),
      );
      for (const { pubkey, account } of r.value) {
        const info = (account.data as ParsedAccountData).parsed?.info;
        if (!info) continue;
        res.push({
          mint: info.mint,
          tokenAccount: pubkey.toBase58(),
          programId,
          amountRaw: BigInt(info.tokenAmount.amount),
          decimals: info.tokenAmount.decimals,
        });
      }
    }
    return res;
  }

  async getWalletBalances(addresses: string[], opts: { concurrency?: number } = {}): Promise<WalletBalance[]> {
    const lamports = await this.getLamports(addresses);
    const out: WalletBalance[] = [];
    await mapLimit(addresses, opts.concurrency ?? 8, async (a) => {
      const tokens = await this.getTokenBalances(a).catch((e) => {
        this.log.warn('token balance fetch failed', { wallet: a, error: errorMessage(e) });
        return [] as TokenBalance[];
      });
      out.push({ publicKey: a, lamports: lamports.get(a) ?? 0n, tokens, fetchedAt: Date.now() });
    });
    const order = new Map(addresses.map((a, i) => [a, i]));
    return out.sort((x, y) => order.get(x.publicKey)! - order.get(y.publicKey)!);
  }

  // ------------------------------------------------------------ mints & holders

  async getMintInfo(mint: string): Promise<MintInfo> {
    const r = await this.pool.call('getParsedAccountInfo', (c) => c.getParsedAccountInfo(new PublicKey(mint)));
    const acc = r.value as AccountInfo<ParsedAccountData> | null;
    if (!acc) throw new Error(`Mint ${mint} not found`);
    const programId = acc.owner.toBase58();
    if (!TOKEN_PROGRAMS.includes(programId) || acc.data?.parsed?.type !== 'mint') {
      throw new Error(`${mint} is not an SPL token mint`);
    }
    const info = acc.data.parsed.info;
    return {
      mint,
      programId,
      decimals: info.decimals,
      supplyRaw: BigInt(info.supply),
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      extensions: Array.isArray(info.extensions) ? info.extensions.map((x: { extension: string }) => x.extension) : [],
    };
  }

  /** Top token accounts (max 20 from RPC) with resolved owners. */
  async getLargestHolders(mint: string, supplyRaw: bigint): Promise<HolderInfo[]> {
    const largest = await this.pool.call('getTokenLargestAccounts', (c) => c.getTokenLargestAccounts(new PublicKey(mint)));
    const accounts = largest.value.map((v) => v.address);
    const parsed = await this.pool.call('getMultipleParsedAccounts', (c) => c.getMultipleParsedAccounts(accounts));
    const owners = parsed.value.map((a) => ((a?.data as ParsedAccountData | undefined)?.parsed?.info?.owner as string | undefined) ?? null);
    // Owners that are themselves off-curve (PDAs) are program-controlled: pool vaults, lockers, etc.
    return largest.value.map((v, i) => {
      const owner = owners[i] ?? null;
      const amountRaw = BigInt(v.amount);
      return {
        tokenAccount: v.address.toBase58(),
        owner,
        amountRaw,
        pctOfSupply: supplyRaw > 0n ? Number((amountRaw * 1_000_000n) / supplyRaw) / 10_000 : 0,
        isProgramOrPool: owner ? !PublicKey.isOnCurve(new PublicKey(owner).toBytes()) : false,
      };
    });
  }

  // ------------------------------------------------------------ history

  async getSignatures(address: string, limit = 50, before?: string) {
    return this.pool.call('getSignaturesForAddress', (c) => c.getSignaturesForAddress(new PublicKey(address), { limit, before }));
  }

  // ------------------------------------------------------------ fees

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return this.pool.call('getLatestBlockhash', (c) => c.getLatestBlockhash(this.pool.commitment));
  }

  /** Percentile of recent prioritization fees (micro-lamports per CU) touching the given accounts. */
  async getPriorityFeePercentile(accounts: string[], percentile: number): Promise<number | null> {
    try {
      const fees = await this.pool.call('getRecentPrioritizationFees', (c) =>
        c.getRecentPrioritizationFees({ lockedWritableAccounts: accounts.slice(0, 128).map((a) => new PublicKey(a)) }),
      );
      const xs = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
      if (!xs.length) return null;
      return xs[Math.min(xs.length - 1, Math.floor((percentile / 100) * xs.length))] ?? null;
    } catch (e) {
      this.log.debug('priority fee estimate unavailable', { error: errorMessage(e) });
      return null;
    }
  }

  async getMinimumBalanceForRentExemption(bytes: number): Promise<bigint> {
    return BigInt(await this.pool.call('getMinimumBalanceForRentExemption', (c) => c.getMinimumBalanceForRentExemption(bytes)));
  }

  // ------------------------------------------------------------ tx inspection support

  /** Resolve all account keys (static + address-lookup-table) of a v0 transaction. */
  async resolveAccountKeys(tx: VersionedTransaction): Promise<string[]> {
    const msg = tx.message;
    const lookups = msg.addressTableLookups ?? [];
    if (!lookups.length) return msg.staticAccountKeys.map((k) => k.toBase58());
    const tables: AddressLookupTableAccount[] = [];
    for (const l of lookups) {
      const r = await this.pool.call('getAddressLookupTable', (c) => c.getAddressLookupTable(l.accountKey));
      if (!r.value) throw new Error(`Lookup table ${l.accountKey.toBase58()} not found`);
      tables.push(r.value);
    }
    const keys = msg.getAccountKeys({ addressLookupTableAccounts: tables });
    const all: string[] = [];
    for (let i = 0; i < keys.length; i++) all.push(keys.get(i)!.toBase58());
    return all;
  }

  // ------------------------------------------------------------ simulate & send

  /**
   * Simulate without signatures (sigVerify off, blockhash replaced) and read
   * back post-execution balances of the signer and an optional token account.
   */
  async simulate(tx: VersionedTransaction, watch: { wallet: string; tokenAccount?: string }): Promise<SimulationResult> {
    const addresses = [watch.wallet, ...(watch.tokenAccount ? [watch.tokenAccount] : [])];
    try {
      const r = await this.pool.call('simulateTransaction', (c) =>
        c.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: 'processed',
          accounts: { encoding: 'base64', addresses },
        }),
      );
      const v = r.value;
      const accs = v.accounts ?? [];
      const postLamports = accs[0] ? BigInt(accs[0].lamports) : null;
      let postTokenRaw: bigint | null = null;
      const ta = accs[1];
      if (watch.tokenAccount) {
        if (ta && Array.isArray(ta.data) && ta.data[0]) postTokenRaw = readTokenAmount(Buffer.from(ta.data[0], 'base64'));
        else postTokenRaw = 0n;
      }
      return {
        ok: v.err === null,
        error: v.err ? describeTxError(v.err, v.logs ?? []) : null,
        logs: (v.logs ?? []).slice(-40),
        unitsConsumed: v.unitsConsumed ?? null,
        postLamports,
        postTokenRaw,
      };
    } catch (e) {
      return { ok: false, error: errorMessage(e), logs: [], unitsConsumed: null, postLamports: null, postTokenRaw: null };
    }
  }

  /**
   * Broadcast a signed transaction to all healthy endpoints and re-broadcast
   * until it is confirmed or its blockhash expires. Re-broadcasting the same
   * signed bytes is idempotent; expiry is definitive, so callers can safely
   * re-plan without double-spending.
   */
  async sendAndConfirm(tx: VersionedTransaction, o: SendOptions): Promise<SendResult> {
    const raw = tx.serialize();
    const sig = bs58encode(tx.signatures[0]!);
    const broadcast = async (first: boolean) => {
      const conns = this.pool.connections();
      await Promise.allSettled(
        conns.map((c) => c.sendRawTransaction(raw, { skipPreflight: first ? !!o.skipPreflight : true, maxRetries: 0 })),
      ).then((rs) => {
        const failures = rs.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        if (first && failures.length === rs.length) throw failures[0]!.reason;
      });
    };
    try {
      await broadcast(true);
    } catch (e) {
      return { signature: sig, status: 'FAILED', error: errorMessage(e), slot: null, feeLamports: null };
    }
    o.onSubmitted?.(sig);

    const pollMs = o.pollMs ?? 1_000;
    const rebroadcastMs = o.rebroadcastMs ?? 2_000;
    let lastBroadcast = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, pollMs));
      try {
        const st = await this.pool.call('getSignatureStatuses', (c) => c.getSignatureStatuses([sig], { searchTransactionHistory: false }));
        const s = st.value[0];
        if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
          const fee = await this.getFee(sig).catch(() => null);
          if (s.err) return { signature: sig, status: 'FAILED', error: JSON.stringify(s.err), slot: s.slot, feeLamports: fee };
          return { signature: sig, status: 'CONFIRMED', error: null, slot: s.slot, feeLamports: fee };
        }
        const height = await this.pool.call('getBlockHeight', (c) => c.getBlockHeight('confirmed'));
        if (height > o.lastValidBlockHeight) {
          // one final check with history in case we missed the confirmation
          const fin = await this.pool.call('getSignatureStatuses', (c) => c.getSignatureStatuses([sig], { searchTransactionHistory: true }));
          const f = fin.value[0];
          if (f && !f.err) return { signature: sig, status: 'CONFIRMED', error: null, slot: f.slot, feeLamports: null };
          return { signature: sig, status: 'EXPIRED', error: 'blockhash expired before confirmation', slot: null, feeLamports: null };
        }
        if (Date.now() - lastBroadcast >= rebroadcastMs) {
          lastBroadcast = Date.now();
          await broadcast(false).catch(() => undefined);
        }
      } catch (e) {
        this.log.warn('confirmation poll error', { signature: sig, error: errorMessage(e) });
      }
    }
  }

  /** Actual SOL / token balance changes of `wallet` in a confirmed tx (for fill accounting). */
  async getTxBalanceDeltas(sig: string, wallet: string, mint: string | null): Promise<{ lamportsDelta: bigint; tokenDelta: bigint; fee: bigint } | null> {
    const t = await this.pool.call('getTransaction', (c) => c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
    if (!t?.meta) return null;
    const keys = [
      ...t.transaction.message.staticAccountKeys.map((k) => k.toBase58()),
      ...(t.meta.loadedAddresses?.writable ?? []).map((k) => k.toBase58()),
      ...(t.meta.loadedAddresses?.readonly ?? []).map((k) => k.toBase58()),
    ];
    const idx = keys.indexOf(wallet);
    const lamportsDelta = idx >= 0 ? BigInt(t.meta.postBalances[idx]!) - BigInt(t.meta.preBalances[idx]!) : 0n;
    const sumTok = (xs: typeof t.meta.preTokenBalances) =>
      (xs ?? []).filter((b) => b.owner === wallet && b.mint === mint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
    const tokenDelta = mint ? sumTok(t.meta.postTokenBalances) - sumTok(t.meta.preTokenBalances) : 0n;
    return { lamportsDelta, tokenDelta, fee: BigInt(t.meta.fee) };
  }

  private async getFee(sig: string): Promise<bigint | null> {
    const t = await this.pool.call('getTransaction', (c) => c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
    return t?.meta ? BigInt(t.meta.fee) : null;
  }
}

/** SPL token account: amount is a u64 LE at byte offset 64. */
export function readTokenAmount(data: Buffer): bigint {
  if (data.length < 72) return 0n;
  return data.readBigUInt64LE(64);
}

export function describeTxError(err: unknown, logs: string[]): string {
  const joined = logs.join('\n');
  if (/insufficient lamports|insufficient funds/i.test(joined)) return 'Insufficient SOL for amount + fees';
  if (/slippage|0x1771|SlippageToleranceExceeded/i.test(joined)) return 'Slippage tolerance exceeded';
  if (/exceeded CUs meter|ComputationalBudgetExceeded/i.test(joined)) return 'Compute budget exceeded';
  if (/account frozen|0x11\b/i.test(joined)) return 'Token account is frozen';
  if (/InsufficientFundsForRent/i.test(JSON.stringify(err))) return 'Would leave account below rent-exempt minimum';
  return typeof err === 'string' ? err : JSON.stringify(err);
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  });
  await Promise.all(workers);
}

function bs58encode(b: Uint8Array): string {
  return bs58.encode(b);
}
