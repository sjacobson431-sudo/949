# Solana Trading Terminal — Architecture

A private, single-user trading terminal for managing many personally controlled
Solana wallets. It runs entirely on the operator's machine: the engine (API +
CLI) holds the encrypted key vault, and the Next.js dashboard is a thin client
that talks to the engine over `127.0.0.1`.

## 1. System overview

```
┌──────────────────────────── operator machine ────────────────────────────┐
│                                                                          │
│  apps/dashboard (Next.js)  ──HTTP/WS (127.0.0.1, bearer token)──┐        │
│  apps/cli (sol-term)  ───────────── in-process ─────────────────┤        │
│                                                                 ▼        │
│                         packages/runtime  (composition root)             │
│   ┌──────────────┬──────────────┬───────────────┬──────────────────┐     │
│   │ security     │ wallet-mgr   │ trade-engine  │ execution-engine │     │
│   │ vault, mode, │ generate,    │ allocation,   │ simulate→preview │     │
│   │ limits,      │ import/export│ order planner,│ →confirm→execute │     │
│   │ whitelist    │ balances     │ swap provider │ audit trail      │     │
│   ├──────────────┼──────────────┼───────────────┼──────────────────┤     │
│   │ token-       │ risk-engine  │ portfolio     │ position-manager │     │
│   │ analysis     │ 0–100 score  │ ledger, P&L,  │ exit rules,      │     │
│   │              │ + reasons    │ analytics,CSV │ consolidation    │     │
│   ├──────────────┴──────────────┴───────────────┴──────────────────┤     │
│   │ solana-client: RPC pool (failover, circuit breaker), tx send/  │     │
│   │ confirm, priority fees     price-service: polling + pub/sub    │     │
│   ├────────────────────────────────────────────────────────────────┤     │
│   │ database: SQLite (node:sqlite), migrations, repositories       │     │
│   └────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ public data only (no keys ever)
          ┌────────────────────────┼─────────────────────────┐
          ▼                        ▼                         ▼
   Solana RPC providers     Jupiter (quote/swap,     DexScreener (pools,
   (N endpoints, failover)  price API)               liquidity, activity)
```

Transactions are **built and signed locally**. Only signed transactions,
public keys and mint addresses ever leave the machine.

## 2. Operating modes

| Mode         | Reads chain | Builds/simulates txs | Signs | Sends | Ledger           |
|--------------|-------------|----------------------|-------|-------|------------------|
| `READ_ONLY`  | yes         | no                   | no    | no    | —                |
| `SIMULATION` | yes         | yes (real quotes)    | no    | no    | paper fills      |
| `LIVE`       | yes         | yes                  | yes   | yes   | real fills       |

`ModeGuard` is the single choke point: the signer and the sender both call
`assertCanSign()` / `assertCanSend()`, so no code path can broadcast a
transaction outside LIVE mode. Switching to LIVE requires the vault password
again (re-authentication), and the dashboard renders a full-width red banner
in LIVE, amber in SIMULATION and slate in READ_ONLY.

## 3. Trade lifecycle

```
 intent ─► plan ─► quote ─► build ─► simulate ─► preview ─► confirm ─► execute ─► confirm on-chain ─► ledger
           │        │        │         │           │          │          │
           │        │        │         │           │          │          └ per-tx status over WS
           │        │        │         │           │          └ plan hash + expiry checked; limits re-checked
           │        │        │         │           └ every tx, fee, est. output, post-balances
           │        │        │         └ RPC simulateTransaction → failure detection
           │        │        └ local build; nothing signed until LIVE execute
           │        └ SwapProvider (Jupiter / mock)
           └ allocation engine + schedule (simultaneous / staggered / jittered)
```

A plan is immutable once previewed. Its SHA-256 hash is the confirmation
token: `execute(planId, confirmHash)` fails if the plan changed, expired
(default 60 s, quotes go stale) or now violates a spending limit.

## 4. Security design

* **Vault** — master password → scrypt (N=2^17, r=8, p=1, per-vault salt) →
  256-bit key-encryption key. Each wallet secret is sealed with AES-256-GCM,
  unique 96-bit nonce, and the wallet public key as AAD (ciphertexts can't be
  swapped between rows). A password verifier blob detects wrong passwords
  without touching wallet keys.
* **Key handling** — secrets are decrypted just-in-time inside `withSigner()`
  and the buffers are zeroed afterwards. The KEK lives only in memory while
  unlocked and is zeroed on lock.
* **Auto-lock** — idle timer (default 15 min) and an absolute session cap.
* **No secret logging** — the structured logger redacts any field named like
  `secret|private|seed|mnemonic|password|key` and any base58 string of 64-byte
  secret length. There is a test that asserts this.
* **Spending limits** — per-transaction, per-wallet-per-day and global daily
  caps (SOL), enforced in the execution engine from the audit table.
* **Destination whitelist** — SOL/SPL transfers may only go to vault wallets
  or explicitly whitelisted addresses (on by default).
* **API surface** — binds `127.0.0.1` only, checks `Host` (DNS-rebinding
  defence), strict CORS to the dashboard origin, random bearer token issued on
  unlock, mutations require the token.
* **Exports** — wallet export is re-encrypted under an export password by
  default; plaintext export requires an explicit `--plaintext --i-understand`.

## 5. Reliability design

* **RPC pool** — multiple endpoints, latency-weighted selection, per-endpoint
  circuit breaker (opens after N consecutive failures, half-opens after a
  cooldown), retry with exponential backoff on retryable errors (429, 5xx,
  timeouts) only.
* **Send/confirm** — signed tx is broadcast to the primary endpoint and
  re-broadcast on an interval until confirmed or the blockhash expires
  (`lastValidBlockHeight`); the same signature makes re-broadcast idempotent.
  Expiry is a definitive failure, so retries never double-spend.
* **Idempotent plans** — each planned tx has a status in `tx_audit`
  (`PLANNED → SIMULATED → SUBMITTED → CONFIRMED | FAILED | EXPIRED`); a
  crashed run can be resumed without re-sending confirmed legs.
* **Concurrency limits** — bounded parallelism for multi-wallet runs so 500
  wallets don't trip provider rate limits.

## 6. Security & reliability concerns (read before going live)

1. **Hot keys.** This is a hot wallet system: anything that compromises the
   machine while the vault is unlocked can drain it. Keep only working capital
   in derived wallets, keep the bulk in a hardware wallet, use a dedicated OS
   user, full-disk encryption and a strong vault password.
2. **Password strength is the whole game** for an offline-stolen vault file.
   scrypt slows guessing but cannot save a weak password.
3. **Environment-variable password** (`TERM_VAULT_PASSWORD`) is supported for
   headless use but is visible to same-user processes (`/proc/*/environ`).
   Prefer interactive unlock.
4. **Third-party transaction builders.** Jupiter returns a serialized
   transaction. The engine decodes it and refuses to sign if the fee payer is
   not the expected wallet or if it contains a top-level System transfer /
   SPL transfer to an unknown account. Simulation then shows the balance
   deltas before you confirm. Still: you are trusting an aggregator's program
   routing.
5. **Quote staleness.** New-token pools move in seconds; quotes expire
   quickly and slippage limits are the real protection. Plans expire after
   60 s by default.
6. **RPC trust.** A malicious RPC can lie about balances/simulations (not
   forge signatures). Use reputable providers, and more than one.
7. **Priority fees** on congested launches can exceed the trade's expected
   edge; the preview shows total fees per plan.
8. **Rate limits** on free RPC / Jupiter tiers will throttle 500-wallet runs;
   the concurrency setting exists for this.
9. **On-chain linkage.** All wallets funded from one primary wallet are
   trivially linkable on-chain. The tool does not try to hide that.
10. **P&L accuracy** depends on fills being recorded by this tool; trades made
    elsewhere with the same wallets are imported as balance changes, not
    trades, and cost basis for them is unknown.

## 7. Scope boundaries (deliberate)

The terminal is for executing *your own* trades efficiently across *your own*
wallets. It intentionally does **not** include:

* Jito/MEV bundles, transaction-ordering control, or front-running/sandwich
  logic.
* Wash-trading: a **self-trade guard** blocks buying and selling the same mint
  across your wallets within a cooldown window (default 120 s), and blocks
  transfers of a token between your wallets while an order in that token is
  in flight.
* Volume generation, holder-count inflation, or funding-trail obfuscation
  (no hop wallets, no mixers).

Randomized sizes and intervals exist as execution-slicing tools (reduce
price impact, avoid predictable order flow), not as disguise.

## 8. Data model (SQLite)

See `packages/database/src/schema.ts`. Tables:

| table               | purpose                                                  |
|---------------------|----------------------------------------------------------|
| `vault_meta`        | KDF params, salt, password verifier                      |
| `wallets`           | public key, label, group, tags, primary/archived flags   |
| `wallet_keys`       | AES-GCM ciphertext + nonce per wallet                    |
| `whitelist`         | allowed external destinations                            |
| `settings`          | key/value JSON (mode, limits, RPC endpoints, …)          |
| `plans`             | previewed plans (JSON) + hash + expiry + status          |
| `tx_audit`          | every planned/simulated/sent tx, full lifecycle          |
| `fills`             | executed trades (live or paper) → cost basis & P&L       |
| `price_snapshots`   | mint price history (for charts, liquidity changes)       |
| `token_snapshots`   | analysis snapshots (liquidity/holders over time)         |
| `portfolio_snapshots`| equity curve (daily P&L, drawdown)                      |
| `strategies`        | presets (conservative / aggressive / custom)             |
| `exit_rules`        | active TP/SL/trailing/staged rules + runtime state       |

All on-chain amounts are stored as integer strings (lamports / raw token
units) and handled as `bigint` in code — never floats.
