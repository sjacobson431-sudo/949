import { randomBytes } from 'node:crypto';
import { constantTimeEqual } from './crypto';
import type { Vault } from './vault';

export interface SessionOptions {
  idleLockMs: number;
  maxSessionMs: number;
  now?: () => number;
}

/**
 * Auto-locking session around the vault. Any authenticated activity calls
 * `touch()`. The vault is locked after `idleLockMs` of inactivity or
 * `maxSessionMs` after unlock, whichever is first. API bearer tokens are
 * bound to a session and die with it.
 */
export class SessionManager {
  private token: Buffer | null = null;
  private startedAt = 0;
  private lastActivity = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(
    private readonly vault: Vault,
    private opts: SessionOptions,
  ) {
    this.now = opts.now ?? Date.now;
    vault.onLock(() => this.clear());
  }

  configure(opts: Partial<SessionOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  async unlock(password: string): Promise<string> {
    await this.vault.unlock(password);
    return this.start();
  }

  /** Begin a session for an already-unlocked vault (e.g. right after init). */
  start(): string {
    this.startedAt = this.lastActivity = this.now();
    this.token = randomBytes(32);
    this.arm();
    return this.token.toString('hex');
  }

  verifyToken(token: string | undefined | null): boolean {
    if (!this.token || !token || !/^[0-9a-f]{64}$/.test(token)) return false;
    if (this.checkExpiry()) return false;
    return constantTimeEqual(this.token, Buffer.from(token, 'hex'));
  }

  touch(): void {
    if (this.vault.isUnlocked()) this.lastActivity = this.now();
  }

  /** Locks if expired; returns true when it locked. */
  checkExpiry(): boolean {
    if (!this.vault.isUnlocked()) return false;
    const t = this.now();
    if (t - this.lastActivity >= this.opts.idleLockMs || t - this.startedAt >= this.opts.maxSessionMs) {
      this.vault.lock();
      return true;
    }
    return false;
  }

  status(): { unlocked: boolean; idleRemainingMs: number | null; sessionRemainingMs: number | null } {
    if (!this.vault.isUnlocked()) return { unlocked: false, idleRemainingMs: null, sessionRemainingMs: null };
    const t = this.now();
    return {
      unlocked: true,
      idleRemainingMs: Math.max(0, this.opts.idleLockMs - (t - this.lastActivity)),
      sessionRemainingMs: Math.max(0, this.opts.maxSessionMs - (t - this.startedAt)),
    };
  }

  lock(): void {
    this.vault.lock();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkExpiry(), 5_000);
    this.timer.unref();
  }

  private clear(): void {
    if (this.token) this.token.fill(0);
    this.token = null;
  }
}
