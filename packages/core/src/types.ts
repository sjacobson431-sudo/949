/**
 * Shared domain model. All on-chain quantities are `bigint` (lamports or raw
 * token base units). Floats are only used for prices, percentages and display.
 */

export type OperatingMode = 'READ_ONLY' | 'SIMULATION' | 'LIVE';
export const OPERATING_MODES: readonly OperatingMode[] = ['READ_ONLY', 'SIMULATION', 'LIVE'];

export type Base58 = string;

// ---------------------------------------------------------------- wallets

export type WalletSource = 'generated' | 'imported';

export interface WalletRecord {
  id: number;
  publicKey: Base58;
  label: string;
  groupName: string | null;
  tags: string[];
  isPrimary: boolean;
  archived: boolean;
  source: WalletSource;
  createdAt: number;
}

export interface TokenBalance {
  mint: Base58;
  tokenAccount: Base58;
  programId: Base58;
  amountRaw: bigint;
  decimals: number;
}

export interface WalletBalance {
  publicKey: Base58;
  lamports: bigint;
  tokens: TokenBalance[];
  fetchedAt: number;
}

// ---------------------------------------------------------------- prices / tokens

export interface PriceQuote {
  mint: Base58;
  /** USD per 1 whole token. */
  usd: number;
  /** SOL per 1 whole token (derived from the SOL/USD price). */
  sol: number;
  at: number;
  source: string;
}

export interface MintInfo {
  mint: Base58;
  programId: Base58;
  decimals: number;
  supplyRaw: bigint;
  mintAuthority: Base58 | null;
  freezeAuthority: Base58 | null;
  /** Token-2022 extensions present on the mint (names only). */
  extensions: string[];
}

export interface HolderInfo {
  tokenAccount: Base58;
  owner: Base58 | null;
  amountRaw: bigint;
  pctOfSupply: number;
  /** Known program-owned (LP vault, burn, etc.) — excluded from concentration. */
  isProgramOrPool: boolean;
}

export interface PoolInfo {
  dex: string;
  pairAddress: Base58;
  baseMint: Base58;
  quoteMint: Base58;
  quoteSymbol: string;
  liquidityUsd: number;
  priceUsd: number;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  createdAt: number | null;
  volume24hUsd: number;
  txns1h: { buys: number; sells: number };
  txns24h: { buys: number; sells: number };
  priceChange1hPct: number | null;
}

export interface TokenAnalysis {
  mint: Base58;
  symbol: string | null;
  name: string | null;
  mintInfo: MintInfo;
  holders: HolderInfo[];
  top10Pct: number;
  /** Largest single non-pool holder %. */
  topHolderPct: number;
  /** Holders that share an owner or a recent common funder (heuristic). */
  clusteredHolderPct: number;
  pools: PoolInfo[];
  totalLiquidityUsd: number;
  priceUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  tokenAgeSec: number | null;
  /** % change of total liquidity vs the previous snapshot, if any. */
  liquidityChangePct: number | null;
  txns1h: { buys: number; sells: number };
  txns24h: { buys: number; sells: number };
  analyzedAt: number;
  warnings: string[];
}

// ---------------------------------------------------------------- risk

export interface RiskFactor {
  id: string;
  label: string;
  /** Points added to the risk score (0 = no risk contribution). */
  points: number;
  maxPoints: number;
  detail: string;
  severity: 'ok' | 'info' | 'warn' | 'critical';
}

export interface RiskReport {
  mint: Base58;
  /** 0 = lowest risk, 100 = highest risk. */
  score: number;
  grade: 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME';
  factors: RiskFactor[];
  /** Hard blocks — trading should be refused regardless of score. */
  blockers: string[];
  passesPolicy: boolean;
}

// ---------------------------------------------------------------- trading

export type Side = 'BUY' | 'SELL';
export type PriorityLevel = 'none' | 'low' | 'medium' | 'high' | 'turbo' | 'custom';

export interface PrioritySettings {
  level: PriorityLevel;
  /** Used when level === 'custom'. Total priority fee cap per tx, lamports. */
  maxLamports?: bigint;
}

export type OrderSizing =
  | { kind: 'fixed'; /** lamports for BUY, raw token units for SELL */ amount: bigint }
  | { kind: 'percentOfWallet'; pct: number }
  /** Explicit amount per wallet (lamports for BUY, raw tokens for SELL). */
  | { kind: 'perWallet'; amounts: Record<Base58, bigint> }
  | { kind: 'total'; total: bigint; allocation: AllocationSpec };

export type ExecutionTiming =
  | { kind: 'simultaneous'; concurrency: number }
  | { kind: 'staggered'; intervalMs: number; jitterMs: number; concurrency?: number };

export interface SwapQuote {
  provider: string;
  inputMint: Base58;
  outputMint: Base58;
  inAmount: bigint;
  outAmount: bigint;
  /** Worst-case output after slippage. */
  minOutAmount: bigint;
  slippageBps: number;
  priceImpactPct: number;
  routeLabel: string;
  raw: unknown;
  quotedAt: number;
}

// ---------------------------------------------------------------- allocation

export type AllocationSpec =
  | { kind: 'equal' }
  | { kind: 'percentage'; /** walletPublicKey -> percent (sums to 100) */ pcts: Record<Base58, number> }
  /** Each wallet receives a uniform random amount in [min, max]; the total is the sum. */
  | { kind: 'random'; min: bigint; max: bigint; seed?: number }
  | { kind: 'weighted'; weights: Record<Base58, number> };

export interface AllocationConstraints {
  /** Destination must end with at least this much (top-up semantics). */
  minWalletBalance?: bigint;
  /** Destination may not exceed this balance. */
  maxWalletBalance?: bigint;
  /** Lamports to leave in the source wallet after all transfers + fees. */
  sourceReserve?: bigint;
}

// ---------------------------------------------------------------- plans & audit

export type PlanKind = 'DISTRIBUTE' | 'TRADE' | 'CONSOLIDATE' | 'CLOSE_ACCOUNTS' | 'EXIT';
export type PlanStatus = 'PREVIEW' | 'EXECUTING' | 'DONE' | 'PARTIAL' | 'FAILED' | 'EXPIRED' | 'CANCELLED';

export type TxKind = 'SOL_TRANSFER' | 'TOKEN_TRANSFER' | 'SWAP' | 'CLOSE_ACCOUNT';
export type TxStatus =
  | 'PLANNED'
  | 'SIMULATED'
  | 'SIM_FAILED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'EXPIRED'
  | 'SKIPPED'
  | 'PAPER_FILLED';

export interface PlannedTx {
  /** Stable id inside the plan (e.g. "t0007"). */
  legId: string;
  kind: TxKind;
  /** Legs sharing a batch number are sent in one transaction. */
  batch?: number;
  wallet: Base58;
  /** Scheduled offset from execution start, ms. */
  offsetMs: number;
  description: string;
  side?: Side;
  mint?: Base58;
  /** SOL leaving (+) / entering (−) the signer wallet, excluding fees. */
  lamportsDelta: bigint;
  tokenDelta?: bigint;
  estFeeLamports: bigint;
  destination?: Base58;
  quote?: SwapQuote;
  simulation?: SimulationResult;
  /** Kind-specific execution data (token accounts, sweep reserve, …). */
  details?: Record<string, unknown>;
}

export interface SimulationResult {
  ok: boolean;
  error: string | null;
  logs: string[];
  unitsConsumed: number | null;
  /** Expected balances after execution for the signer wallet. */
  postLamports: bigint | null;
  postTokenRaw: bigint | null;
}

export interface Plan {
  id: string;
  kind: PlanKind;
  mode: OperatingMode;
  createdAt: number;
  expiresAt: number;
  title: string;
  params: Record<string, unknown>;
  legs: PlannedTx[];
  totals: {
    lamportsOut: bigint;
    lamportsIn: bigint;
    fees: bigint;
    tokenOut?: bigint;
    tokenIn?: bigint;
  };
  warnings: string[];
  /** Hard problems (limits, policy, insufficient funds): the plan cannot execute. */
  blockers: string[];
  /** SHA-256 over the canonical plan body: the confirmation token. */
  hash: string;
  strategyTag: string | null;
}

export interface TxAuditRecord {
  id: number;
  planId: string | null;
  legId: string | null;
  kind: TxKind;
  mode: OperatingMode;
  status: TxStatus;
  wallet: Base58;
  signature: string | null;
  mint: Base58 | null;
  side: Side | null;
  lamportsDelta: bigint;
  tokenDelta: bigint | null;
  feeLamports: bigint | null;
  details: Record<string, unknown>;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------- portfolio

export interface Fill {
  id: number;
  wallet: Base58;
  mint: Base58;
  side: Side;
  tokenAmountRaw: bigint;
  decimals: number;
  /** SOL spent (BUY) or received (SELL), excluding network fees. */
  lamports: bigint;
  feeLamports: bigint;
  signature: string | null;
  paper: boolean;
  strategyTag: string | null;
  planId: string | null;
  at: number;
}

export interface PositionLot {
  wallet: Base58;
  mint: Base58;
  decimals: number;
  qtyRaw: bigint;
  /** Average cost of the open quantity, in lamports (incl. buy fees). */
  costLamports: bigint;
  realizedLamports: bigint;
  /** Weighted average acquisition time of the open quantity. */
  openedAt: number | null;
  buys: number;
  sells: number;
}

export interface PositionView extends PositionLot {
  avgEntrySolPerToken: number;
  currentSolPerToken: number | null;
  valueLamports: bigint | null;
  unrealizedLamports: bigint | null;
  returnPct: number | null;
}

// ---------------------------------------------------------------- strategies & exits

export interface TakeProfitTier {
  /** Trigger at +X% vs average entry. */
  gainPct: number;
  /** Sell this % of the position size at rule creation. */
  sellPct: number;
}

export interface ExitRuleSpec {
  takeProfits: TakeProfitTier[];
  /** Exit everything at −X% (positive number). */
  stopLossPct?: number;
  /** Exit everything if price falls X% from the peak since activation. */
  trailingStopPct?: number;
  /** Only arm the trailing stop once the position is up at least this %. */
  trailingActivationPct?: number;
}

export interface ExitRuleState {
  baselineQtyRaw: bigint;
  /** Position size per wallet when the rule was created (staged exits are % of this). */
  baselineByWallet: Record<Base58, bigint>;
  peakSolPerToken: number;
  firedTiers: number[];
  stopped: boolean;
}

export interface StrategyPreset {
  id: string;
  name: string;
  builtin: boolean;
  /** Per-wallet position size, lamports. */
  perWalletLamports: bigint;
  maxTotalLamports: bigint;
  slippageBps: number;
  priority: PrioritySettings;
  timing: ExecutionTiming;
  risk: RiskPolicy;
  exits: ExitRuleSpec;
}

export interface RiskPolicy {
  maxScore: number;
  minLiquidityUsd: number;
  maxTop10Pct: number;
  maxPriceImpactPct: number;
  requireMintAuthorityRevoked: boolean;
  requireFreezeAuthorityRevoked: boolean;
  minTokenAgeSec: number;
}

// ---------------------------------------------------------------- security settings

export interface SpendingLimits {
  /** Max SOL leaving any wallet in a single tx (lamports). */
  perTxLamports: bigint;
  /** Max SOL leaving a single wallet per rolling 24h. */
  perWalletDailyLamports: bigint;
  /** Max SOL leaving all wallets combined per rolling 24h (swaps + external transfers). */
  globalDailyLamports: bigint;
}

export interface SecuritySettings {
  limits: SpendingLimits;
  whitelistEnabled: boolean;
  requireConfirmation: boolean;
  idleLockMinutes: number;
  maxSessionHours: number;
  selfTradeCooldownSec: number;
  planTtlSec: number;
}
