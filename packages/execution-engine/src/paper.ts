import type { TxAuditRecord, WalletBalance } from '@term/core';

/**
 * SIMULATION-mode balances = real (or zero, offline) balances + the effect of
 * every PAPER_FILLED audit row. Paper trading therefore uses the same audit
 * trail as live trading and survives restarts.
 *
 * Conventions on audit rows:
 *   lamportsDelta  SOL leaving the signer (+) / entering it (−), excl. fee
 *   tokenDelta     signed change of the signer's balance of `mint`
 *   details.destination receives +lamportsDelta SOL (transfers) or −tokenDelta tokens
 */
export function applyPaperOverlay(base: WalletBalance[], paperRows: TxAuditRecord[]): WalletBalance[] {
  const map = new Map(base.map((b) => [b.publicKey, { ...b, tokens: b.tokens.map((t) => ({ ...t })) }]));
  const touch = (pk: string) => {
    let b = map.get(pk);
    if (!b) {
      b = { publicKey: pk, lamports: 0n, tokens: [], fetchedAt: Date.now() };
      map.set(pk, b);
    }
    return b;
  };
  const addToken = (pk: string, mint: string, delta: bigint, decimals: number) => {
    const b = touch(pk);
    let t = b.tokens.find((x) => x.mint === mint);
    if (!t) {
      t = { mint, tokenAccount: `paper:${pk.slice(0, 6)}:${mint.slice(0, 6)}`, programId: 'paper', amountRaw: 0n, decimals };
      b.tokens.push(t);
    }
    t.amountRaw += delta;
  };
  for (const r of paperRows) {
    if (r.status !== 'PAPER_FILLED') continue;
    const dest = typeof r.details.destination === 'string' ? (r.details.destination as string) : null;
    const decimals = typeof r.details.decimals === 'number' ? (r.details.decimals as number) : 0;
    if (r.wallet !== 'PAPER_FAUCET') {
      const b = touch(r.wallet);
      b.lamports -= r.lamportsDelta + (r.feeLamports ?? 0n);
      if (r.mint && r.tokenDelta) addToken(r.wallet, r.mint, r.tokenDelta, decimals);
    }
    if (dest) {
      if (r.kind === 'SOL_TRANSFER') touch(dest).lamports += r.lamportsDelta;
      if (r.kind === 'TOKEN_TRANSFER' && r.mint && r.tokenDelta) addToken(dest, r.mint, -r.tokenDelta, decimals);
    }
    if (r.kind === 'CLOSE_ACCOUNT' && r.wallet !== 'PAPER_FAUCET') {
      const b = touch(r.wallet);
      const closed = new Set((r.details.accounts as { mint?: string }[] | undefined)?.map((a) => a.mint) ?? []);
      b.tokens = b.tokens.filter((t) => !(closed.has(t.mint) && t.amountRaw === 0n));
    }
  }
  for (const b of map.values()) b.tokens = b.tokens.filter((t) => t.amountRaw > 0n || t.programId !== 'paper');
  return [...map.values()];
}
