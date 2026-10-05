/**
 * Structured JSON logger with mandatory secret redaction.
 *
 * Redaction is defence-in-depth: code should never pass secrets to the logger,
 * but if it does, any field whose name looks sensitive is masked, and any
 * string that looks like a base58 64-byte secret key, a JSON byte-array key or
 * a 12/24-word mnemonic is masked wherever it appears.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

const SENSITIVE_KEY = /(secret|private|seed|mnemonic|passphrase|password|passwd|kek|keypair|authorization|token$)/i;
// base58, 80-90 chars ~= 64-byte secret key (pubkeys are 32-44 chars and stay visible)
const B58_SECRET = /\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g;
// JSON-style byte arrays of 64 entries (Solana CLI keypair files)
const BYTE_ARRAY_KEY = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g;
// 12+ lowercase words in a row (BIP39-like phrase)
const MNEMONIC = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g;

export const REDACTED = '[REDACTED]';

export function redactString(s: string): string {
  return s.replace(B58_SECRET, REDACTED).replace(BYTE_ARRAY_KEY, REDACTED).replace(MNEMONIC, REDACTED);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `[bytes:${value.length}]`;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: value.stack ? redactString(value.stack) : undefined };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export type LogSink = (line: string) => void;

export function createLogger(opts: {
  level?: LogLevel;
  sink?: LogSink;
  bindings?: Record<string, unknown>;
} = {}): Logger {
  const level = opts.level ?? ((process.env.TERM_LOG_LEVEL as LogLevel) || 'info');
  const min = LEVELS[level] ?? LEVELS.info;
  const sink = opts.sink ?? ((line: string) => process.stderr.write(line + '\n'));
  const bindings = opts.bindings ?? {};

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const rec = redact({ ts: new Date().toISOString(), level: lvl, msg, ...bindings, ...(fields ?? {}) });
    sink(JSON.stringify(rec));
  };

  return {
    trace: (m, f) => emit('trace', m, f),
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (b) => createLogger({ level, sink, bindings: { ...bindings, ...b } }),
  };
}

export const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
