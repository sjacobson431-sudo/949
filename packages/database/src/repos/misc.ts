import type { ExitRuleSpec, ExitRuleState, StrategyPreset } from '@term/core';
import { parseJson, stringifyJson } from '@term/core';
import type { Db } from '../db';

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get<T>(key: string, fallback: T): T {
    const r = this.db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', key);
    return r ? parseJson<T>(r.value_json) : fallback;
  }

  set(key: string, value: unknown): void {
    this.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      key,
      stringifyJson(value),
      Date.now(),
    );
  }
}

export class WhitelistRepo {
  constructor(private readonly db: Db) {}

  add(address: string, label: string): void {
    this.db.run(
      'INSERT INTO whitelist (address, label, created_at) VALUES (?, ?, ?) ON CONFLICT(address) DO UPDATE SET label = excluded.label',
      address,
      label,
      Date.now(),
    );
  }

  remove(address: string): void {
    this.db.run('DELETE FROM whitelist WHERE address = ?', address);
  }

  list(): { address: string; label: string; createdAt: number }[] {
    return this.db
      .all<{ address: string; label: string; created_at: number }>('SELECT * FROM whitelist ORDER BY created_at')
      .map((r) => ({ address: r.address, label: r.label, createdAt: Number(r.created_at) }));
  }

  isWhitelisted(address: string): boolean {
    return !!this.db.get('SELECT 1 FROM whitelist WHERE address = ?', address);
  }
}

export class SnapshotRepo {
  constructor(private readonly db: Db) {}

  addPrice(mint: string, usd: number, sol: number, at = Date.now()): void {
    this.db.run('INSERT OR REPLACE INTO price_snapshots (mint, at, usd, sol) VALUES (?, ?, ?, ?)', mint, at, usd, sol);
  }

  priceHistory(mint: string, sinceMs: number): { at: number; usd: number; sol: number }[] {
    return this.db
      .all<{ at: number; usd: number; sol: number }>('SELECT at, usd, sol FROM price_snapshots WHERE mint = ? AND at >= ? ORDER BY at', mint, sinceMs)
      .map((r) => ({ at: Number(r.at), usd: r.usd, sol: r.sol }));
  }

  addToken(mint: string, liquidityUsd: number, top10Pct: number, riskScore: number | null, body: unknown, at = Date.now()): void {
    this.db.run(
      'INSERT OR REPLACE INTO token_snapshots (mint, at, liquidity_usd, top10_pct, risk_score, body_json) VALUES (?, ?, ?, ?, ?, ?)',
      mint,
      at,
      liquidityUsd,
      top10Pct,
      riskScore,
      stringifyJson(body),
    );
  }

  lastToken(mint: string): { at: number; liquidityUsd: number; top10Pct: number; riskScore: number | null } | undefined {
    const r = this.db.get<{ at: number; liquidity_usd: number; top10_pct: number; risk_score: number | null }>(
      'SELECT at, liquidity_usd, top10_pct, risk_score FROM token_snapshots WHERE mint = ? ORDER BY at DESC LIMIT 1',
      mint,
    );
    return r && { at: Number(r.at), liquidityUsd: r.liquidity_usd, top10Pct: r.top10_pct, riskScore: r.risk_score == null ? null : Number(r.risk_score) };
  }

  lastTokenBody<T>(mint: string): T | undefined {
    const r = this.db.get<{ body_json: string }>('SELECT body_json FROM token_snapshots WHERE mint = ? ORDER BY at DESC LIMIT 1', mint);
    return r && parseJson<T>(r.body_json);
  }

  recentTokens(limit = 50): { mint: string; at: number; liquidityUsd: number; riskScore: number | null }[] {
    return this.db
      .all<{ mint: string; at: number; liquidity_usd: number; risk_score: number | null }>(
        `SELECT t.mint, t.at, t.liquidity_usd, t.risk_score FROM token_snapshots t
         JOIN (SELECT mint, MAX(at) AS at FROM token_snapshots GROUP BY mint) m ON m.mint = t.mint AND m.at = t.at
         ORDER BY t.at DESC LIMIT ?`,
        limit,
      )
      .map((r) => ({ mint: r.mint, at: Number(r.at), liquidityUsd: r.liquidity_usd, riskScore: r.risk_score == null ? null : Number(r.risk_score) }));
  }

  upsertTokenMeta(mint: string, decimals: number, symbol: string | null, name: string | null): void {
    this.db.run(
      `INSERT INTO token_meta (mint, symbol, name, decimals, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(mint) DO UPDATE SET symbol = COALESCE(excluded.symbol, token_meta.symbol), name = COALESCE(excluded.name, token_meta.name), decimals = excluded.decimals, updated_at = excluded.updated_at`,
      mint,
      symbol,
      name,
      decimals,
      Date.now(),
    );
  }

  tokenMeta(mint: string): { mint: string; symbol: string | null; name: string | null; decimals: number } | undefined {
    const r = this.db.get<{ mint: string; symbol: string | null; name: string | null; decimals: number }>('SELECT * FROM token_meta WHERE mint = ?', mint);
    return r && { mint: r.mint, symbol: r.symbol, name: r.name, decimals: Number(r.decimals) };
  }

  addPortfolio(s: {
    at: number;
    paper: boolean;
    total: bigint;
    sol: bigint;
    tokens: bigint;
    realized: bigint;
    unrealized: bigint;
    solUsd: number | null;
  }): void {
    this.db.run(
      `INSERT OR REPLACE INTO portfolio_snapshots (at, paper, total_lamports, sol_lamports, tokens_lamports, realized_lamports, unrealized_lamports, sol_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      s.at,
      s.paper ? 1 : 0,
      s.total.toString(),
      s.sol.toString(),
      s.tokens.toString(),
      s.realized.toString(),
      s.unrealized.toString(),
      s.solUsd,
    );
  }

  portfolioHistory(sinceMs: number, paper = false): { at: number; total: bigint; realized: bigint; unrealized: bigint; solUsd: number | null }[] {
    return this.db
      .all<{ at: number; total_lamports: string; realized_lamports: string; unrealized_lamports: string; sol_usd: number | null }>(
        'SELECT * FROM portfolio_snapshots WHERE at >= ? AND paper = ? ORDER BY at',
        sinceMs,
        paper ? 1 : 0,
      )
      .map((r) => ({
        at: Number(r.at),
        total: BigInt(r.total_lamports),
        realized: BigInt(r.realized_lamports),
        unrealized: BigInt(r.unrealized_lamports),
        solUsd: r.sol_usd,
      }));
  }
}

export class StrategyRepo {
  constructor(private readonly db: Db) {}

  upsert(s: StrategyPreset): void {
    this.db.run(
      `INSERT INTO strategies (id, name, builtin, body_json, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, body_json = excluded.body_json, updated_at = excluded.updated_at`,
      s.id,
      s.name,
      s.builtin ? 1 : 0,
      stringifyJson(s),
      Date.now(),
    );
  }

  get(id: string): StrategyPreset | undefined {
    const r = this.db.get<{ body_json: string }>('SELECT body_json FROM strategies WHERE id = ?', id);
    return r && parseJson<StrategyPreset>(r.body_json);
  }

  list(): StrategyPreset[] {
    return this.db.all<{ body_json: string }>('SELECT body_json FROM strategies ORDER BY builtin DESC, name').map((r) => parseJson<StrategyPreset>(r.body_json));
  }

  remove(id: string): void {
    this.db.run('DELETE FROM strategies WHERE id = ? AND builtin = 0', id);
  }
}

export interface ExitRuleRecord {
  id: number;
  mint: string;
  wallets: string[];
  spec: ExitRuleSpec;
  state: ExitRuleState;
  strategyTag: string | null;
  active: boolean;
  createdAt: number;
}

export class ExitRuleRepo {
  constructor(private readonly db: Db) {}

  insert(r: { mint: string; wallets: string[]; spec: ExitRuleSpec; state: ExitRuleState; strategyTag?: string | null }): number {
    const now = Date.now();
    return this.db.run(
      'INSERT INTO exit_rules (mint, wallets_json, spec_json, state_json, strategy_tag, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      r.mint,
      JSON.stringify(r.wallets),
      stringifyJson(r.spec),
      stringifyJson(r.state),
      r.strategyTag ?? null,
      now,
      now,
    ).lastInsertRowid;
  }

  list(activeOnly = true): ExitRuleRecord[] {
    return this.db
      .all<any>(`SELECT * FROM exit_rules ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id`)
      .map((r) => ({
        id: Number(r.id),
        mint: r.mint,
        wallets: JSON.parse(r.wallets_json),
        spec: parseJson<ExitRuleSpec>(r.spec_json),
        state: parseJson<ExitRuleState>(r.state_json),
        strategyTag: r.strategy_tag,
        active: !!r.active,
        createdAt: Number(r.created_at),
      }));
  }

  updateState(id: number, state: ExitRuleState, active: boolean): void {
    this.db.run('UPDATE exit_rules SET state_json = ?, active = ?, updated_at = ? WHERE id = ?', stringifyJson(state), active ? 1 : 0, Date.now(), id);
  }

  deactivate(id: number): void {
    this.db.run('UPDATE exit_rules SET active = 0, updated_at = ? WHERE id = ?', Date.now(), id);
  }
}

export interface TriggerOrderRecord {
  id: number;
  mint: string;
  side: 'BUY' | 'SELL';
  condition: 'PRICE_LTE' | 'PRICE_GTE';
  priceSol: number;
  order: Record<string, unknown>;
  active: boolean;
  firedAt: number | null;
  createdAt: number;
}

/** Client-side limit-style orders (evaluated by the strategy runner on price ticks). */
export class TriggerOrderRepo {
  constructor(private readonly db: Db) {}

  insert(t: Omit<TriggerOrderRecord, 'id' | 'active' | 'firedAt' | 'createdAt'>): number {
    return this.db.run(
      'INSERT INTO trigger_orders (mint, side, condition, price_sol, order_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      t.mint,
      t.side,
      t.condition,
      t.priceSol,
      stringifyJson(t.order),
      Date.now(),
    ).lastInsertRowid;
  }

  list(activeOnly = true): TriggerOrderRecord[] {
    return this.db.all<any>(`SELECT * FROM trigger_orders ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id`).map((r) => ({
      id: Number(r.id),
      mint: r.mint,
      side: r.side,
      condition: r.condition,
      priceSol: r.price_sol,
      order: parseJson(r.order_json),
      active: !!r.active,
      firedAt: r.fired_at == null ? null : Number(r.fired_at),
      createdAt: Number(r.created_at),
    }));
  }

  markFired(id: number): void {
    this.db.run('UPDATE trigger_orders SET active = 0, fired_at = ? WHERE id = ?', Date.now(), id);
  }

  cancel(id: number): void {
    this.db.run('UPDATE trigger_orders SET active = 0 WHERE id = ?', id);
  }
}
