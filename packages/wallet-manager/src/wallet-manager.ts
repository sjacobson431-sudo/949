import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { TerminalError, type Logger, silentLogger, type WalletBalance, type WalletRecord } from '@term/core';
import type { Repositories, WalletFilter } from '@term/database';
import { Vault, ModeGuard, wipe, type ExportBundle } from '@term/security';
import type { SolanaClient } from '@term/solana-client';

export interface GenerateOptions {
  count: number;
  labelPrefix?: string;
  group?: string | null;
  tags?: string[];
}

/** Accepts base58 (64-byte secret) or a Solana CLI JSON array. Returns a fresh buffer the caller must wipe. */
export function parseSecretKey(input: string): Uint8Array {
  const s = input.trim();
  let bytes: Uint8Array;
  if (s.startsWith('[')) {
    const arr = JSON.parse(s) as number[];
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('invalid key array');
    bytes = Uint8Array.from(arr);
  } else {
    bytes = bs58.decode(s);
  }
  if (bytes.length !== 64) {
    wipe(bytes);
    throw new TerminalError('VALIDATION', `Secret key must be 64 bytes (got ${bytes.length}). Seed phrases are not accepted here.`);
  }
  return bytes;
}

export class WalletManager {
  private balanceCache = new Map<string, WalletBalance>();

  constructor(
    private readonly repos: Repositories,
    private readonly vault: Vault,
    private readonly client: SolanaClient | null,
    private readonly log: Logger = silentLogger,
  ) {}

  list(f?: WalletFilter): WalletRecord[] {
    return this.repos.wallets.list(f);
  }

  get(pk: string): WalletRecord {
    const w = this.repos.wallets.byPublicKey(pk);
    if (!w) throw new TerminalError('NOT_FOUND', `Unknown wallet ${pk}`);
    return w;
  }

  primary(): WalletRecord | undefined {
    return this.repos.wallets.primary();
  }

  generate(o: GenerateOptions): WalletRecord[] {
    if (o.count < 1 || o.count > 1000) throw new TerminalError('VALIDATION', 'count must be between 1 and 1000');
    if (!this.vault.isUnlocked()) throw new TerminalError('VAULT_LOCKED', 'Unlock the vault to generate wallets');
    const start = this.repos.wallets.count();
    const created = this.repos.db.transaction(() => {
      const out: WalletRecord[] = [];
      for (let i = 0; i < o.count; i++) {
        const kp = Keypair.generate();
        const pk = kp.publicKey.toBase58();
        out.push(
          this.repos.wallets.insert({
            publicKey: pk,
            label: `${o.labelPrefix ?? 'w'}${String(start + i + 1).padStart(3, '0')}`,
            groupName: o.group ?? null,
            tags: o.tags ?? [],
            source: 'generated',
          }),
        );
        try {
          this.vault.storeSecret(pk, kp.secretKey);
        } finally {
          wipe(kp.secretKey);
        }
      }
      return out;
    });
    if (!this.repos.wallets.primary() && created[0]) this.repos.wallets.setPrimary(created[0].publicKey);
    this.log.info('wallets generated', { count: created.length, group: o.group ?? null });
    return created.map((w) => this.repos.wallets.byId(w.id)!);
  }

  importSecret(secretInput: string, meta: { label?: string; group?: string | null; tags?: string[] } = {}): WalletRecord {
    if (!this.vault.isUnlocked()) throw new TerminalError('VAULT_LOCKED', 'Unlock the vault to import wallets');
    const secret = parseSecretKey(secretInput);
    try {
      const kp = Keypair.fromSecretKey(secret); // validates pubkey/secret consistency
      const pk = kp.publicKey.toBase58();
      if (this.repos.wallets.byPublicKey(pk)) throw new TerminalError('VALIDATION', `Wallet ${pk} already exists`);
      const rec = this.repos.db.transaction(() => {
        const r = this.repos.wallets.insert({
          publicKey: pk,
          label: meta.label ?? `imported-${pk.slice(0, 4)}`,
          groupName: meta.group ?? null,
          tags: meta.tags ?? [],
          source: 'imported',
        });
        this.vault.storeSecret(pk, secret);
        return r;
      });
      wipe(kp.secretKey);
      if (!this.repos.wallets.primary()) this.repos.wallets.setPrimary(pk);
      this.log.info('wallet imported', { publicKey: pk });
      return rec;
    } finally {
      wipe(secret);
    }
  }

  async exportEncrypted(publicKeys: string[], exportPassword: string): Promise<ExportBundle & { meta: Pick<WalletRecord, 'publicKey' | 'label' | 'groupName' | 'tags'>[] }> {
    const bundle = await this.vault.exportEncrypted(publicKeys, exportPassword);
    const meta = publicKeys.map((pk) => {
      const w = this.get(pk);
      return { publicKey: w.publicKey, label: w.label, groupName: w.groupName, tags: w.tags };
    });
    this.log.warn('wallets exported (encrypted)', { count: publicKeys.length });
    return { ...bundle, meta };
  }

  async importEncrypted(bundle: ExportBundle & { meta?: { publicKey: string; label: string; groupName: string | null; tags: string[] }[] }, exportPassword: string): Promise<WalletRecord[]> {
    const metas = new Map((bundle.meta ?? []).map((m) => [m.publicKey, m]));
    const out: WalletRecord[] = [];
    await Vault.readExportBundle(bundle, exportPassword, (pk, secret) => {
      if (this.repos.wallets.byPublicKey(pk)) return;
      const kp = Keypair.fromSecretKey(secret);
      const derived = kp.publicKey.toBase58();
      wipe(kp.secretKey);
      if (derived !== pk) throw new TerminalError('VALIDATION', `bundle key mismatch for ${pk}`);
      const m = metas.get(pk);
      this.repos.db.transaction(() => {
        out.push(
          this.repos.wallets.insert({ publicKey: pk, label: m?.label ?? `imported-${pk.slice(0, 4)}`, groupName: m?.groupName ?? null, tags: m?.tags ?? [], source: 'imported' }),
        );
        this.vault.storeSecret(pk, secret);
      });
    });
    if (!this.repos.wallets.primary() && out[0]) this.repos.wallets.setPrimary(out[0].publicKey);
    return out;
  }

  /**
   * Plaintext export. Deliberately awkward to call: the caller must pass the
   * literal acknowledgement string. The CLI is the only caller.
   */
  async exportPlaintext(publicKeys: string[], ack: 'I understand this exposes private keys'): Promise<{ publicKey: string; secretKey: string }[]> {
    if (ack !== 'I understand this exposes private keys') throw new TerminalError('VALIDATION', 'acknowledgement required');
    const out: { publicKey: string; secretKey: string }[] = [];
    for (const pk of publicKeys) {
      await this.vault.withSecret(pk, (s) => {
        out.push({ publicKey: pk, secretKey: bs58.encode(s) });
      });
    }
    this.log.warn('wallets exported in PLAINTEXT', { count: publicKeys.length });
    return out;
  }

  /** Public data only — safe to share. */
  exportPublicCsv(f?: WalletFilter): string {
    const rows = this.list({ includeArchived: true, ...f });
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    return [
      'public_key,label,group,tags,primary,archived,source,created_at',
      ...rows.map((w) =>
        [w.publicKey, esc(w.label), esc(w.groupName ?? ''), esc(w.tags.join('|')), w.isPrimary, w.archived, w.source, new Date(w.createdAt).toISOString()].join(','),
      ),
    ].join('\n');
  }

  update(pk: string, patch: Partial<Pick<WalletRecord, 'label' | 'groupName' | 'tags' | 'archived'>>): WalletRecord {
    const w = this.get(pk);
    if (patch.archived && w.isPrimary) throw new TerminalError('VALIDATION', 'Cannot archive the primary wallet');
    return this.repos.wallets.update(pk, patch);
  }

  bulkUpdate(pks: string[], patch: Partial<Pick<WalletRecord, 'groupName' | 'tags' | 'archived'>>): number {
    return this.repos.db.transaction(() => {
      for (const pk of pks) this.update(pk, patch);
      return pks.length;
    });
  }

  setPrimary(pk: string): void {
    this.get(pk);
    this.repos.wallets.setPrimary(pk);
  }

  groups() {
    return this.repos.wallets.groups();
  }

  // ------------------------------------------------------------ balances

  async refreshBalances(pks?: string[]): Promise<WalletBalance[]> {
    if (!this.client) throw new TerminalError('RPC_UNAVAILABLE', 'No RPC client configured');
    const list = pks ?? this.list().map((w) => w.publicKey);
    const balances = await this.client.getWalletBalances(list);
    for (const b of balances) this.balanceCache.set(b.publicKey, b);
    return balances;
  }

  cachedBalance(pk: string): WalletBalance | undefined {
    return this.balanceCache.get(pk);
  }

  cachedBalances(): WalletBalance[] {
    return [...this.balanceCache.values()];
  }

  /** For SIMULATION mode paper accounting and tests. */
  setCachedBalance(b: WalletBalance): void {
    this.balanceCache.set(b.publicKey, b);
  }
}

/**
 * The only component that turns a vault secret into a signature. Every call
 * passes through the ModeGuard, so nothing is signed outside LIVE mode.
 */
export class TransactionSigner {
  constructor(
    private readonly vault: Vault,
    private readonly mode: ModeGuard,
  ) {}

  async sign(wallet: string, tx: VersionedTransaction): Promise<VersionedTransaction> {
    this.mode.assertCanSign();
    await this.vault.withSecret(wallet, (secret) => {
      const kp = Keypair.fromSecretKey(secret);
      try {
        if (kp.publicKey.toBase58() !== wallet) throw new TerminalError('VALIDATION', 'vault key does not match wallet');
        tx.sign([kp]);
      } finally {
        wipe(kp.secretKey);
      }
    });
    return tx;
  }
}
