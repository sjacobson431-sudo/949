// Wire types: bigints arrive as decimal strings.
export type Big = string;
export type Mode = 'READ_ONLY' | 'SIMULATION' | 'LIVE';

export interface Status {
  initialized: boolean;
  unlocked: boolean;
  idleRemainingMs: number | null;
  sessionRemainingMs: number | null;
  mode: Mode;
  offline: boolean;
  walletCount: number;
  rpc: { label: string; url: string; state: string; ewmaLatencyMs: number | null; consecutiveFailures: number; lastError: string | null }[];
  solUsd: number | null;
}

export interface Wallet {
  id: number;
  publicKey: string;
  label: string;
  groupName: string | null;
  tags: string[];
  isPrimary: boolean;
  archived: boolean;
  source: string;
  createdAt: number;
}

export interface TokenBal { mint: string; tokenAccount: string; programId: string; amountRaw: Big; decimals: number }
export interface Balance { publicKey: string; lamports: Big; tokens: TokenBal[]; fetchedAt: number }

export interface Holding {
  wallet: string; mint: string; decimals: number; qtyRaw: Big; costLamports: Big; realizedLamports: Big; balanceRaw: Big;
  avgEntrySolPerToken: number; currentSolPerToken: number | null; valueLamports: Big | null; unrealizedLamports: Big | null;
  returnPct: number | null; symbol: string | null; tracked: boolean; openedAt: number | null;
}
export interface WalletView { wallet: Wallet; lamports: Big; holdings: Holding[]; valueLamports: Big; realizedLamports: Big; unrealizedLamports: Big }

export interface TokenExposure {
  mint: string; symbol: string | null; decimals: number; totalRaw: Big; avgEntrySolPerToken: number | null; currentSolPerToken: number | null;
  valueLamports: Big | null; costLamports: Big; realizedLamports: Big; unrealizedLamports: Big | null; totalPnlLamports: Big; returnPct: number | null;
  wallets: { wallet: string; label: string; raw: Big; pctOfPosition: number; avgEntrySolPerToken: number | null; unrealizedLamports: Big | null }[];
}

export interface Summary {
  paper: boolean; solUsd: number | null; totalLamports: Big; solLamports: Big; tokensLamports: Big; realizedLamports: Big;
  unrealizedLamports: Big; dailyPnlLamports: Big | null; walletCount: number; tokenCount: number; unpricedTokens: string[];
  performance: { at: number; totalLamports: Big }[];
}

export interface SimulationResult { ok: boolean; error: string | null; logs: string[]; unitsConsumed: number | null; postLamports: Big | null; postTokenRaw: Big | null }
export interface Leg {
  legId: string; kind: string; batch?: number; wallet: string; offsetMs: number; description: string; side?: string; mint?: string;
  lamportsDelta: Big; tokenDelta?: Big; estFeeLamports: Big; destination?: string;
  quote?: { inAmount: Big; outAmount: Big; minOutAmount: Big; priceImpactPct: number; routeLabel: string };
  simulation?: SimulationResult;
}
export interface Plan {
  id: string; kind: string; mode: Mode; createdAt: number; expiresAt: number; title: string; params: Record<string, any>;
  legs: Leg[]; totals: { lamportsOut: Big; lamportsIn: Big; fees: Big; tokenOut?: Big; tokenIn?: Big };
  warnings: string[]; blockers: string[]; hash: string; strategyTag: string | null;
}

export interface RiskFactor { id: string; label: string; points: number; maxPoints: number; detail: string; severity: 'ok' | 'info' | 'warn' | 'critical' }
export interface RiskReport { mint: string; score: number; grade: string; factors: RiskFactor[]; blockers: string[]; passesPolicy: boolean }
export interface Pool { dex: string; pairAddress: string; quoteSymbol: string; liquidityUsd: number; priceUsd: number; volume24hUsd: number; createdAt: number | null }
export interface TokenAnalysis {
  mint: string; symbol: string | null; name: string | null;
  mintInfo: { decimals: number; supplyRaw: Big; mintAuthority: string | null; freezeAuthority: string | null; extensions: string[]; programId: string };
  holders: { tokenAccount: string; owner: string | null; amountRaw: Big; pctOfSupply: number; isProgramOrPool: boolean }[];
  top10Pct: number; topHolderPct: number; clusteredHolderPct: number; pools: Pool[]; totalLiquidityUsd: number; priceUsd: number | null;
  marketCapUsd: number | null; fdvUsd: number | null; tokenAgeSec: number | null; liquidityChangePct: number | null;
  txns1h: { buys: number; sells: number }; txns24h: { buys: number; sells: number }; warnings: string[];
}

export interface Audit {
  id: number; planId: string | null; legId: string | null; kind: string; mode: Mode; status: string; wallet: string; signature: string | null;
  mint: string | null; side: string | null; lamportsDelta: Big; tokenDelta: Big | null; feeLamports: Big | null; details: Record<string, any>;
  error: string | null; createdAt: number; updatedAt: number;
}

export interface LegEvent { planId: string; legId: string; wallet: string; kind: string; status: string; signature?: string | null; error?: string | null; at: number }

export interface Strategy {
  id: string; name: string; builtin: boolean; perWalletLamports: Big; maxTotalLamports: Big; slippageBps: number;
  priority: { level: string; maxLamports?: Big }; timing: any; risk: Record<string, any>;
  exits: { takeProfits: { gainPct: number; sellPct: number }[]; stopLossPct?: number; trailingStopPct?: number; trailingActivationPct?: number };
}
