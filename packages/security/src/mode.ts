import { TerminalError, type OperatingMode } from '@term/core';

export type ModeListener = (mode: OperatingMode, previous: OperatingMode) => void;

/**
 * Single choke point for what the engine is allowed to do.
 *
 *   READ_ONLY  : read chain state only
 *   SIMULATION : build + simulate txs, paper fills; never signs
 *   LIVE       : sign + send (requires unlocked vault and re-auth to enter)
 */
export class ModeGuard {
  private listeners: ModeListener[] = [];

  constructor(private mode: OperatingMode = 'READ_ONLY') {}

  get current(): OperatingMode {
    return this.mode;
  }

  onChange(fn: ModeListener): void {
    this.listeners.push(fn);
  }

  /** Callers must have re-authenticated the user before passing `reauthenticated` for LIVE. */
  set(mode: OperatingMode, opts: { reauthenticated?: boolean } = {}): void {
    if (mode === 'LIVE' && !opts.reauthenticated) {
      throw new TerminalError('MODE_FORBIDDEN', 'Entering LIVE mode requires password re-authentication');
    }
    const prev = this.mode;
    this.mode = mode;
    if (prev !== mode) for (const l of this.listeners) l(mode, prev);
  }

  /** Called on vault lock: LIVE degrades to SIMULATION so nothing can sign. */
  demoteFromLive(): void {
    if (this.mode === 'LIVE') this.set('SIMULATION');
  }

  canPlan(): boolean {
    return this.mode !== 'READ_ONLY';
  }

  assertCanPlan(): void {
    if (!this.canPlan()) throw new TerminalError('MODE_FORBIDDEN', 'READ_ONLY mode: switch to SIMULATION or LIVE to plan transactions');
  }

  assertCanSign(): void {
    if (this.mode !== 'LIVE') throw new TerminalError('MODE_FORBIDDEN', `${this.mode} mode: signing is disabled`);
  }

  assertCanSend(): void {
    if (this.mode !== 'LIVE') throw new TerminalError('MODE_FORBIDDEN', `${this.mode} mode: sending transactions is disabled`);
  }
}
