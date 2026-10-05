import { join, resolve } from 'node:path';
import { OPERATING_MODES, type LogLevel, type OperatingMode } from '@term/core';

export interface RuntimeConfig {
  dataDir: string;
  /** ':memory:' for tests. */
  dbPath: string;
  rpcUrls: string[];
  rpcWsUrl?: string;
  /** No network: mock swap/price/market providers (paper trading only). */
  offline: boolean;
  startMode: OperatingMode;
  jupiterBaseUrl: string;
  dexscreenerBaseUrl: string;
  logLevel: LogLevel;
  priceIntervalMs: number;
  /** Test hooks */
  kdf?: { N?: number; r?: number; p?: number };
  allowWeakPassword?: boolean;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const dataDir = resolve(env.TERM_DATA_DIR || './data');
  const mode = (env.TERM_START_MODE || 'READ_ONLY').toUpperCase() as OperatingMode;
  return {
    dataDir,
    dbPath: env.TERM_DB_PATH || join(dataDir, 'terminal.db'),
    rpcUrls: (env.TERM_RPC_URLS || 'https://api.mainnet-beta.solana.com').split(',').map((s) => s.trim()).filter(Boolean),
    rpcWsUrl: env.TERM_RPC_WS_URL || undefined,
    offline: env.TERM_OFFLINE === '1' || env.TERM_OFFLINE === 'true',
    // LIVE always needs interactive re-auth, so never start in it.
    startMode: OPERATING_MODES.includes(mode) && mode !== 'LIVE' ? mode : 'READ_ONLY',
    jupiterBaseUrl: env.TERM_JUPITER_BASE_URL || 'https://lite-api.jup.ag',
    dexscreenerBaseUrl: env.TERM_DEXSCREENER_BASE_URL || 'https://api.dexscreener.com',
    logLevel: (env.TERM_LOG_LEVEL as LogLevel) || 'info',
    priceIntervalMs: Number(env.TERM_PRICE_INTERVAL_MS || 10_000),
  };
}
