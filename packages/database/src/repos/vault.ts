import type { Db } from '../db';

interface SealedBox { iv: string; ct: string }
interface Meta { kdf: any; verifier: SealedBox }

/** Implements @term/security VaultStore. Only ciphertext ever reaches disk. */
export class VaultRepo {
  constructor(private readonly db: Db) {}

  getVaultMeta(): Meta | null {
    const r = this.db.get<{ kdf_json: string; verifier_json: string }>('SELECT kdf_json, verifier_json FROM vault_meta WHERE id = 1');
    return r ? { kdf: JSON.parse(r.kdf_json), verifier: JSON.parse(r.verifier_json) } : null;
  }

  setVaultMeta(m: Meta): void {
    this.db.run(
      `INSERT INTO vault_meta (id, kdf_json, verifier_json, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kdf_json = excluded.kdf_json, verifier_json = excluded.verifier_json, updated_at = excluded.updated_at`,
      JSON.stringify(m.kdf),
      JSON.stringify(m.verifier),
      Date.now(),
    );
  }

  getSealedKey(publicKey: string): SealedBox | null {
    const r = this.db.get<{ iv: string; ct: string }>('SELECT iv, ct FROM wallet_keys WHERE public_key = ?', publicKey);
    return r ? { iv: r.iv, ct: r.ct } : null;
  }

  putSealedKey(publicKey: string, box: SealedBox): void {
    this.db.run(
      `INSERT INTO wallet_keys (public_key, iv, ct, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(public_key) DO UPDATE SET iv = excluded.iv, ct = excluded.ct, updated_at = excluded.updated_at`,
      publicKey,
      box.iv,
      box.ct,
      Date.now(),
    );
  }

  listSealedKeys(): { publicKey: string; box: SealedBox }[] {
    return this.db
      .all<{ public_key: string; iv: string; ct: string }>('SELECT public_key, iv, ct FROM wallet_keys')
      .map((r) => ({ publicKey: r.public_key, box: { iv: r.iv, ct: r.ct } }));
  }

  replaceAll(meta: Meta, keys: { publicKey: string; box: SealedBox }[]): void {
    this.db.transaction(() => {
      this.setVaultMeta(meta);
      for (const k of keys) this.putSealedKey(k.publicKey, k.box);
    });
  }
}
