import { WSOL_MINT, type Fill, type PositionView, type TxAuditRecord, type WalletBalance, type WalletRecord } from '@term/core';
import type { Repositories } from '@term/database';
import { buildLedger, lotKey } from './ledger';

export interface PriceLookup {
  /** SOL per whole token (null if unknown). */
  solPrice(mint: string): number | null;
  solUsd(): number | null;
}

export function valueLamports(raw: bigint, decimals: number, solPerToken: number | null): bigint | null {
  if (solPerToken === null || !Number.isFinite(solPerToken)) return null;
  return BigInt(Math.round((Number(raw) / 10 ** decimals) * solPerToken * 1e9));
}

export interface HoldingView extends PositionView {
  /** On-chain balance (may differ from tracked qty if tokens moved outside the tool). */
  balanceRaw: bigint;
  symbol: string | null;
  tracked: boolean;
}

export interface WalletView {
  wallet: WalletRecord;
  lamports: bigint;
  holdings: HoldingView[];
  valueLamports: bigint;
  realizedLamports: bigint;
  unrealizedLamports: bigint;
}

export interface TokenExposure {
  mint: string;
  symbol: string | null;
  decimals: number;
  totalRaw: bigint;
  avgEntrySolPerToken: number | null;
  currentSolPerToken: number | null;
  valueLamports: bigint | null;
  costLamports: bigint;
  realizedLamports: bigint;
  unrealizedLamports: bigint | null;
  totalPnlLamports: bigint;
  returnPct: number | null;
  wallets: { wallet: string; label: string; raw: bigint; pctOfPosition: number; avgEntrySolPerToken: number | null; unrealizedLamports: bigint | null }[];
}

export interface PortfolioSummary {
  paper: boolean;
  solUsd: number | null;
  totalLamports: bigint;
  solLamports: bigint;
  tokensLamports: bigint;
  realizedLamports: bigint;
  unrealizedLamports: bigint;
  dailyPnlLamports: bigint | null;
  walletCount: number;
  tokenCount: number;
  unpricedTokens: string[];
  performance: { at: number; totalLamports: bigint }[];
}

/**
 * Combines live balances, recorded fills (cost basis) and prices into
 * portfolio, wallet and token views. Pure read model: no side effects except
 * `snapshot()`.
 */
export class PortfolioService {
  constructor(
    private readonly repos: Repositories,
    private readonly prices: PriceLookup,
    private readonly balances: () => WalletBalance[],
    private readonly isPaper: () => boolean,
  ) {}

  private fills(): Fill[] {
    return this.repos.fills.list({ paper: this.isPaper() });
  }

  private symbol(mint: string): string | null {
    return mint === WSOL_MINT ? 'SOL' : this.repos.snapshots.tokenMeta(mint)?.symbol ?? null;
  }

  wallets(): WalletView[] {
    const wallets = new Map(this.repos.wallets.list().map((w) => [w.publicKey, w]));
    const { lots } = buildLedger(this.fills());
    const out: WalletView[] = [];
    for (const b of this.balances()) {
      const w = wallets.get(b.publicKey);
      if (!w) continue;
      const holdings: HoldingView[] = [];
      let tokenValue = 0n;
      let unrealized = 0n;
      const mints = new Set(b.tokens.filter((t) => t.amountRaw > 0n).map((t) => t.mint));
      for (const l of lots.values()) if (l.wallet === b.publicKey && l.qtyRaw > 0n) mints.add(l.mint);
      for (const mint of mints) {
        if (mint === WSOL_MINT) continue;
        const bal = b.tokens.filter((t) => t.mint === mint).reduce((s, t) => s + t.amountRaw, 0n);
        const lot = lots.get(lotKey(b.publicKey, mint));
        const decimals = b.tokens.find((t) => t.mint === mint)?.decimals ?? lot?.decimals ?? this.repos.snapshots.tokenMeta(mint)?.decimals ?? 0;
        const view = this.positionView(lot ?? null, mint, decimals, bal, b.publicKey);
        holdings.push(view);
        tokenValue += view.valueLamports ?? 0n;
        unrealized += view.unrealizedLamports ?? 0n;
      }
      const realized = [...lots.values()].filter((l) => l.wallet === b.publicKey).reduce((s, l) => s + l.realizedLamports, 0n);
      out.push({
        wallet: w,
        lamports: b.lamports,
        holdings: holdings.sort((x, y) => Number((y.valueLamports ?? 0n) - (x.valueLamports ?? 0n))),
        valueLamports: b.lamports + tokenValue,
        realizedLamports: realized,
        unrealizedLamports: unrealized,
      });
    }
    return out;
  }

  private positionView(
    lot: ReturnType<typeof buildLedger>['lots'] extends Map<string, infer L> ? L | null : never,
    mint: string,
    decimals: number,
    balanceRaw: bigint,
    wallet: string,
  ): HoldingView {
    const price = this.prices.solPrice(mint);
    const tracked = !!lot && lot.qtyRaw > 0n;
    const qty = balanceRaw;
    const avgEntry = tracked ? Number(lot!.costLamports) / 1e9 / (Number(lot!.qtyRaw) / 10 ** decimals) : 0;
    const value = valueLamports(qty, decimals, price);
    // Unrealized only on the tracked quantity we know the cost of.
    const trackedQty = tracked ? (lot!.qtyRaw < qty ? lot!.qtyRaw : qty) : 0n;
    const trackedValue = valueLamports(trackedQty, decimals, price);
    const trackedCost = tracked && lot!.qtyRaw > 0n ? (lot!.costLamports * trackedQty) / lot!.qtyRaw : 0n;
    const unrealized = tracked && trackedValue !== null ? trackedValue - trackedCost : null;
    return {
      wallet,
      mint,
      decimals,
      qtyRaw: lot?.qtyRaw ?? 0n,
      costLamports: lot?.costLamports ?? 0n,
      realizedLamports: lot?.realizedLamports ?? 0n,
      openedAt: lot?.openedAt ?? null,
      buys: lot?.buys ?? 0,
      sells: lot?.sells ?? 0,
      avgEntrySolPerToken: avgEntry,
      currentSolPerToken: price,
      valueLamports: value,
      unrealizedLamports: unrealized,
      returnPct: unrealized !== null && trackedCost > 0n ? (Number(unrealized) / Number(trackedCost)) * 100 : null,
      balanceRaw,
      symbol: this.symbol(mint),
      tracked,
    };
  }

  tokens(): TokenExposure[] {
    const views = this.wallets();
    const { lots } = buildLedger(this.fills());
    const byMint = new Map<string, TokenExposure>();
    for (const wv of views) {
      for (const h of wv.holdings) {
        let e = byMint.get(h.mint);
        if (!e) {
          e = {
            mint: h.mint, symbol: h.symbol, decimals: h.decimals, totalRaw: 0n, avgEntrySolPerToken: null,
            currentSolPerToken: h.currentSolPerToken, valueLamports: 0n, costLamports: 0n, realizedLamports: 0n,
            unrealizedLamports: 0n, totalPnlLamports: 0n, returnPct: null, wallets: [],
          };
          byMint.set(h.mint, e);
        }
        e.totalRaw += h.balanceRaw;
        e.valueLamports = e.valueLamports === null || h.valueLamports === null ? null : e.valueLamports + h.valueLamports;
        e.costLamports += h.costLamports;
        if (h.unrealizedLamports !== null) e.unrealizedLamports = (e.unrealizedLamports ?? 0n) + h.unrealizedLamports;
        e.wallets.push({
          wallet: wv.wallet.publicKey, label: wv.wallet.label, raw: h.balanceRaw, pctOfPosition: 0,
          avgEntrySolPerToken: h.tracked ? h.avgEntrySolPerToken : null, unrealizedLamports: h.unrealizedLamports,
        });
      }
    }
    // realized P&L includes closed positions no longer held
    for (const l of lots.values()) {
      const e = byMint.get(l.mint);
      if (e) e.realizedLamports += l.realizedLamports;
    }
    for (const e of byMint.values()) {
      const trackedQty = [...lots.values()].filter((l) => l.mint === e.mint).reduce((s, l) => s + l.qtyRaw, 0n);
      e.avgEntrySolPerToken = trackedQty > 0n ? Number(e.costLamports) / 1e9 / (Number(trackedQty) / 10 ** e.decimals) : null;
      e.totalPnlLamports = e.realizedLamports + (e.unrealizedLamports ?? 0n);
      const invested = e.costLamports;
      e.returnPct = invested > 0n && e.unrealizedLamports !== null ? (Number(e.unrealizedLamports) / Number(invested)) * 100 : null;
      for (const w of e.wallets) w.pctOfPosition = e.totalRaw > 0n ? Number((w.raw * 10_000n) / e.totalRaw) / 100 : 0;
      e.wallets.sort((a, b) => (b.raw > a.raw ? 1 : -1));
    }
    return [...byMint.values()].sort((a, b) => Number((b.valueLamports ?? 0n) - (a.valueLamports ?? 0n)));
  }

  token(mint: string): TokenExposure | undefined {
    return this.tokens().find((t) => t.mint === mint);
  }

  summary(): PortfolioSummary {
    const views = this.wallets();
    const { lots } = buildLedger(this.fills());
    const sol = views.reduce((s, w) => s + w.lamports, 0n);
    const total = views.reduce((s, w) => s + w.valueLamports, 0n);
    const unpriced = new Set<string>();
    for (const w of views) for (const h of w.holdings) if (h.valueLamports === null && h.balanceRaw > 0n) unpriced.add(h.mint);
    const paper = this.isPaper();
    const history = this.repos.snapshots.portfolioHistory(Date.now() - 30 * 86_400_000, paper);
    const dayAgo = Date.now() - 86_400_000;
    const ref = [...history].reverse().find((h) => h.at <= dayAgo) ?? history[0];
    return {
      paper,
      solUsd: this.prices.solUsd(),
      totalLamports: total,
      solLamports: sol,
      tokensLamports: total - sol,
      realizedLamports: [...lots.values()].reduce((s, l) => s + l.realizedLamports, 0n),
      unrealizedLamports: views.reduce((s, w) => s + w.unrealizedLamports, 0n),
      dailyPnlLamports: ref ? total - ref.total : null,
      walletCount: views.length,
      tokenCount: new Set(views.flatMap((w) => w.holdings.map((h) => h.mint))).size,
      unpricedTokens: [...unpriced],
      performance: history.map((h) => ({ at: h.at, totalLamports: h.total })),
    };
  }

  snapshot(): void {
    const s = this.summary();
    this.repos.snapshots.addPortfolio({
      at: Date.now(), paper: s.paper, total: s.totalLamports, sol: s.solLamports, tokens: s.tokensLamports,
      realized: s.realizedLamports, unrealized: s.unrealizedLamports, solUsd: s.solUsd,
    });
  }

  walletHistory(wallet: string, limit = 100): TxAuditRecord[] {
    return this.repos.audit.list({ wallet, limit });
  }
}
