import type { Fill, Side } from '@term/core';
import { big, type Db, type Row } from '../db';

const toFill = (r: Row): Fill => ({
  id: Number(r.id),
  wallet: r.wallet as string,
  mint: r.mint as string,
  side: r.side as Side,
  tokenAmountRaw: big(r.token_amount),
  decimals: Number(r.decimals),
  lamports: big(r.lamports),
  feeLamports: big(r.fee_lamports),
  signature: (r.signature as string) ?? null,
  paper: !!r.paper,
  strategyTag: (r.strategy_tag as string) ?? null,
  planId: (r.plan_id as string) ?? null,
  at: Number(r.at),
});

export class FillRepo {
  constructor(private readonly db: Db) {}

  insert(f: Omit<Fill, 'id'>): number {
    return this.db.run(
      `INSERT INTO fills (wallet, mint, side, token_amount, decimals, lamports, fee_lamports, signature, paper, strategy_tag, plan_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      f.wallet,
      f.mint,
      f.side,
      f.tokenAmountRaw.toString(),
      f.decimals,
      f.lamports.toString(),
      f.feeLamports.toString(),
      f.signature,
      f.paper ? 1 : 0,
      f.strategyTag,
      f.planId,
      f.at,
    ).lastInsertRowid;
  }

  list(f: { paper?: boolean; wallet?: string; mint?: string } = {}): Fill[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.paper !== undefined) (where.push('paper = ?'), params.push(f.paper ? 1 : 0));
    if (f.wallet) (where.push('wallet = ?'), params.push(f.wallet));
    if (f.mint) (where.push('mint = ?'), params.push(f.mint));
    return this.db
      .all(`SELECT * FROM fills ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at ASC, id ASC`, ...params)
      .map(toFill);
  }

  /** Implements TradeActivityLookup for the self-trade guard. */
  lastTradeAt(mint: string, side: Side): number | null {
    const r = this.db.get<{ at: number | null }>('SELECT MAX(at) AS at FROM fills WHERE mint = ? AND side = ?', mint, side);
    return r?.at == null ? null : Number(r.at);
  }
}
