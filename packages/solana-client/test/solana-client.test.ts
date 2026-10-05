import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createApproveInstruction } from '@solana/spl-token';
import { TOKEN_PROGRAM_ID, PRIORITY_MICROLAMPORTS } from '@term/core';
import {
  buildCloseAccounts,
  buildSolTransfers,
  buildTokenTransfer,
  estimateGasReserve,
  estimateTxFee,
  inspectThirdPartyTx,
  isRetryableRpcError,
  priorityLamportsFor,
  redactUrl,
  RpcPool,
} from '../src';

const BH = '11111111111111111111111111111111';

function fakePool(behaviours: Record<string, (op: number) => Promise<unknown>>, opts: any = {}) {
  const calls: string[] = [];
  let now = 0;
  const pool = new RpcPool(
    Object.keys(behaviours).map((url) => ({ url })),
    {
      sleep: async () => {},
      now: () => now,
      cooldownMs: 1000,
      failureThreshold: 2,
      connectionFactory: (cfg) => {
        let n = 0;
        return { url: cfg.url, ping: () => (calls.push(cfg.url), behaviours[cfg.url]!(n++)) } as any;
      },
      ...opts,
    },
  );
  return { pool, calls, advance: (ms: number) => (now += ms) };
}

describe('RpcPool', () => {
  it('fails over on retryable errors and opens the circuit', async () => {
    const { pool, calls, advance } = fakePool({
      'https://a.example': async () => {
        throw new Error('503 Service Unavailable');
      },
      'https://b.example': async () => 'ok-b',
    });
    expect(await pool.call('ping', (c: any) => c.ping())).toBe('ok-b');
    expect(await pool.call('ping', (c: any) => c.ping())).toBe('ok-b');
    expect(pool.health()[0]!.state).toBe('open');
    calls.length = 0;
    expect(await pool.call('ping', (c: any) => c.ping())).toBe('ok-b');
    expect(calls).toEqual(['https://b.example']); // open endpoint skipped
    advance(1500);
    expect(pool.health()[0]!.state).toBe('half-open');
  });

  it('does not retry non-retryable errors', async () => {
    const { pool, calls } = fakePool({
      'https://a.example': async () => {
        throw new Error('Invalid param: WrongSize');
      },
      'https://b.example': async () => 'ok',
    });
    await expect(pool.call('ping', (c: any) => c.ping())).rejects.toThrow('Invalid param');
    expect(calls).toEqual(['https://a.example']);
    expect(pool.health()[0]!.state).toBe('closed');
  });

  it('throws RPC_UNAVAILABLE when everything is down', async () => {
    const { pool } = fakePool({
      'https://a.example': async () => {
        throw new Error('fetch failed');
      },
    });
    await expect(pool.call('ping', (c: any) => c.ping())).rejects.toThrow(/all RPC endpoints/);
  });

  it('classifies errors and redacts URLs', () => {
    expect(isRetryableRpcError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRetryableRpcError(new Error('Transaction simulation failed'))).toBe(false);
    expect(redactUrl('https://mainnet.helius-rpc.com/?api-key=abcdef123')).not.toContain('abcdef123');
    expect(redactUrl('https://x.quiknode.pro/0123456789abcdef0123456789abcdef/')).not.toContain('0123456789abcdef0123');
  });
});

describe('fees', () => {
  it('computes base + priority fees', () => {
    expect(estimateTxFee({ computeUnits: 200_000, microLamportsPerCu: 0 })).toBe(5000n);
    expect(estimateTxFee({ computeUnits: 200_000, microLamportsPerCu: 1_000_000 })).toBe(205_000n);
    expect(priorityLamportsFor({ level: 'custom', maxLamports: 12345n })).toBe(12345n);
    expect(priorityLamportsFor({ level: 'medium' }, 300_000)).toBe(BigInt((300_000 * PRIORITY_MICROLAMPORTS.medium) / 1e6));
  });
  it('estimates gas reserve with rent', () => {
    const r = estimateGasReserve({ expectedTxs: 4, priority: { level: 'none' }, newTokenAccounts: 1 });
    // 4 tx * 5000 * 1.5 + 2 * token-account rent
    expect(r).toBe(30_000n + 2n * 2_039_280n);
  });
});

describe('tx builder & inspector', () => {
  const owner = Keypair.generate().publicKey.toBase58();
  const dests = Array.from({ length: 3 }, () => Keypair.generate().publicKey.toBase58());

  it('builds batched SOL transfers', () => {
    const b = buildSolTransfers({ from: owner, transfers: dests.map((to) => ({ to, lamports: 1000n })), blockhash: BH, microLamportsPerCu: 0 });
    expect(b.tx.message.compiledInstructions).toHaveLength(4); // CU limit + 3 transfers
    expect(b.estFeeLamports).toBe(5000n);
    expect(() => buildSolTransfers({ from: owner, transfers: [], blockhash: BH, microLamportsPerCu: 0 })).toThrow();
  });

  it('builds token transfer and close ixs', () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const src = Keypair.generate().publicKey.toBase58();
    const t = buildTokenTransfer({
      owner, mint, programId: TOKEN_PROGRAM_ID, decimals: 6, sourceTokenAccount: src, amount: 5n,
      destinationOwner: dests[0]!, closeSourceAfter: true, blockhash: BH, microLamportsPerCu: 1000,
    });
    expect(t.tx.message.compiledInstructions).toHaveLength(5);
    const c = buildCloseAccounts({ owner, accounts: [{ tokenAccount: src, programId: TOKEN_PROGRAM_ID }], blockhash: BH, microLamportsPerCu: 0 });
    expect(c.tx.message.compiledInstructions).toHaveLength(2);
  });

  it('flags suspicious third-party transactions', () => {
    const keys = (tx: VersionedTransaction) => tx.message.staticAccountKeys.map((k) => k.toBase58());
    const good = buildSolTransfers({ from: owner, transfers: [{ to: owner, lamports: 1n }], blockhash: BH, microLamportsPerCu: 0 }).tx;
    expect(inspectThirdPartyTx(good, keys(good), owner).ok).toBe(true);

    const drain = buildSolTransfers({ from: owner, transfers: [{ to: dests[0]!, lamports: 1n }], blockhash: BH, microLamportsPerCu: 0 }).tx;
    const r = inspectThirdPartyTx(drain, keys(drain), owner);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/unexpected SOL transfer/);

    const other = Keypair.generate().publicKey.toBase58();
    expect(inspectThirdPartyTx(good, keys(good), other).problems.join()).toMatch(/fee payer/);

    const approve = new VersionedTransaction(
      new TransactionMessage({
        payerKey: new PublicKey(owner),
        recentBlockhash: BH,
        instructions: [createApproveInstruction(new PublicKey(dests[1]!), new PublicKey(dests[2]!), new PublicKey(owner), 10n)],
      }).compileToV0Message(),
    );
    expect(inspectThirdPartyTx(approve, keys(approve), owner).problems.join()).toMatch(/delegate/);

    const create = new VersionedTransaction(
      new TransactionMessage({
        payerKey: new PublicKey(owner),
        recentBlockhash: BH,
        instructions: [
          SystemProgram.createAccount({ fromPubkey: new PublicKey(owner), newAccountPubkey: new PublicKey(dests[0]!), lamports: 5_000_000_000, space: 0, programId: new PublicKey(owner) }),
        ],
      }).compileToV0Message(),
    );
    expect(inspectThirdPartyTx(create, keys(create), owner).problems.join()).toMatch(/CreateAccount/);
  });
});
