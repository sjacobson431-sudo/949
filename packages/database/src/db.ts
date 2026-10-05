import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema';

// node:sqlite is stable enough for our needs; silence its ExperimentalWarning once.
const origEmit = process.emitWarning.bind(process);
(process as any).emitWarning = (warning: string | Error, ...rest: any[]) => {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (typeof msg === 'string' && msg.includes('SQLite is an experimental feature')) return;
  return (origEmit as any)(warning, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = await import('node:sqlite');
type DatabaseSyncT = InstanceType<typeof DatabaseSync>;

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export class Db {
  readonly raw: DatabaseSyncT;
  private txDepth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const row = this.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_version');
    const current = row?.v ?? 0;
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.transaction(() => {
        this.raw.exec(m.sql);
        this.run('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', m.version, Date.now());
      });
    }
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  /** Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export const big = (v: SqlValue | undefined): bigint => (v === null || v === undefined ? 0n : BigInt(v as any));
export const bigOrNull = (v: SqlValue | undefined): bigint | null => (v === null || v === undefined ? null : BigInt(v as any));
export const str = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : v.toString());
