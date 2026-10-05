import { solToLamports, type StrategyPreset } from '@term/core';

export const CONSERVATIVE: StrategyPreset = {
  id: 'conservative',
  name: 'Conservative',
  builtin: true,
  perWalletLamports: solToLamports('0.05'),
  maxTotalLamports: solToLamports('1'),
  slippageBps: 100,
  priority: { level: 'low' },
  timing: { kind: 'staggered', intervalMs: 4_000, jitterMs: 1_500, concurrency: 2 },
  risk: {
    maxScore: 40,
    minLiquidityUsd: 50_000,
    maxTop10Pct: 35,
    maxPriceImpactPct: 1.5,
    requireMintAuthorityRevoked: true,
    requireFreezeAuthorityRevoked: true,
    minTokenAgeSec: 24 * 3600,
  },
  exits: {
    takeProfits: [
      { gainPct: 30, sellPct: 33 },
      { gainPct: 60, sellPct: 33 },
    ],
    stopLossPct: 15,
    trailingStopPct: 12,
    trailingActivationPct: 20,
  },
};

export const AGGRESSIVE: StrategyPreset = {
  id: 'aggressive',
  name: 'Aggressive',
  builtin: true,
  perWalletLamports: solToLamports('0.25'),
  maxTotalLamports: solToLamports('10'),
  slippageBps: 1_500,
  priority: { level: 'high' },
  timing: { kind: 'simultaneous', concurrency: 16 },
  risk: {
    maxScore: 75,
    minLiquidityUsd: 5_000,
    maxTop10Pct: 60,
    maxPriceImpactPct: 8,
    requireMintAuthorityRevoked: true,
    requireFreezeAuthorityRevoked: true,
    minTokenAgeSec: 0,
  },
  exits: {
    takeProfits: [
      { gainPct: 50, sellPct: 25 },
      { gainPct: 100, sellPct: 25 },
      { gainPct: 200, sellPct: 25 },
    ],
    stopLossPct: 35,
  },
};

/** Starting point for user-defined strategies: every field is editable. */
export const CUSTOM_TEMPLATE: StrategyPreset = {
  ...CONSERVATIVE,
  id: 'custom',
  name: 'Custom',
  builtin: false,
};

export const BUILTIN_PRESETS = [CONSERVATIVE, AGGRESSIVE];
