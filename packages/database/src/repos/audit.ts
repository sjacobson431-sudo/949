import type { OperatingMode, Plan, PlanStatus, Side, TxAuditRecord, TxKind, TxStatus } from '@term/core';
import { parseJson, stringifyJson } from '@term/core';
import { big, bigOrNull, str, type Db, type Row } from '../db';

const toAudit = (r: Row): TxAuditRecord => ({
  id: Number(r.id),
  planId: (r.plan_id as string) ?? null,
  legId: (r.leg_id as string) ?? null,
  kind: r.kind as TxKind,
  mode: r.mode as OperatingMode,
  status: r.status as TxStatus,
  wallet: r.wallet as string,
  signature: (r.signature as string) ?? null,
  mint: (r.mint as string) ?? null,
  side: (r.side as Side) ?? null,
  lamportsDelta: big(r.lamports_delta),
  tokenDelta: bigOrNull(r.token_delta),
  feeLamports: bigOrNull(r.fee_lamports),
  details: parseJson(r.details_json as string),
  error: (r.error as string) ?? null,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

export interface AuditInsert {
  planId?: string | null;
  legId?: string | null;
  kind: TxKind;
  mode: OperatingMode;
  status: TxStatus;
  wallet: string;
  mint?: string | null;
  side?: Side | null;
  lamportsDelta: bigint;
  tokenDelta?: bigint | null;
  feeLamports?: bigint | null;
  internal?: boolean;
  details?: Record<string, unknown>;
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  insert(a: AuditInsert): number {
    const now = Date.now();
    return this.db.run(
      `INSERT INTO tx_audit (plan_id, leg_id, kind, mode, status, wallet, mint, side, lamports_delta, token_delta, fee_lamports, internal, details_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.planId ?? null,
      a.legId ?? null,
      a.kind,
      a.mode,
      a.status,
      a.wallet,
      a.mint ?? null,
      a.side ?? null,
      a.lamportsDelta.toString(),
      str(a.tokenDelta),
      str(a.feeLamports),
      a.internal ? 1 : 0,
      stringifyJson(a.details ?? {}),
      now,
      now,
    ).lastInsertRowid;
  }

  update(id: number, patch: { status?: TxStatus; signature?: string | null; error?: string | null; feeLamports?: bigint | null; tokenDelta?: bigint | null; lamportsDelta?: bigint; details?: Record<string, unknown> }): void {
    const cur = this.byId(id);
    if (!cur) throw new Error(`audit ${id} not found`);
    this.db.run(
      `UPDATE tx_audit SET status = ?, signature = ?, error = ?, fee_lamports = ?, token_delta = ?, lamports_delta = ?, details_json = ?, updated_at = ? WHERE id = ?`,
      patch.status ?? cur.status,
      patch.signature !== undefined ? patch.signature : cur.signature,
      patch.error !== undefined ? patch.error : cur.error,
      str(patch.feeLamports !== undefined ? patch.feeLamports : cur.feeLamports),
      str(patch.tokenDelta !== undefined ? patch.tokenDelta : cur.tokenDelta),
      (patch.lamportsDelta ?? cur.lamportsDelta).toString(),
      stringifyJson({ ...cur.details, ...(patch.details ?? {}) }),
      Date.now(),
      id,
    );
  }

  byId(id: number): TxAuditRecord | undefined {
    const r = this.db.get('SELECT * FROM tx_audit WHERE id = ?', id);
    return r && toAudit(r);
  }

  byPlan(planId: string): TxAuditRecord[] {
    return this.db.all('SELECT * FROM tx_audit WHERE plan_id = ? ORDER BY id', planId).map(toAudit);
  }

  list(f: { wallet?: string; mint?: string; mode?: OperatingMode; limit?: number; offset?: number } = {}): TxAuditRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.wallet) (where.push('wallet = ?'), params.push(f.wallet));
    if (f.mint) (where.push('mint = ?'), params.push(f.mint));
    if (f.mode) (where.push('mode = ?'), params.push(f.mode));
    params.push(f.limit ?? 200, f.offset ?? 0);
    return this.db
      .all(`SELECT * FROM tx_audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params)
      .map(toAudit);
  }

  /** Implements OutflowHistory: LIVE SOL that left wallets since `sinceMs`. */
  outflowSince(wallet: string | null, sinceMs: number): bigint {
    const rows = this.db.all<{ lamports_delta: string }>(
      `SELECT lamports_delta FROM tx_audit
       WHERE mode = 'LIVE' AND status IN ('SUBMITTED','CONFIRMED') AND created_at >= ?
       ${wallet ? 'AND wallet = ?' : 'AND internal = 0'}`,
      ...(wallet ? [sinceMs, wallet] : [sinceMs]),
    );
    let t = 0n;
    for (const r of rows) {
      const d = BigInt(r.lamports_delta);
      if (d > 0n) t += d;
    }
    return t;
  }

  /** Any non-terminal audit rows (for crash recovery). */
  inFlight(): TxAuditRecord[] {
    return this.db.all(`SELECT * FROM tx_audit WHERE status = 'SUBMITTED' ORDER BY id`).map(toAudit);
  }
}

export class PlanRepo {
  constructor(private readonly db: Db) {}

  save(plan: Plan, status: PlanStatus = 'PREVIEW'): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO plans (id, kind, mode, status, hash, title, body_json, strategy_tag, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, body_json = excluded.body_json, hash = excluded.hash, updated_at = excluded.updated_at`,
      plan.id,
      plan.kind,
      plan.mode,
      status,
      plan.hash,
      plan.title,
      stringifyJson(plan),
      plan.strategyTag,
      plan.createdAt,
      plan.expiresAt,
      now,
    );
  }

  get(id: string): { plan: Plan; status: PlanStatus } | undefined {
    const r = this.db.get<{ body_json: string; status: PlanStatus }>('SELECT body_json, status FROM plans WHERE id = ?', id);
    return r && { plan: parseJson<Plan>(r.body_json), status: r.status };
  }

  setStatus(id: string, status: PlanStatus): void {
    this.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', status, Date.now(), id);
  }

  list(limit = 50): { id: string; kind: string; mode: string; status: PlanStatus; title: string; createdAt: number }[] {
    return this.db
      .all<{ id: string; kind: string; mode: string; status: PlanStatus; title: string; created_at: number }>(
        'SELECT id, kind, mode, status, title, created_at FROM plans ORDER BY created_at DESC LIMIT ?',
        limit,
      )
      .map((r) => ({ id: r.id, kind: r.kind, mode: r.mode, status: r.status, title: r.title, createdAt: Number(r.created_at) }));
  }
}
