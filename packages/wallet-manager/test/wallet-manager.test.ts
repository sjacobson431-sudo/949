import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { openDatabase } from '@term/database';
import { ModeGuard, Vault } from '@term/security';
import { parseSecretKey, TransactionSigner, WalletManager } from '../src';

const PW = 'correct horse battery staple 9!';

async function setup() {
  const repos = openDatabase(':memory:');
  const vault = new Vault(repos.vault, { kdf: { N: 2 ** 10 } });
  await vault.initialize(PW);
  return { repos, vault, wm: new WalletManager(repos, vault, null) };
}

describe('WalletManager', () => {
  it('generates wallets with labels, groups and a primary', async () => {
    const { wm, repos } = await setup();
    const ws = wm.generate({ count: 25, group: 'alpha', labelPrefix: 'a' });
    expect(ws).toHaveLength(25);
    expect(ws[0]!.label).toBe('a001');
    expect(wm.primary()?.publicKey).toBe(ws[0]!.publicKey);
    expect(wm.groups()).toEqual([{ name: 'alpha', count: 25 }]);
    expect(repos.vault.listSealedKeys()).toHaveLength(25);
    // ciphertext only on disk
    const rows = repos.db.all<{ ct: string }>('SELECT ct FROM wallet_keys');
    expect(rows.every((r) => r.ct.length > 80)).toBe(true);
  });

  it('imports base58 and JSON array keys, rejects bad input', async () => {
    const { wm } = await setup();
    const kp = Keypair.generate();
    const w = wm.importSecret(bs58.encode(kp.secretKey), { label: 'main' });
    expect(w.publicKey).toBe(kp.publicKey.toBase58());
    const kp2 = Keypair.generate();
    wm.importSecret(JSON.stringify(Array.from(kp2.secretKey)));
    expect(() => wm.importSecret(bs58.encode(kp.secretKey))).toThrow(/already exists/);
    expect(() => parseSecretKey('abandon ability able about above absent absorb abstract absurd abuse access accident')).toThrow();
  });

  it('archives, but never the primary', async () => {
    const { wm } = await setup();
    const [a, b] = wm.generate({ count: 2 });
    expect(() => wm.update(a!.publicKey, { archived: true })).toThrow(/primary/);
    wm.update(b!.publicKey, { archived: true });
    expect(wm.list()).toHaveLength(1);
  });

  it('exports encrypted bundles and re-imports them into a fresh vault', async () => {
    const { wm } = await setup();
    const ws = wm.generate({ count: 3, group: 'g' });
    const exportPw = 'separate export phrase 123! zz';
    const bundle = await wm.exportEncrypted(ws.map((w) => w.publicKey), exportPw);
    const other = await setup();
    const imported = await other.wm.importEncrypted(JSON.parse(JSON.stringify(bundle)), exportPw);
    expect(imported.map((w) => w.publicKey).sort()).toEqual(ws.map((w) => w.publicKey).sort());
    expect(imported[0]!.groupName).toBe('g');
    expect(wm.exportPublicCsv().split('\n')).toHaveLength(4);
  });

  it('signs only in LIVE mode', async () => {
    const { wm, vault } = await setup();
    const [w] = wm.generate({ count: 1 });
    const mode = new ModeGuard('SIMULATION');
    const signer = new TransactionSigner(vault, mode);
    const mk = () =>
      new VersionedTransaction(
        new TransactionMessage({
          payerKey: Keypair.generate().publicKey,
          recentBlockhash: '11111111111111111111111111111111',
          instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(w!.publicKey), toPubkey: Keypair.generate().publicKey, lamports: 1 })],
        }).compileToV0Message(),
      );
    await expect(signer.sign(w!.publicKey, mk())).rejects.toThrow(/signing is disabled/);
    mode.set('LIVE', { reauthenticated: true });
    const payerTx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: new PublicKey(w!.publicKey),
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [],
      }).compileToV0Message(),
    );
    const signed = await signer.sign(w!.publicKey, payerTx);
    expect(signed.signatures[0]!.some((b) => b !== 0)).toBe(true);
  });
});
