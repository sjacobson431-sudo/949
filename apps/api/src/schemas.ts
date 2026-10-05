import { z } from 'zod';
import { OPERATING_MODES } from '@term/core';

/** bigint from a decimal-integer string or safe integer (lamports / raw token units). */
export const big = z
  .union([z.string().regex(/^\d+$/, 'expected an integer string'), z.number().int().nonnegative()])
  .transform((v) => BigInt(v));

export const pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'invalid public key');

export const priority = z.object({
  level: z.enum(['none', 'low', 'medium', 'high', 'turbo', 'custom']),
  maxLamports: big.optional(),
});

export const timing = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('simultaneous'), concurrency: z.number().int().min(1).max(64) }),
  z.object({
    kind: z.literal('staggered'),
    intervalMs: z.number().int().min(0).max(600_000),
    jitterMs: z.number().int().min(0).max(600_000),
    concurrency: z.number().int().min(1).max(64).optional(),
  }),
]);

export const allocation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('equal') }),
  z.object({ kind: z.literal('percentage'), pcts: z.record(z.string(), z.number().min(0).max(100)) }),
  z.object({ kind: z.literal('weighted'), weights: z.record(z.string(), z.number().min(0)) }),
  z.object({ kind: z.literal('random'), min: big, max: big, seed: z.number().int().optional() }),
]);

export const sizing = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), amount: big }),
  z.object({ kind: z.literal('percentOfWallet'), pct: z.number().gt(0).max(100) }),
  z.object({ kind: z.literal('perWallet'), amounts: z.record(z.string(), big) }),
  z.object({ kind: z.literal('total'), total: big, allocation }),
]);

export const password = z.string().min(1).max(1024);

export const modeBody = z.object({ mode: z.enum(OPERATING_MODES as [string, ...string[]]), password: password.optional() });

export const generateBody = z.object({
  count: z.number().int().min(1).max(500),
  group: z.string().max(64).nullish(),
  labelPrefix: z.string().max(24).optional(),
  tags: z.array(z.string().max(32)).max(20).optional(),
});

export const importBody = z.object({ secret: z.string().min(32).max(2000), label: z.string().max(64).optional(), group: z.string().max(64).nullish() });

export const walletPatch = z.object({
  label: z.string().min(1).max(64).optional(),
  groupName: z.string().max(64).nullable().optional(),
  tags: z.array(z.string().max(32)).max(20).optional(),
  archived: z.boolean().optional(),
});

export const distributeBody = z.object({
  source: pubkey.optional(),
  recipients: z.array(pubkey).min(1).max(1000),
  total: big,
  spec: allocation,
  constraints: z.object({ minWalletBalance: big.optional(), maxWalletBalance: big.optional(), sourceReserve: big.optional() }).optional(),
  gasReserve: z.union([z.literal('auto'), big]).optional(),
  autoGas: z.object({ expectedTxs: z.number().int().min(1).max(1000), newTokenAccounts: z.number().int().min(0).max(100) }).optional(),
  priority,
  simulate: z.boolean().optional(),
});

export const tradeBody = z.object({
  mint: pubkey,
  side: z.enum(['BUY', 'SELL']),
  wallets: z.array(pubkey).min(1).max(1000),
  sizing,
  timing,
  slippageBps: z.number().int().min(1).max(5000),
  priority,
  strategyTag: z.string().max(64).nullish(),
  maxPriceImpactPct: z.number().positive().max(100).optional(),
  gasReserve: big.optional(),
  simulate: z.boolean().optional(),
  /** When true, the token must pass the risk policy (blockers become plan blockers). */
  enforceRisk: z.boolean().optional(),
});

export const execDefaults = { slippageBps: z.number().int().min(1).max(5000), priority, timing };

export const exitSpec = z.object({
  takeProfits: z.array(z.object({ gainPct: z.number().positive(), sellPct: z.number().gt(0).max(100) })).max(10),
  stopLossPct: z.number().gt(0).lt(100).optional(),
  trailingStopPct: z.number().gt(0).lt(100).optional(),
  trailingActivationPct: z.number().min(0).optional(),
});

export const riskPolicy = z.object({
  maxScore: z.number().min(0).max(100),
  minLiquidityUsd: z.number().min(0),
  maxTop10Pct: z.number().min(0).max(100),
  maxPriceImpactPct: z.number().min(0).max(100),
  requireMintAuthorityRevoked: z.boolean(),
  requireFreezeAuthorityRevoked: z.boolean(),
  minTokenAgeSec: z.number().min(0),
});

export const strategyBody = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(64),
  perWalletLamports: big,
  maxTotalLamports: big,
  slippageBps: z.number().int().min(1).max(5000),
  priority,
  timing,
  risk: riskPolicy,
  exits: exitSpec,
});

export const securityPatch = z.object({
  limits: z.object({ perTxLamports: big.optional(), perWalletDailyLamports: big.optional(), globalDailyLamports: big.optional() }).optional(),
  whitelistEnabled: z.boolean().optional(),
  requireConfirmation: z.boolean().optional(),
  idleLockMinutes: z.number().int().min(1).max(240).optional(),
  maxSessionHours: z.number().int().min(1).max(72).optional(),
  selfTradeCooldownSec: z.number().int().min(0).max(86_400).optional(),
  planTtlSec: z.number().int().min(10).max(600).optional(),
});
