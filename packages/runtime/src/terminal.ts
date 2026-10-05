import {
  createLogger,
  errorMessage,
  TerminalError,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  type Logger,
  type OperatingMode,
  type RiskReport,
  type SecuritySettings,
  type TokenAnalysis,
  type WalletBalance,
} from '@term/core';
import { openDatabase, type Repositories } from '@term/database';
import { ExecutionEngine, type TokenInfo } from '@term/execution-engine';
import { PortfolioService } from '@term/portfolio';
import { PositionManager } from '@term/position-manager';
import { JupiterPriceProvider, PriceService, StaticPriceProvider } from '@term/price-service';
import { scoreToken, type RiskConfig } from '@term/risk-engine';
import { DEFAULT_LIMITS, DestinationPolicy, ModeGuard, SelfTradeGuard, SessionManager, SpendingLimiter, Vault } from '@term/security';
import { RpcPool, SolanaClient } from '@term/solana-client';
import { DexScreenerProvider, StaticMarketDataProvider, TokenAnalyzer, type MarketDataProvider, type TokenChainReader } from '@term/token-analysis';
import { BUILTIN_PRESETS, JupiterSwapProvider, MockSwapProvider, type SwapProvider } from '@term/trade-engine';
import { TransactionSigner, WalletManager } from '@term/wallet-manager';
import type { RuntimeConfig } from './config';

export const DEFAULT_SECURITY: SecuritySettings = {
  limits: DEFAULT_LIMITS,
  whitelistEnabled: true,
  requireConfirmation: true,
  idleLockMinutes: 15,
  maxSessionHours: 12,
  selfTradeCooldownSec: 120,
  planTtlSec: 60,
};

/** Offline chain reader backed by token_meta (paper mode without RPC). */
class OfflineChainReader implements TokenChainReader {
  constructor(private readonly repos: Repositories) {}
  async getMintInfo(mint: string) {
    const m = this.repos.snapshots.tokenMeta(mint);
    if (!m) throw new TerminalError('NOT_FOUND', `Unknown mint ${mint} (offline mode: seed it first)`);
    return { mint, programId: TOKEN_PROGRAM_ID, decimals: m.decimals, supplyRaw: 0n, mintAuthority: null, freezeAuthority: null, extensions: [] };
  }
  async getLargestHolders() {
    return [];
  }
}

/**
 * Composition root: builds every service from config. Used by the CLI
 * (in-process) and the API server (long-running).
 */
export class Terminal {
  readonly log: Logger;
  readonly repos: Repositories;
  readonly vault: Vault;
  readonly session: SessionManager;
  readonly mode: ModeGuard;
  readonly client: SolanaClient | null;
  readonly pool: RpcPool | null;
  readonly wallets: WalletManager;
  readonly signer: TransactionSigner;
  readonly prices: PriceService;
  readonly swap: SwapProvider;
  readonly market: MarketDataProvider;
  readonly analyzer: TokenAnalyzer;
  readonly limiter: SpendingLimiter;
  readonly destinations: DestinationPolicy;
  readonly selfTrade: SelfTradeGuard;
  readonly engine: ExecutionEngine;
  readonly portfolio: PortfolioService;
  readonly positions: PositionManager;
  private readonly tokenInfoCache = new Map<string, TokenInfo>();
  private snapshotTimer: NodeJS.Timeout | null = null;

  constructor(readonly config: RuntimeConfig) {
    this.log = createLogger({ level: config.logLevel });
    this.repos = openDatabase(config.dbPath);
    for (const p of BUILTIN_PRESETS) this.repos.strategies.upsert(p);

    const sec = this.security();
    this.vault = new Vault(this.repos.vault, { kdf: config.kdf, allowWeakPassword: config.allowWeakPassword });
    this.session = new SessionManager(this.vault, { idleLockMs: sec.idleLockMinutes * 60_000, maxSessionMs: sec.maxSessionHours * 3_600_000 });
    this.mode = new ModeGuard(config.startMode);
    this.vault.onLock(() => {
      this.mode.demoteFromLive();
      this.log.info('vault locked');
    });
    this.mode.onChange((m, prev) => this.log.warn('operating mode changed', { from: prev, to: m }));

    if (config.offline) {
      this.pool = null;
      this.client = null;
      this.swap = new MockSwapProvider();
      this.prices = new PriceService(new StaticPriceProvider(), { intervalMs: config.priceIntervalMs, logger: this.log });
      this.market = new StaticMarketDataProvider();
    } else {
      this.pool = new RpcPool(
        config.rpcUrls.map((url, i) => ({ url, wsUrl: i === 0 ? config.rpcWsUrl : undefined, label: i === 0 ? 'primary' : `backup${i}` })),
        { logger: this.log },
      );
      this.client = new SolanaClient(this.pool, this.log);
      this.swap = new JupiterSwapProvider(config.jupiterBaseUrl);
      this.prices = new PriceService(new JupiterPriceProvider(config.jupiterBaseUrl), {
        intervalMs: config.priceIntervalMs,
        logger: this.log,
        onSnapshot: (q) => this.repos.snapshots.addPrice(q.mint, q.usd, q.sol, q.at),
      });
      this.market = new DexScreenerProvider(config.dexscreenerBaseUrl);
    }

    this.wallets = new WalletManager(this.repos, this.vault, this.client, this.log);
    this.signer = new TransactionSigner(this.vault, this.mode);
    this.analyzer = new TokenAnalyzer(this.client ?? new OfflineChainReader(this.repos), this.market, this.repos.snapshots, this.log);
    this.limiter = new SpendingLimiter(sec.limits, this.repos.audit);
    this.destinations = new DestinationPolicy(
      { isVaultWallet: (a) => this.repos.wallets.isVaultWallet(a), isWhitelisted: (a) => this.repos.whitelist.isWhitelisted(a) },
      sec.whitelistEnabled,
    );
    this.selfTrade = new SelfTradeGuard(this.repos.fills, sec.selfTradeCooldownSec);

    this.engine = new ExecutionEngine({
      repos: this.repos,
      client: this.client,
      swap: this.swap,
      signer: this.signer,
      mode: this.mode,
      limiter: this.limiter,
      destinations: this.destinations,
      selfTrade: this.selfTrade,
      balances: { get: (pks) => this.chainBalances(pks) },
      tokenInfo: (mint) => this.tokenInfo(mint),
      security: () => this.security(),
      log: this.log,
      onPaperFill: (q) => {
        if (this.swap instanceof MockSwapProvider) {
          this.swap.applyFill(q);
          const mint = q.inputMint === WSOL_MINT ? q.outputMint : q.inputMint;
          const meta = this.repos.snapshots.tokenMeta(mint);
          const solUsd = this.prices.solUsd() ?? 0;
          if (meta && solUsd) this.prices.set(mint, this.swap.spotSolPerToken(mint, meta.decimals) * solUsd, 'mock-amm');
        }
      },
    });

    this.portfolio = new PortfolioService(
      this.repos,
      this.prices,
      () => this.viewBalances,
      () => this.mode.current === 'SIMULATION',
    );
    this.positions = new PositionManager(this.repos, this.engine, this.portfolio, () => this.mode.current, this.log);
    this.prices.on('tick', (qs) => {
      void this.positions.onPriceTick(qs).catch((e) => this.log.error('exit rule evaluation failed', { error: errorMessage(e) }));
    });
  }

  // ------------------------------------------------------------ balances

  private viewBalances: WalletBalance[] = [];

  private async chainBalances(pks: string[]): Promise<WalletBalance[]> {
    if (!this.client) return pks.map((publicKey) => ({ publicKey, lamports: 0n, tokens: [], fetchedAt: Date.now() }));
    return this.wallets.refreshBalances(pks);
  }

  /** Refresh balances for all active wallets (mode-aware) and watch held tokens' prices. */
  async refreshBalances(): Promise<WalletBalance[]> {
    const pks = this.wallets.list().map((w) => w.publicKey);
    this.viewBalances = await this.engine.balances(pks);
    const mints = new Set(this.viewBalances.flatMap((b) => b.tokens.filter((t) => t.amountRaw > 0n).map((t) => t.mint)));
    this.prices.watch(...mints);
    return this.viewBalances;
  }

  balances(): WalletBalance[] {
    return this.viewBalances;
  }

  // ------------------------------------------------------------ tokens

  async tokenInfo(mint: string): Promise<TokenInfo> {
    const c = this.tokenInfoCache.get(mint);
    if (c) return c;
    const meta = this.repos.snapshots.tokenMeta(mint);
    let info: TokenInfo;
    if (this.client) {
      const m = await this.client.getMintInfo(mint);
      info = { decimals: m.decimals, programId: m.programId, symbol: meta?.symbol ?? null };
      this.repos.snapshots.upsertTokenMeta(mint, m.decimals, meta?.symbol ?? null, meta?.name ?? null);
    } else {
      if (!meta) throw new TerminalError('NOT_FOUND', `Unknown mint ${mint}`);
      info = { decimals: meta.decimals, programId: TOKEN_PROGRAM_ID, symbol: meta.symbol };
    }
    this.tokenInfoCache.set(mint, info);
    return info;
  }

  async analyzeToken(mint: string, cfg: RiskConfig = {}): Promise<{ analysis: TokenAnalysis; risk: RiskReport }> {
    const analysis = await this.analyzer.analyze(mint);
    const risk = scoreToken(analysis, cfg);
    this.analyzer.record(analysis, risk.score);
    this.prices.watch(mint);
    if (analysis.priceUsd && this.prices.solUsd()) this.prices.set(mint, analysis.priceUsd, 'dexscreener');
    return { analysis, risk };
  }

  // ------------------------------------------------------------ security & mode

  security(): SecuritySettings {
    return { ...DEFAULT_SECURITY, ...this.repos.settings.get<Partial<SecuritySettings>>('security', {}) };
  }

  updateSecurity(patch: Partial<SecuritySettings>): SecuritySettings {
    const next = { ...this.security(), ...patch, limits: { ...this.security().limits, ...(patch.limits ?? {}) } };
    if (next.idleLockMinutes < 1 || next.idleLockMinutes > 240) throw new TerminalError('VALIDATION', 'idle lock must be 1–240 minutes');
    if (next.planTtlSec < 10 || next.planTtlSec > 600) throw new TerminalError('VALIDATION', 'plan TTL must be 10–600 s');
    this.repos.settings.set('security', next);
    this.limiter.setLimits(next.limits);
    this.destinations.enabled = next.whitelistEnabled;
    this.selfTrade.cooldownSec = next.selfTradeCooldownSec;
    this.session.configure({ idleLockMs: next.idleLockMinutes * 60_000, maxSessionMs: next.maxSessionHours * 3_600_000 });
    return next;
  }

  /** LIVE requires an unlocked vault, an RPC connection and the password again. */
  async setMode(mode: OperatingMode, password?: string): Promise<OperatingMode> {
    if (mode === 'LIVE') {
      if (this.config.offline) throw new TerminalError('MODE_FORBIDDEN', 'LIVE mode is unavailable offline');
      if (!this.vault.isUnlocked()) throw new TerminalError('VAULT_LOCKED', 'Unlock the vault before entering LIVE mode');
      if (!password || !(await this.vault.verifyPassword(password))) throw new TerminalError('BAD_PASSWORD', 'Password re-authentication failed');
      this.mode.set('LIVE', { reauthenticated: true });
    } else {
      this.mode.set(mode);
    }
    this.repos.settings.set('lastMode', mode === 'LIVE' ? 'SIMULATION' : mode);
    return this.mode.current;
  }

  // ------------------------------------------------------------ lifecycle

  startBackground(): void {
    this.prices.start();
    if (!this.snapshotTimer) {
      this.snapshotTimer = setInterval(() => {
        this.refreshBalances()
          .then(() => this.portfolio.snapshot())
          .catch((e) => this.log.warn('portfolio snapshot failed', { error: errorMessage(e) }));
      }, 15 * 60_000);
      this.snapshotTimer.unref();
    }
  }

  close(): void {
    this.prices.stop();
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.session.dispose();
    this.vault.lock();
    this.repos.db.close();
  }

  /** Offline/paper helper: create a mock market for a token. */
  seedMockMarket(p: { mint: string; symbol: string; decimals: number; solReserve: bigint; tokenReserve: bigint; solUsd: number; liquidityUsd?: number }): void {
    if (!(this.swap instanceof MockSwapProvider)) throw new TerminalError('VALIDATION', 'Mock markets are only available offline');
    this.swap.addPool(p.mint, p.solReserve, p.tokenReserve);
    this.repos.snapshots.upsertTokenMeta(p.mint, p.decimals, p.symbol, p.symbol);
    this.prices.set(WSOL_MINT, p.solUsd, 'mock');
    const solPer = this.swap.spotSolPerToken(p.mint, p.decimals);
    this.prices.set(p.mint, solPer * p.solUsd, 'mock-amm');
    if (this.market instanceof StaticMarketDataProvider) {
      const liq = p.liquidityUsd ?? (Number(p.solReserve) / 1e9) * p.solUsd * 2;
      this.market.data.set(p.mint, {
        symbol: p.symbol,
        name: p.symbol,
        pools: [
          {
            dex: 'mock', pairAddress: `mock-${p.mint.slice(0, 6)}`, baseMint: p.mint, quoteMint: WSOL_MINT, quoteSymbol: 'SOL', liquidityUsd: liq,
            priceUsd: solPer * p.solUsd, fdvUsd: null, marketCapUsd: null, createdAt: Date.now() - 86_400_000, volume24hUsd: 0,
            txns1h: { buys: 50, sells: 40 }, txns24h: { buys: 500, sells: 450 }, priceChange1hPct: 0,
          },
        ],
      });
    }
  }
}
