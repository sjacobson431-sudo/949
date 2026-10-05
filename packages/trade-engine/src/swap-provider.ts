import { VersionedTransaction } from '@solana/web3.js';
import { fetchJson, TerminalError, WSOL_MINT, type SwapQuote } from '@term/core';

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
}

export interface BuiltSwap {
  tx: VersionedTransaction;
  lastValidBlockHeight: number;
  priorityFeeLamports: bigint;
}

export interface SwapProvider {
  readonly name: string;
  /** Whether `buildSwapTransaction` produces real, sendable transactions. */
  readonly buildsTransactions: boolean;
  quote(r: QuoteRequest): Promise<SwapQuote>;
  buildSwapTransaction(quote: SwapQuote, userPublicKey: string, priorityFeeLamports: bigint): Promise<BuiltSwap>;
}

interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: { swapInfo: { label?: string } }[];
}

/** Jupiter Swap API v1 (aggregates Raydium, Orca, Meteora, pump AMMs, …). */
export class JupiterSwapProvider implements SwapProvider {
  readonly name = 'jupiter';
  readonly buildsTransactions = true;

  constructor(
    private readonly baseUrl = 'https://lite-api.jup.ag',
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async quote(r: QuoteRequest): Promise<SwapQuote> {
    if (r.amount <= 0n) throw new TerminalError('VALIDATION', 'quote amount must be positive');
    const q = new URLSearchParams({
      inputMint: r.inputMint,
      outputMint: r.outputMint,
      amount: r.amount.toString(),
      slippageBps: String(r.slippageBps),
      restrictIntermediateTokens: 'true',
    });
    const j = await fetchJson<JupQuote & { error?: string }>(`${this.baseUrl}/swap/v1/quote?${q}`, { fetchImpl: this.fetchImpl });
    if (j.error) throw new TerminalError('PROVIDER_ERROR', `Jupiter: ${j.error}`);
    return {
      provider: this.name,
      inputMint: j.inputMint,
      outputMint: j.outputMint,
      inAmount: BigInt(j.inAmount),
      outAmount: BigInt(j.outAmount),
      minOutAmount: BigInt(j.otherAmountThreshold),
      slippageBps: j.slippageBps,
      priceImpactPct: Number(j.priceImpactPct) * 100,
      routeLabel: j.routePlan.map((p) => p.swapInfo.label ?? '?').join(' → '),
      raw: j,
      quotedAt: Date.now(),
    };
  }

  async buildSwapTransaction(quote: SwapQuote, userPublicKey: string, priorityFeeLamports: bigint): Promise<BuiltSwap> {
    const r = await fetchJson<{ swapTransaction: string; lastValidBlockHeight: number; prioritizationFeeLamports?: number }>(
      `${this.baseUrl}/swap/v1/swap`,
      {
        method: 'POST',
        fetchImpl: this.fetchImpl,
        body: {
          quoteResponse: quote.raw,
          userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: priorityFeeLamports > 0n ? Number(priorityFeeLamports) : undefined,
        },
      },
    );
    return {
      tx: VersionedTransaction.deserialize(Buffer.from(r.swapTransaction, 'base64')),
      lastValidBlockHeight: r.lastValidBlockHeight,
      priorityFeeLamports: BigInt(r.prioritizationFeeLamports ?? Number(priorityFeeLamports)),
    };
  }
}

/**
 * Offline constant-product market for SIMULATION mode and tests. Paper fills
 * move the reserves, so later quotes reflect earlier price impact.
 */
export class MockSwapProvider implements SwapProvider {
  readonly name = 'mock-amm';
  readonly buildsTransactions = false;
  /** mint -> reserves (lamports, raw tokens) and fee */
  readonly pools = new Map<string, { sol: bigint; token: bigint; feeBps: number }>();

  addPool(mint: string, solReserve: bigint, tokenReserve: bigint, feeBps = 25): void {
    this.pools.set(mint, { sol: solReserve, token: tokenReserve, feeBps });
  }

  /** Spot price in SOL per raw token unit × 10^decimals. */
  spotSolPerToken(mint: string, decimals: number): number {
    const p = this.pools.get(mint);
    if (!p || p.token === 0n) return 0;
    return (Number(p.sol) / 1e9) / (Number(p.token) / 10 ** decimals);
  }

  async quote(r: QuoteRequest): Promise<SwapQuote> {
    const buy = r.inputMint === WSOL_MINT;
    const mint = buy ? r.outputMint : r.inputMint;
    const p = this.pools.get(mint);
    if (!p) throw new TerminalError('PROVIDER_ERROR', `No route found for ${mint}`);
    const [rin, rout] = buy ? [p.sol, p.token] : [p.token, p.sol];
    const inAfterFee = (r.amount * BigInt(10_000 - p.feeBps)) / 10_000n;
    const out = (rout * inAfterFee) / (rin + inAfterFee);
    const spotOut = (rout * r.amount) / rin;
    const impact = spotOut > 0n ? Number(((spotOut - out) * 1_000_000n) / spotOut) / 10_000 : 100;
    return {
      provider: this.name,
      inputMint: r.inputMint,
      outputMint: r.outputMint,
      inAmount: r.amount,
      outAmount: out,
      minOutAmount: (out * BigInt(10_000 - r.slippageBps)) / 10_000n,
      slippageBps: r.slippageBps,
      priceImpactPct: impact,
      routeLabel: 'MockAMM',
      raw: null,
      quotedAt: Date.now(),
    };
  }

  /** Apply a paper fill to the pool reserves. */
  applyFill(q: SwapQuote): void {
    const buy = q.inputMint === WSOL_MINT;
    const mint = buy ? q.outputMint : q.inputMint;
    const p = this.pools.get(mint);
    if (!p) return;
    if (buy) {
      p.sol += q.inAmount;
      p.token -= q.outAmount;
    } else {
      p.token += q.inAmount;
      p.sol -= q.outAmount;
    }
  }

  async buildSwapTransaction(): Promise<BuiltSwap> {
    throw new TerminalError('MODE_FORBIDDEN', 'Mock swap provider cannot build real transactions');
  }
}
