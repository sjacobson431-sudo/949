import type { WalletRecord, WalletSource } from '@term/core';
import type { Db } from '../db';

interface WalletRow {
  id: number;
  public_key: string;
  label: string;
  group_name: string | null;
  tags_json: string;
  is_primary: number;
  archived: number;
  source: WalletSource;
  created_at: number;
}

const toRecord = (r: WalletRow): WalletRecord => ({
  id: Number(r.id),
  publicKey: r.public_key,
  label: r.label,
  groupName: r.group_name,
  tags: JSON.parse(r.tags_json),
  isPrimary: !!r.is_primary,
  archived: !!r.archived,
  source: r.source,
  createdAt: Number(r.created_at),
});

export interface WalletFilter {
  includeArchived?: boolean;
  group?: string;
  tag?: string;
  publicKeys?: string[];
}

export class WalletRepo {
  constructor(private readonly db: Db) {}

  insert(w: { publicKey: string; label: string; groupName?: string | null; tags?: string[]; source: WalletSource }): WalletRecord {
    const r = this.db.run(
      'INSERT INTO wallets (public_key, label, group_name, tags_json, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      w.publicKey,
      w.label,
      w.groupName ?? null,
      JSON.stringify(w.tags ?? []),
      w.source,
      Date.now(),
    );
    return this.byId(r.lastInsertRowid)!;
  }

  byId(id: number): WalletRecord | undefined {
    const r = this.db.get<WalletRow>('SELECT * FROM wallets WHERE id = ?', id);
    return r && toRecord(r);
  }

  byPublicKey(pk: string): WalletRecord | undefined {
    const r = this.db.get<WalletRow>('SELECT * FROM wallets WHERE public_key = ?', pk);
    return r && toRecord(r);
  }

  primary(): WalletRecord | undefined {
    const r = this.db.get<WalletRow>('SELECT * FROM wallets WHERE is_primary = 1');
    return r && toRecord(r);
  }

  list(f: WalletFilter = {}): WalletRecord[] {
    let rows = this.db.all<WalletRow>(
      `SELECT * FROM wallets ${f.includeArchived ? '' : 'WHERE archived = 0'} ORDER BY is_primary DESC, id ASC`,
    ).map(toRecord);
    if (f.group !== undefined) rows = rows.filter((w) => w.groupName === f.group);
    if (f.tag !== undefined) rows = rows.filter((w) => w.tags.includes(f.tag!));
    if (f.publicKeys) {
      const set = new Set(f.publicKeys);
      rows = rows.filter((w) => set.has(w.publicKey));
    }
    return rows;
  }

  count(): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wallets')!.n);
  }

  update(pk: string, patch: Partial<Pick<WalletRecord, 'label' | 'groupName' | 'tags' | 'archived'>>): WalletRecord {
    const cur = this.byPublicKey(pk);
    if (!cur) throw new Error(`Unknown wallet ${pk}`);
    const next = { ...cur, ...patch };
    this.db.run(
      'UPDATE wallets SET label = ?, group_name = ?, tags_json = ?, archived = ? WHERE public_key = ?',
      next.label,
      next.groupName,
      JSON.stringify(next.tags),
      next.archived ? 1 : 0,
      pk,
    );
    return this.byPublicKey(pk)!;
  }

  setPrimary(pk: string): void {
    this.db.transaction(() => {
      this.db.run('UPDATE wallets SET is_primary = 0 WHERE is_primary = 1');
      const r = this.db.run('UPDATE wallets SET is_primary = 1, archived = 0 WHERE public_key = ?', pk);
      if (r.changes !== 1) throw new Error(`Unknown wallet ${pk}`);
    });
  }

  groups(): { name: string; count: number }[] {
    return this.db
      .all<{ group_name: string; n: number }>(
        'SELECT group_name, COUNT(*) AS n FROM wallets WHERE archived = 0 AND group_name IS NOT NULL GROUP BY group_name ORDER BY group_name',
      )
      .map((r) => ({ name: r.group_name, count: Number(r.n) }));
  }

  isVaultWallet(pk: string): boolean {
    return !!this.db.get('SELECT 1 FROM wallets WHERE public_key = ?', pk);
  }
}
