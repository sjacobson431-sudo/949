export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/** Base fee per signature. */
export const BASE_FEE_LAMPORTS = 5_000n;
/** Rent-exempt minimum for a 0-data system account. */
export const RENT_EXEMPT_SYSTEM_ACCOUNT = 890_880n;
/** Rent-exempt minimum for a 165-byte SPL token account. */
export const RENT_EXEMPT_TOKEN_ACCOUNT = 2_039_280n;
/** Max system transfers we pack into a single tx (keeps well under 1232 bytes). */
export const MAX_TRANSFERS_PER_TX = 18;

/** Default compute unit budgets used for fee estimation. */
export const CU_SOL_TRANSFER = 450;
export const CU_TOKEN_TRANSFER = 30_000;
export const CU_SWAP = 300_000;

/** micro-lamports per CU by priority level (fallback when RPC fee estimate unavailable). */
export const PRIORITY_MICROLAMPORTS: Record<'none' | 'low' | 'medium' | 'high' | 'turbo', number> = {
  none: 0,
  low: 10_000,
  medium: 100_000,
  high: 1_000_000,
  turbo: 5_000_000,
};
