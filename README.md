# SOL·TERM — private Solana multi-wallet trading terminal

A single-user trading terminal for running many of your own Solana wallets
from one place: an encrypted key vault, capital distribution, coordinated
multi-wallet trades, new-token risk analysis, position and exit management,
consolidation, and P&L analytics.

It runs **entirely on your machine**. Keys are encrypted locally and only signed
transactions, public keys and mint addresses ever leave it.

> Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and especially its
> **"Security & reliability concerns"** section, before you use LIVE mode.

---

## Contents

1. [What's in the box](#whats-in-the-box)
2. [Repository structure](#repository-structure)
3. [Setup](#setup)
4. [Operating modes](#operating-modes)
5. [Using the dashboard](#using-the-dashboard)
6. [CLI reference](#cli-reference)
7. [Engine API](#engine-api)
8. [Configuration](#configuration)
9. [Docker](#docker)
10. [Testing](#testing)
11. [Going live checklist](#going-live-checklist)
12. [Scope boundaries](#scope-boundaries)

---

## What's in the box

| Area | Features |
|---|---|
| **Wallets** | Generate 1–1000 wallets per call (CLI or UI), import base58 / Solana CLI JSON keys, label, group, tag, archive, set primary, encrypted export/import bundles, public CSV export |
| **Vault & security** | scrypt (N=2¹⁷) + AES-256-GCM per key, password-protected, auto-lock on idle + max session, LIVE re-authentication, spending limits (per tx / per wallet per day / global per day), destination whitelist, self-trade guard, redacting logger, unlock backoff |
| **Capital distribution** | Equal, percentage, weighted, random-range allocation; min/max wallet balance; automatic gas reserve; batched transfers (18 per tx); preview of destinations, amounts, fees and remaining primary balance |
| **Trading** | Market buys/sells via Jupiter; fixed, % of wallet, per-wallet, or total sizing; simultaneous (bounded concurrency) or staggered with jitter; slippage and priority-fee control; limit-style trigger orders |
| **New tokens** | Mint/freeze authority, supply, Token-2022 extensions, top holders & concentration, look-alike holder clusters, pools & liquidity (DexScreener), liquidity change vs last snapshot, token age, buy/sell activity, price-impact estimates |
| **Risk** | 0–100 score from 12 weighted factors with per-factor explanation; configurable policy whose blockers stop a trade |
| **Simulation** | Every leg is quoted, built and `simulateTransaction`-ed before you confirm; expected post-trade SOL / token balances; failure detection; a whole paper-trading mode on top |
| **Positions** | Per-token view of every wallet holding it; sell X%, sell exact amounts, consolidate, rebalance, emergency exit; TP / SL / trailing / staged exit rules evaluated on every price tick |
| **Consolidation** | Move SOL and SPL tokens back to a chosen wallet, close empty token accounts, unwrap WSOL, reclaim rent, leave reserves; shows per-wallet fees and expected amount received |
| **Analytics** | Win rate, avg winner/loser, profit factor, max drawdown, best/worst, avg holding period, P&L by token/wallet/strategy, CSV export |
| **Reliability** | Multi-RPC pool with latency-aware routing and circuit breakers, retry only on transient errors, re-broadcast until confirmed or blockhash expiry, full audit trail of every leg |

## Repository structure

```
apps/
  api/              Engine HTTP + WebSocket server (127.0.0.1 only)
  cli/              `sol-term` command-line interface
  dashboard/        Next.js trading-terminal UI (thin client of the API)
packages/
  core/             Domain types, bigint units, errors, JSON, redacting logger, HTTP
  security/         Vault (scrypt + AES-GCM), session auto-lock, mode guard, limits, whitelist, self-trade guard
  database/         SQLite schema/migrations (node:sqlite) + repositories
  solana-client/    RPC pool with failover, reads, simulate, send/confirm, tx builders, fee math, tx inspector
  wallet-manager/   Generate/import/export/label wallets, balances, the only signer
  price-service/    Price providers (Jupiter, static) + polling feed
  token-analysis/   Mint/holder/pool analysis, market-data providers (DexScreener, static)
  risk-engine/      0–100 risk score with explanations and policy blockers
  trade-engine/     Allocation engine, order planner, swap providers (Jupiter, mock AMM), strategy presets
  execution-engine/ Plans → simulate → preview → confirm → execute; audit trail; paper overlay
  portfolio/        Average-cost ledger, portfolio/wallet/token views, analytics, CSV
  position-manager/ Exit rules, consolidation/rebalance planners, emergency exit, automation runner
  runtime/          Composition root used by both CLI and API
docs/ARCHITECTURE.md
memesim/            (pre-existing Python AMM simulation; unrelated to the terminal)
```

Every external integration sits behind an interface (`SwapProvider`,
`PriceProvider`, `MarketDataProvider`, `TokenChainReader`, RPC endpoints), so
providers can be swapped without touching the engine.

## Setup

Requirements: **Node.js ≥ 22.13** (uses the built-in `node:sqlite`) and **pnpm 10**.

```bash
pnpm install
cp .env.example .env          # set TERM_RPC_URLS to your RPC provider(s)
pnpm test                     # 82 unit + integration tests
```

Start the engine and dashboard in two terminals:

```bash
set -a; . ./.env; set +a
pnpm api                      # engine on http://127.0.0.1:8787
pnpm dashboard                # UI on http://127.0.0.1:3000
```

Open the dashboard, create the vault password (≥ 12 characters; a passphrase
is best — **it cannot be recovered**), then generate or import wallets. The
first wallet created/imported becomes the **primary** (funding/consolidation)
wallet; change it on the Wallets screen.

### Try it with no network and no money

```bash
TERM_OFFLINE=1 TERM_DATA_DIR=./data-paper pnpm api
```

Offline mode uses a mock constant-product AMM and static prices. Switch to
SIMULATION, credit paper SOL (`sol-term paper deposit 50` or
`POST /api/paper/deposit`), create a mock market
(`POST /api/paper/seed-market`), and every flow — distribute, buy, exit rules,
consolidate, analytics — works end to end with paper fills.

## Operating modes

| Mode | What it can do | Banner |
|---|---|---|
| **READ-ONLY** | View balances, analyze tokens. Cannot plan transactions. | slate |
| **SIMULATION** | Real quotes and on-chain simulation, **paper fills only**; nothing is signed. Paper balances = chain balances + paper trades. | amber, viewport outlined |
| **LIVE** | Signs and sends. Requires an unlocked vault, an RPC connection, and **re-entering the password**. Every execution also requires typing `LIVE`. | pulsing red, viewport outlined |

The vault auto-locks after inactivity; locking always drops LIVE back to
SIMULATION. The engine never *starts* in LIVE.

## Using the dashboard

* **Dashboard** — total value, SOL/token split, realized/unrealized/24h P&L, performance chart, holdings, wallets by value, automation alerts.
* **Wallets** — generate/import/label/group/archive/export; per-wallet holdings, entry prices, P&L, audit + on-chain history; **capital distribution** panel.
* **Tokens** — paste a mint → full analysis and risk score with factor breakdown.
* **Trade** — the 11-step flow: mint → analysis → wallets → capital → allocation → slippage/priority/timing → preview → simulate → confirm → execute → monitor (per-leg status streams live over WebSocket with explorer links).
* **Positions** — pick a token and see every wallet holding it; sell %, sell exact amounts, consolidate, rebalance, add staged TP/SL/trailing rules, emergency exit; SOL/token consolidation with rent reclaim.
* **Transactions** — every plan and every leg (planned → simulated → submitted → confirmed/failed) with filters.
* **Strategies** — Conservative / Aggressive presets, custom strategies (every parameter), automation settings, trigger (limit-style) orders.
* **Analytics** — win rate, profit factor, drawdown, best/worst, holding period, P&L breakdowns, CSV export.
* **Settings** — spending limits, auto-lock, plan expiry, self-trade cooldown, whitelist, password change, RPC health.

Every plan is **immutable once previewed** and identified by a SHA-256 hash.
Execution requires that hash, fails if the plan expired (default 60 s — quotes
go stale) or now breaches a limit, and re-quotes each swap right before
sending, skipping legs whose price moved beyond your slippage.

## CLI reference

```bash
alias sol-term="pnpm cli"     # or: npx tsx apps/cli/src/index.ts
```

| Command | Purpose |
|---|---|
| `vault init` / `vault change-password` | create / rotate the vault |
| `wallet generate -n 100 -g alpha -p a` | generate wallets |
| `wallet list [-g group] [-a]` | list wallets |
| `wallet import [-f id.json] [-l label]` | import (hidden prompt if no file) |
| `wallet export -o out.json [-g group]` | encrypted export (`--plaintext --i-understand` for raw keys) |
| `wallet import-bundle <file>` | import an encrypted export |
| `wallet label/group/archive/primary …` | organise wallets |
| `balances [-g group]` | SOL + token counts |
| `analyze <mint>` | token analysis + risk score |
| `distribute --total 10 -g alpha [--mode random --min 0.1 --max 0.3] [--gas auto]` | capital distribution |
| `buy <mint> --sol-per-wallet 0.1 -g alpha [--stagger 2000 --jitter 500] [--slippage 300]` | multi-wallet buy (risk-gated) |
| `sell <mint> --pct 50 [-g group]` | multi-wallet sell |
| `consolidate [-g group] [--reserve 0.002] [--no-tokens] [--no-close]` | sweep back to primary |
| `emergency-exit` | sell everything everywhere (still previewed) |
| `portfolio`, `analytics [--csv dir]` | reporting |
| `paper deposit <sol> [pubkey]` | SIMULATION helper |

Planning commands run in SIMULATION unless you pass `--live` (password
re-entry + typed `LIVE` confirmation). `-y` skips the paper confirmation.

## Engine API

All routes are under `http://127.0.0.1:8787/api`. Everything except
`GET /status`, `POST /vault/init` and `POST /vault/unlock` needs
`Authorization: Bearer <token>` (issued on unlock, dies on lock). Amounts are
integer strings in lamports / raw token units.

Key routes: `/wallets*`, `/balances/refresh`, `/portfolio/{summary,wallets,tokens}`,
`/tokens/analyze`, `/plans/{distribute,trade,sell-percent,sell-amounts,emergency-exit,consolidate,rebalance}`,
`/plans/:id/execute` (body `{hash}`), `/plans/:id/cancel`, `/transactions`,
`/strategies`, `/exit-rules`, `/triggers`, `/automation`, `/analytics[*.csv]`,
`/settings/security`, `/whitelist`, `/mode`. WebSocket: `ws://127.0.0.1:8787/ws?token=…`
pushes `prices`, `leg`, `plan`, `fill`, `alert`, `mode`, `lock`.

## Configuration

See [`.env.example`](.env.example). Most important:

| Variable | Default | Notes |
|---|---|---|
| `TERM_RPC_URLS` | public mainnet RPC | comma-separated; first = primary. Use paid providers for LIVE. |
| `TERM_DATA_DIR` | `./data` | SQLite DB (contains only ciphertext keys). Back it up. |
| `TERM_OFFLINE` | off | mock markets, paper only |
| `TERM_START_MODE` | `READ_ONLY` | never LIVE |
| `TERM_DASHBOARD_ORIGIN` | `http://localhost:3000` | CORS / WebSocket origin allowed |
| `TERM_VAULT_PASSWORD` | empty | headless unlock; **visible to same-user processes** — avoid |
| `TERM_JUPITER_BASE_URL`, `TERM_DEXSCREENER_BASE_URL` | public APIs | provider endpoints |
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:8787` | dashboard → engine URL |

Spending limits, auto-lock, plan TTL, whitelist and self-trade cooldown are
runtime settings (Settings screen), stored in the database.

## Docker

```bash
docker compose up --build
```

Both containers publish to `127.0.0.1` only and keys stay in the `./data`
volume. Do not change the port bindings to `0.0.0.0`.

## Testing

```bash
pnpm typecheck
pnpm test
pnpm --filter @term/dashboard build
```

Tests cover: unit/decimal math and redaction (no secrets in logs), vault
encryption/rotation/export, session auto-lock, mode guard, spending limits,
whitelist, self-trade guard, database round-trips, RPC failover & circuit
breaker, tx builders and the third-party tx inspector, allocation engine,
order planner, mock AMM, risk scoring, token analysis, ledger & analytics,
exit rules, consolidation planner, the API (auth, origin/host checks,
WebSocket streaming), and a full offline end-to-end flow (distribute → analyze
→ staggered buy → staged exit rule auto-sells → emergency exit → consolidate).

LIVE-mode signing/sending is exercised only with mocks. **Validate on devnet
or with tiny amounts first.**

## Going live checklist

1. Use a dedicated OS user with full-disk encryption; keep bulk funds in a hardware wallet.
2. Set two or more reputable RPC endpoints in `TERM_RPC_URLS`.
3. Set conservative spending limits in Settings before entering LIVE.
4. Keep the whitelist on; add only addresses you control.
5. Run the full flow in SIMULATION against mainnet quotes first.
6. Start LIVE with one or two wallets and tiny amounts; check fills on an explorer.
7. Back up `data/terminal.db` **and** an encrypted wallet export to offline storage.

## Scope boundaries

This tool executes your own trades across your own wallets. It deliberately
contains no MEV/bundle or transaction-ordering features, blocks wash-trading
between your own wallets (self-trade guard), and has no volume-generation or
funding-trail obfuscation features. Randomized sizes and timings exist to
slice execution and reduce price impact.
