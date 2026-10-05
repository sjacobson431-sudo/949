/**
 * SQLite schema. Amounts are TEXT-encoded integers (lamports / raw token
 * units) to avoid 53-bit float truncation; timestamps are epoch ms INTEGERs.
 * Migrations are append-only.
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE vault_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  kdf_json TEXT NOT NULL,
  verifier_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  group_name TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  is_primary INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('generated','imported')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_wallets_group ON wallets(group_name);
CREATE UNIQUE INDEX idx_wallets_one_primary ON wallets(is_primary) WHERE is_primary = 1;

CREATE TABLE wallet_keys (
  public_key TEXT PRIMARY KEY REFERENCES wallets(public_key) ON DELETE CASCADE,
  iv TEXT NOT NULL,
  ct TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE whitelist (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  hash TEXT NOT NULL,
  title TEXT NOT NULL,
  body_json TEXT NOT NULL,
  strategy_tag TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_plans_created ON plans(created_at);

CREATE TABLE tx_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT REFERENCES plans(id),
  leg_id TEXT,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  wallet TEXT NOT NULL,
  signature TEXT,
  mint TEXT,
  side TEXT,
  lamports_delta TEXT NOT NULL DEFAULT '0',
  token_delta TEXT,
  fee_lamports TEXT,
  internal INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_wallet ON tx_audit(wallet, created_at);
CREATE INDEX idx_audit_plan ON tx_audit(plan_id);
CREATE INDEX idx_audit_sig ON tx_audit(signature);
CREATE INDEX idx_audit_created ON tx_audit(created_at);

CREATE TABLE fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  token_amount TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  lamports TEXT NOT NULL,
  fee_lamports TEXT NOT NULL,
  signature TEXT,
  paper INTEGER NOT NULL,
  strategy_tag TEXT,
  plan_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX idx_fills_wallet_mint ON fills(wallet, mint, at);
CREATE INDEX idx_fills_mint_side ON fills(mint, side, at);

CREATE TABLE price_snapshots (
  mint TEXT NOT NULL,
  at INTEGER NOT NULL,
  usd REAL NOT NULL,
  sol REAL NOT NULL,
  PRIMARY KEY (mint, at)
);

CREATE TABLE token_snapshots (
  mint TEXT NOT NULL,
  at INTEGER NOT NULL,
  liquidity_usd REAL NOT NULL,
  top10_pct REAL NOT NULL,
  risk_score INTEGER,
  body_json TEXT NOT NULL,
  PRIMARY KEY (mint, at)
);

CREATE TABLE token_meta (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  decimals INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE portfolio_snapshots (
  at INTEGER PRIMARY KEY,
  paper INTEGER NOT NULL DEFAULT 0,
  total_lamports TEXT NOT NULL,
  sol_lamports TEXT NOT NULL,
  tokens_lamports TEXT NOT NULL,
  realized_lamports TEXT NOT NULL,
  unrealized_lamports TEXT NOT NULL,
  sol_usd REAL
);

CREATE TABLE strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  body_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE exit_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  wallets_json TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  strategy_tag TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_exit_rules_active ON exit_rules(active, mint);

CREATE TABLE trigger_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  side TEXT NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('PRICE_LTE','PRICE_GTE')),
  price_sol REAL NOT NULL,
  order_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  fired_at INTEGER,
  created_at INTEGER NOT NULL
);
`,
  },
];
