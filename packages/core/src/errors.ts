export type ErrorCode =
  | 'VAULT_LOCKED'
  | 'VAULT_NOT_INITIALIZED'
  | 'BAD_PASSWORD'
  | 'MODE_FORBIDDEN'
  | 'LIMIT_EXCEEDED'
  | 'NOT_WHITELISTED'
  | 'SELF_TRADE_BLOCKED'
  | 'PLAN_EXPIRED'
  | 'PLAN_MISMATCH'
  | 'PLAN_NOT_FOUND'
  | 'RISK_BLOCKED'
  | 'INSUFFICIENT_FUNDS'
  | 'VALIDATION'
  | 'RPC_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'TX_REJECTED'
  | 'NOT_FOUND';

export class TerminalError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TerminalError';
  }
}

export function isTerminalError(e: unknown, code?: ErrorCode): e is TerminalError {
  return e instanceof TerminalError && (code === undefined || e.code === code);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
