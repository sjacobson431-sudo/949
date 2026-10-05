import type { RiskFactor, RiskPolicy, RiskReport, TokenAnalysis } from '@term/core';

export type FactorId =
  | 'liquidity'
  | 'mint_authority'
  | 'freeze_authority'
  | 'top10'
  | 'top_holder'
  | 'clustered_holders'
  | 'token_age'
  | 'liquidity_change'
  | 'mcap_liquidity'
  | 'buy_sell_ratio'
  | 'activity'
  | 'token_extensions';

/** Default max points per factor; they sum to 100. */
export const DEFAULT_WEIGHTS: Record<FactorId, number> = {
  liquidity: 18,
  mint_authority: 14,
  freeze_authority: 12,
  top10: 12,
  top_holder: 6,
  clustered_holders: 8,
  token_age: 6,
  liquidity_change: 6,
  mcap_liquidity: 4,
  buy_sell_ratio: 4,
  activity: 4,
  token_extensions: 6,
};

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  maxScore: 60,
  minLiquidityUsd: 10_000,
  maxTop10Pct: 50,
  maxPriceImpactPct: 5,
  requireMintAuthorityRevoked: true,
  requireFreezeAuthorityRevoked: true,
  minTokenAgeSec: 0,
};

const DANGEROUS_EXTENSIONS = new Set(['permanentDelegate', 'transferHook', 'nonTransferable', 'defaultAccountState']);
const COSTLY_EXTENSIONS = new Set(['transferFeeConfig', 'confidentialTransferMint', 'pausableConfig']);

/** A sub-score in [0,1] with a human explanation. */
interface Sub {
  frac: number;
  detail: string;
}

type Scorer = (a: TokenAnalysis) => Sub;

const usd = (x: number | null) => (x === null ? 'n/a' : `$${Math.round(x).toLocaleString('en-US')}`);
const fmtAge = (s: number) => (s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`);

const SCORERS: Record<FactorId, { label: string; score: Scorer }> = {
  liquidity: {
    label: 'Liquidity depth',
    score: (a) => {
      const l = a.totalLiquidityUsd;
      const frac = a.pools.length === 0 ? 1 : l < 5_000 ? 1 : l < 20_000 ? 0.75 : l < 50_000 ? 0.45 : l < 150_000 ? 0.2 : 0;
      return { frac, detail: a.pools.length ? `${usd(l)} across ${a.pools.length} pool(s)` : 'no pools found' };
    },
  },
  mint_authority: {
    label: 'Mint authority',
    score: (a) =>
      a.mintInfo.mintAuthority
        ? { frac: 1, detail: `active (${a.mintInfo.mintAuthority.slice(0, 6)}…): supply can be inflated` }
        : { frac: 0, detail: 'revoked' },
  },
  freeze_authority: {
    label: 'Freeze authority',
    score: (a) =>
      a.mintInfo.freezeAuthority
        ? { frac: 1, detail: `active (${a.mintInfo.freezeAuthority.slice(0, 6)}…): your token accounts can be frozen` }
        : { frac: 0, detail: 'revoked' },
  },
  top10: {
    label: 'Top-10 holder concentration',
    score: (a) => {
      const p = a.top10Pct;
      return { frac: p > 60 ? 1 : p > 50 ? 0.8 : p > 35 ? 0.55 : p > 25 ? 0.3 : 0, detail: `${p.toFixed(1)}% of supply (excl. pools)` };
    },
  },
  top_holder: {
    label: 'Largest holder',
    score: (a) => {
      const p = a.topHolderPct;
      return { frac: p > 20 ? 1 : p > 10 ? 0.6 : p > 5 ? 0.25 : 0, detail: `${p.toFixed(1)}% of supply` };
    },
  },
  clustered_holders: {
    label: 'Suspicious wallet concentration',
    score: (a) => {
      const p = a.clusteredHolderPct;
      return {
        frac: p > 20 ? 1 : p > 10 ? 0.6 : p > 5 ? 0.25 : 0,
        detail: p > 0 ? `${p.toFixed(1)}% of supply in look-alike / same-owner holder clusters` : 'no clusters detected among top holders',
      };
    },
  },
  token_age: {
    label: 'Token age',
    score: (a) => {
      if (a.tokenAgeSec === null) return { frac: 0.5, detail: 'unknown' };
      const s = a.tokenAgeSec;
      return { frac: s < 3600 ? 1 : s < 86_400 ? 0.6 : s < 7 * 86_400 ? 0.3 : 0, detail: fmtAge(s) };
    },
  },
  liquidity_change: {
    label: 'Liquidity change',
    score: (a) => {
      const c = a.liquidityChangePct;
      if (c === null) return { frac: 0, detail: 'no previous snapshot' };
      return { frac: c < -30 ? 1 : c < -10 ? 0.5 : 0, detail: `${c >= 0 ? '+' : ''}${c.toFixed(1)}% since last analysis` };
    },
  },
  mcap_liquidity: {
    label: 'Market cap / liquidity',
    score: (a) => {
      const mc = a.marketCapUsd ?? a.fdvUsd;
      if (!mc || a.totalLiquidityUsd <= 0) return { frac: 0.5, detail: 'unknown' };
      const r = mc / a.totalLiquidityUsd;
      return { frac: r > 25 ? 1 : r > 10 ? 0.5 : 0, detail: `MC ${usd(mc)} is ${r.toFixed(1)}× liquidity (FDV ${usd(a.fdvUsd)})` };
    },
  },
  buy_sell_ratio: {
    label: 'Buy/sell ratio (1h)',
    score: (a) => {
      const { buys, sells } = a.txns1h;
      const n = buys + sells;
      if (n < 10) return { frac: 0.25, detail: `only ${n} trades in 1h` };
      const r = buys / n;
      const frac = r < 0.3 ? 1 : r < 0.4 ? 0.5 : r > 0.92 ? 0.5 : 0;
      return { frac, detail: `${buys} buys / ${sells} sells (${Math.round(r * 100)}% buys)${r > 0.92 ? ' — unusually one-sided' : ''}` };
    },
  },
  activity: {
    label: 'Transaction activity (24h)',
    score: (a) => {
      const n = a.txns24h.buys + a.txns24h.sells;
      return { frac: n < 20 ? 1 : n < 100 ? 0.5 : 0, detail: `${n} trades in 24h` };
    },
  },
  token_extensions: {
    label: 'Token-2022 extensions',
    score: (a) => {
      const ex = a.mintInfo.extensions;
      const bad = ex.filter((e) => DANGEROUS_EXTENSIONS.has(e));
      const costly = ex.filter((e) => COSTLY_EXTENSIONS.has(e));
      if (bad.length) return { frac: 1, detail: `dangerous: ${bad.join(', ')}` };
      if (costly.length) return { frac: 0.5, detail: `fees/restrictions: ${costly.join(', ')}` };
      return { frac: 0, detail: ex.length ? `benign: ${ex.join(', ')}` : 'none' };
    },
  },
};

export interface RiskConfig {
  policy?: Partial<RiskPolicy>;
  /** Relative weights per factor; normalised so the max score stays 100. */
  weights?: Partial<Record<FactorId, number>>;
}

/** Score a token 0 (safest) … 100 (riskiest) and explain every contribution. */
export function scoreToken(a: TokenAnalysis, cfg: RiskConfig = {}): RiskReport {
  const policy: RiskPolicy = { ...DEFAULT_RISK_POLICY, ...cfg.policy };
  const raw: Record<FactorId, number> = { ...DEFAULT_WEIGHTS, ...cfg.weights };
  const totalWeight = Object.values(raw).reduce((s, w) => s + Math.max(0, w), 0) || 1;

  const factors: RiskFactor[] = (Object.keys(SCORERS) as FactorId[]).map((id) => {
    const maxPoints = round1((Math.max(0, raw[id]) / totalWeight) * 100);
    const { frac, detail } = SCORERS[id].score(a);
    const points = round1(maxPoints * frac);
    return {
      id,
      label: SCORERS[id].label,
      points,
      maxPoints,
      detail,
      severity: frac >= 0.99 && maxPoints >= 10 ? 'critical' : frac >= 0.5 ? 'warn' : frac > 0 ? 'info' : 'ok',
    };
  });
  const score = Math.min(100, Math.round(factors.reduce((s, f) => s + f.points, 0)));

  const blockers: string[] = [];
  if (!a.pools.length) blockers.push('No liquidity pool found');
  if (policy.requireMintAuthorityRevoked && a.mintInfo.mintAuthority) blockers.push('Mint authority is not revoked');
  if (policy.requireFreezeAuthorityRevoked && a.mintInfo.freezeAuthority) blockers.push('Freeze authority is not revoked');
  if (a.totalLiquidityUsd < policy.minLiquidityUsd) blockers.push(`Liquidity ${usd(a.totalLiquidityUsd)} < policy minimum ${usd(policy.minLiquidityUsd)}`);
  if (a.top10Pct > policy.maxTop10Pct) blockers.push(`Top-10 holders own ${a.top10Pct.toFixed(1)}% > policy max ${policy.maxTop10Pct}%`);
  if (policy.minTokenAgeSec > 0 && (a.tokenAgeSec ?? 0) < policy.minTokenAgeSec) blockers.push(`Token younger than policy minimum (${fmtAge(policy.minTokenAgeSec)})`);
  if (a.mintInfo.extensions.includes('permanentDelegate')) blockers.push('Permanent delegate can move tokens out of any account');
  if (a.mintInfo.extensions.includes('nonTransferable')) blockers.push('Token is non-transferable');
  if (score > policy.maxScore) blockers.push(`Risk score ${score} > policy max ${policy.maxScore}`);

  const grade = score < 25 ? 'LOW' : score < 50 ? 'MODERATE' : score < 75 ? 'HIGH' : 'EXTREME';
  return { mint: a.mint, score, grade, factors: factors.sort((x, y) => y.points - x.points), blockers, passesPolicy: blockers.length === 0 };
}

/** Additional pre-trade check using a real quote's price impact. */
export function checkPriceImpact(priceImpactPct: number, policy: Partial<RiskPolicy> = {}): string | null {
  const max = policy.maxPriceImpactPct ?? DEFAULT_RISK_POLICY.maxPriceImpactPct;
  return priceImpactPct > max ? `Price impact ${priceImpactPct.toFixed(2)}% > policy max ${max}%` : null;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
