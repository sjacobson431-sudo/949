import { TerminalError } from '@term/core';
import { deriveKey, newKdfParams, open, seal, wipe, type KdfParams, type SealedBox } from './crypto';
import { checkPasswordStrength } from './password';

/** Persistence port; implemented by @term/database. Stores ciphertext only. */
export interface VaultStore {
  getVaultMeta(): { kdf: KdfParams; verifier: SealedBox } | null;
  setVaultMeta(meta: { kdf: KdfParams; verifier: SealedBox }): void;
  getSealedKey(publicKey: string): SealedBox | null;
  putSealedKey(publicKey: string, box: SealedBox): void;
  listSealedKeys(): { publicKey: string; box: SealedBox }[];
  /** Atomically replace meta + all keys (password rotation). */
  replaceAll(meta: { kdf: KdfParams; verifier: SealedBox }, keys: { publicKey: string; box: SealedBox }[]): void;
}

const VERIFIER_AAD = 'vault-verifier-v1';
const VERIFIER_PLAINTEXT = Buffer.from('solana-terminal-vault-ok', 'utf8');
const keyAad = (publicKey: string) => `wallet-key-v1:${publicKey}`;

export interface VaultOptions {
  kdf?: Partial<Omit<KdfParams, 'algo' | 'salt'>>;
  /** Skip password strength checks (tests only). */
  allowWeakPassword?: boolean;
}

export interface ExportBundle {
  format: 'sol-term-export-v1';
  kdf: KdfParams;
  wallets: { publicKey: string; box: SealedBox }[];
  createdAt: number;
}

/**
 * Password-protected key vault.
 *
 * The key-encryption key (KEK) is derived with scrypt and held in memory only
 * while unlocked. Wallet secrets are decrypted per-use inside `withSecret`
 * and wiped right after the callback returns.
 */
export class Vault {
  private kek: Buffer | null = null;
  private lockListeners: (() => void)[] = [];

  constructor(
    private readonly store: VaultStore,
    private readonly opts: VaultOptions = {},
  ) {}

  isInitialized(): boolean {
    return this.store.getVaultMeta() !== null;
  }

  isUnlocked(): boolean {
    return this.kek !== null;
  }

  onLock(fn: () => void): void {
    this.lockListeners.push(fn);
  }

  async initialize(password: string): Promise<void> {
    if (this.isInitialized()) throw new TerminalError('VALIDATION', 'Vault already initialized');
    this.assertStrong(password);
    const kdf = newKdfParams(this.opts.kdf);
    const kek = await deriveKey(password, kdf);
    this.store.setVaultMeta({ kdf, verifier: seal(kek, VERIFIER_PLAINTEXT, VERIFIER_AAD) });
    this.kek = kek;
  }

  async unlock(password: string): Promise<void> {
    const meta = this.store.getVaultMeta();
    if (!meta) throw new TerminalError('VAULT_NOT_INITIALIZED', 'Vault not initialized; run `vault init` first');
    const kek = await deriveKey(password, meta.kdf);
    try {
      const v = open(kek, meta.verifier, VERIFIER_AAD);
      if (!v.equals(VERIFIER_PLAINTEXT)) throw new Error('verifier mismatch');
    } catch {
      wipe(kek);
      throw new TerminalError('BAD_PASSWORD', 'Incorrect vault password');
    }
    this.lock(false);
    this.kek = kek;
  }

  /** Re-verify the password without changing state (used for LIVE-mode re-auth). */
  async verifyPassword(password: string): Promise<boolean> {
    const meta = this.store.getVaultMeta();
    if (!meta) return false;
    const kek = await deriveKey(password, meta.kdf);
    try {
      open(kek, meta.verifier, VERIFIER_AAD);
      return true;
    } catch {
      return false;
    } finally {
      wipe(kek);
    }
  }

  lock(notify = true): void {
    if (this.kek) wipe(this.kek);
    const wasUnlocked = this.kek !== null;
    this.kek = null;
    if (notify && wasUnlocked) for (const fn of this.lockListeners) fn();
  }

  storeSecret(publicKey: string, secretKey: Uint8Array): void {
    const kek = this.requireKek();
    this.store.putSealedKey(publicKey, seal(kek, secretKey, keyAad(publicKey)));
  }

  hasSecret(publicKey: string): boolean {
    return this.store.getSealedKey(publicKey) !== null;
  }

  /**
   * Decrypt a wallet secret for the duration of `fn` only. The buffer passed
   * to `fn` is zeroed afterwards — do not retain references to it.
   */
  async withSecret<T>(publicKey: string, fn: (secret: Uint8Array) => Promise<T> | T): Promise<T> {
    const kek = this.requireKek();
    const box = this.store.getSealedKey(publicKey);
    if (!box) throw new TerminalError('NOT_FOUND', `No key in vault for ${publicKey}`);
    const secret = open(kek, box, keyAad(publicKey));
    try {
      return await fn(secret);
    } finally {
      wipe(secret);
    }
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    this.assertStrong(newPassword);
    const meta = this.store.getVaultMeta();
    if (!meta) throw new TerminalError('VAULT_NOT_INITIALIZED', 'Vault not initialized');
    const oldKek = await deriveKey(oldPassword, meta.kdf);
    try {
      open(oldKek, meta.verifier, VERIFIER_AAD);
    } catch {
      wipe(oldKek);
      throw new TerminalError('BAD_PASSWORD', 'Incorrect vault password');
    }
    const kdf = newKdfParams(this.opts.kdf);
    const newKek = await deriveKey(newPassword, kdf);
    const keys = this.store.listSealedKeys().map(({ publicKey, box }) => {
      const s = open(oldKek, box, keyAad(publicKey));
      try {
        return { publicKey, box: seal(newKek, s, keyAad(publicKey)) };
      } finally {
        wipe(s);
      }
    });
    this.store.replaceAll({ kdf, verifier: seal(newKek, VERIFIER_PLAINTEXT, VERIFIER_AAD) }, keys);
    wipe(oldKek);
    this.lock(false);
    this.kek = newKek;
  }

  /** Re-encrypt selected secrets under a separate export password. */
  async exportEncrypted(publicKeys: string[], exportPassword: string): Promise<ExportBundle> {
    this.assertStrong(exportPassword);
    const kdf = newKdfParams(this.opts.kdf);
    const exportKey = await deriveKey(exportPassword, kdf);
    try {
      const wallets: ExportBundle['wallets'] = [];
      for (const pk of publicKeys) {
        await this.withSecret(pk, (s) => {
          wallets.push({ publicKey: pk, box: seal(exportKey, s, keyAad(pk)) });
        });
      }
      return { format: 'sol-term-export-v1', kdf, wallets, createdAt: Date.now() };
    } finally {
      wipe(exportKey);
    }
  }

  /** Decrypt an export bundle; yields each secret to `fn` and wipes it afterwards. */
  static async readExportBundle(
    bundle: ExportBundle,
    exportPassword: string,
    fn: (publicKey: string, secret: Uint8Array) => void | Promise<void>,
  ): Promise<void> {
    if (bundle.format !== 'sol-term-export-v1') throw new TerminalError('VALIDATION', 'Unknown export format');
    const key = await deriveKey(exportPassword, bundle.kdf);
    try {
      for (const w of bundle.wallets) {
        let s: Buffer;
        try {
          s = open(key, w.box, keyAad(w.publicKey));
        } catch {
          throw new TerminalError('BAD_PASSWORD', 'Incorrect export password or corrupted bundle');
        }
        try {
          await fn(w.publicKey, s);
        } finally {
          wipe(s);
        }
      }
    } finally {
      wipe(key);
    }
  }

  private requireKek(): Buffer {
    if (!this.kek) throw new TerminalError('VAULT_LOCKED', 'Vault is locked');
    return this.kek;
  }

  private assertStrong(pw: string): void {
    if (this.opts.allowWeakPassword) return;
    const c = checkPasswordStrength(pw);
    if (!c.ok) throw new TerminalError('VALIDATION', `Weak password: ${c.problems.join('; ')}`);
  }
}
