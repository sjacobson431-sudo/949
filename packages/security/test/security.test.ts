import { describe, expect, it } from 'vitest';
import { isTerminalError } from '@term/core';
import {
  checkPasswordStrength,
  DestinationPolicy,
  ModeGuard,
  open,
  seal,
  SelfTradeGuard,
  SessionManager,
  SpendingLimiter,
  Vault,
  type VaultStore,
} from '../src';
import { randomBytes } from 'node:crypto';

export function memoryVaultStore(): VaultStore & { keys: Map<string, any> } {
  let meta: any = null;
  const keys = new Map<string, any>();
  return {
    keys,
    getVaultMeta: () => meta,
    setVaultMeta: (m) => (meta = m),
    getSealedKey: (pk) => keys.get(pk) ?? null,
    putSealedKey: (pk, b) => void keys.set(pk, b),
    listSealedKeys: () => [...keys].map(([publicKey, box]) => ({ publicKey, box })),
    replaceAll: (m, ks) => {
      meta = m;
      keys.clear();
      for (const k of ks) keys.set(k.publicKey, k.box);
    },
  };
}

const FAST = { kdf: { N: 2 ** 10 } };
const PW = 'correct horse battery staple 9!';

describe('crypto', () => {
  it('seals and opens, rejecting wrong AAD and tampering', () => {
    const key = randomBytes(32);
    const box = seal(key, Buffer.from('hello'), 'aad1');
    expect(open(key, box, 'aad1').toString()).toBe('hello');
    expect(() => open(key, box, 'aad2')).toThrow();
    const ct = Buffer.from(box.ct, 'base64');
    ct[0]! ^= 1;
    expect(() => open(key, { ...box, ct: ct.toString('base64') }, 'aad1')).toThrow();
  });
});

describe('Vault', () => {
  it('stores ciphertext only and decrypts per-use', async () => {
    const store = memoryVaultStore();
    const v = new Vault(store, FAST);
    await v.initialize(PW);
    const secret = new Uint8Array(randomBytes(64));
    v.storeSecret('PubKey1', secret);
    const stored = JSON.stringify([...store.keys.values()]);
    expect(stored).not.toContain(Buffer.from(secret).toString('base64'));

    let seen: Uint8Array | null = null;
    await v.withSecret('PubKey1', (s) => {
      expect(Buffer.from(s).equals(Buffer.from(secret))).toBe(true);
      seen = s;
    });
    // wiped after use
    expect([...seen!].every((b) => b === 0)).toBe(true);
  });

  it('rejects bad passwords and requires unlock', async () => {
    const store = memoryVaultStore();
    const v = new Vault(store, FAST);
    await v.initialize(PW);
    v.storeSecret('A', new Uint8Array(64).fill(7));
    v.lock();
    await expect(v.withSecret('A', () => 1)).rejects.toSatisfy((e) => isTerminalError(e, 'VAULT_LOCKED'));
    await expect(v.unlock('wrong password entirely 1!')).rejects.toSatisfy((e) => isTerminalError(e, 'BAD_PASSWORD'));
    await v.unlock(PW);
    expect(await v.withSecret('A', (s) => s[0])).toBe(7);
  });

  it('rejects weak passwords', async () => {
    const v = new Vault(memoryVaultStore(), { kdf: { N: 2 ** 10 } });
    await expect(v.initialize('password123')).rejects.toThrow(/Weak password/);
    expect(checkPasswordStrength(PW).ok).toBe(true);
  });

  it('rotates the password and re-encrypts keys', async () => {
    const store = memoryVaultStore();
    const v = new Vault(store, FAST);
    await v.initialize(PW);
    v.storeSecret('A', new Uint8Array(64).fill(3));
    const newPw = 'another long passphrase #42 zebra';
    await v.changePassword(PW, newPw);
    v.lock();
    await expect(v.unlock(PW)).rejects.toThrow();
    await v.unlock(newPw);
    expect(await v.withSecret('A', (s) => s[5])).toBe(3);
  });

  it('exports under a separate password', async () => {
    const v = new Vault(memoryVaultStore(), FAST);
    await v.initialize(PW);
    v.storeSecret('A', new Uint8Array(64).fill(9));
    const exportPw = 'export passphrase is long 77$';
    const bundle = await v.exportEncrypted(['A'], exportPw);
    expect(JSON.stringify(bundle)).not.toContain('CQkJ'); // base64 of 0x09 bytes
    const got: number[] = [];
    await Vault.readExportBundle(bundle, exportPw, (_pk, s) => void got.push(s[0]!));
    expect(got).toEqual([9]);
    await expect(Vault.readExportBundle(bundle, PW, () => {})).rejects.toThrow(/export password/);
  });
});

describe('SessionManager', () => {
  it('auto-locks after idle timeout and invalidates token', async () => {
    let t = 1_000_000;
    const v = new Vault(memoryVaultStore(), FAST);
    await v.initialize(PW);
    const s = new SessionManager(v, { idleLockMs: 60_000, maxSessionMs: 3_600_000, now: () => t });
    const token = s.start();
    expect(s.verifyToken(token)).toBe(true);
    expect(s.verifyToken('ab'.repeat(32))).toBe(false);
    t += 59_000;
    s.touch();
    t += 59_000;
    expect(s.verifyToken(token)).toBe(true);
    t += 61_000;
    expect(s.verifyToken(token)).toBe(false);
    expect(v.isUnlocked()).toBe(false);
    s.dispose();
  });

  it('enforces an absolute session cap', async () => {
    let t = 0;
    const v = new Vault(memoryVaultStore(), FAST);
    await v.initialize(PW);
    const s = new SessionManager(v, { idleLockMs: 60_000, maxSessionMs: 120_000, now: () => t });
    const token = s.start();
    for (let i = 0; i < 4; i++) {
      t += 30_000;
      s.touch();
    }
    expect(s.verifyToken(token)).toBe(false);
    s.dispose();
  });
});

describe('ModeGuard', () => {
  it('blocks signing outside LIVE and requires re-auth for LIVE', () => {
    const g = new ModeGuard('READ_ONLY');
    expect(() => g.assertCanPlan()).toThrow();
    g.set('SIMULATION');
    g.assertCanPlan();
    expect(() => g.assertCanSign()).toThrow(/signing is disabled/);
    expect(() => g.set('LIVE')).toThrow(/re-authentication/);
    g.set('LIVE', { reauthenticated: true });
    g.assertCanSend();
    g.demoteFromLive();
    expect(g.current).toBe('SIMULATION');
  });
});

describe('limits & policies', () => {
  const history = (perWallet: Record<string, bigint>, global: bigint) => ({
    outflowSince: (w: string | null) => (w === null ? global : perWallet[w] ?? 0n),
  });

  it('enforces per-tx, per-wallet and global limits', () => {
    const lim = new SpendingLimiter(
      { perTxLamports: 2_000_000_000n, perWalletDailyLamports: 5_000_000_000n, globalDailyLamports: 10_000_000_000n },
      history({ W1: 4_000_000_000n }, 9_000_000_000n),
    );
    expect(lim.evaluate([{ wallet: 'W2', lamports: 500_000_000n }])).toEqual([]);
    const v = lim.evaluate([
      { wallet: 'W1', lamports: 3_000_000_000n },
      { wallet: 'W2', lamports: 1_000_000_000n },
    ]);
    expect(v.some((x) => x.includes('per-tx'))).toBe(true);
    expect(v.some((x) => x.includes('per-wallet daily'))).toBe(true);
    expect(v.some((x) => x.includes('global daily'))).toBe(true);
    // internal transfers don't count toward global
    expect(lim.evaluate([{ wallet: 'W3', lamports: 1_500_000_000n, internal: true }])).toEqual([]);
    expect(() => lim.assert([{ wallet: 'W1', lamports: 3_000_000_000n }])).toThrow();
  });

  it('whitelists destinations', () => {
    const p = new DestinationPolicy({ isVaultWallet: (a) => a === 'mine', isWhitelisted: (a) => a === 'friend' });
    expect(p.isAllowed('mine')).toBe(true);
    expect(p.isAllowed('friend')).toBe(true);
    expect(() => p.assert('stranger')).toThrow(/not a vault wallet/);
    p.enabled = false;
    expect(p.isAllowed('stranger')).toBe(true);
  });

  it('blocks opposite-side trades within cooldown', () => {
    let now = 100_000;
    const g = new SelfTradeGuard({ lastTradeAt: (_m, side) => (side === 'SELL' ? 50_000 : null) }, 120, () => now);
    expect(g.check('M', 'BUY')).toMatch(/self-trade/);
    expect(g.check('M', 'SELL')).toBeNull();
    now = 200_000;
    expect(g.check('M', 'BUY')).toBeNull();
  });
});
