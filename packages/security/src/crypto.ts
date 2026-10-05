import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export interface KdfParams {
  algo: 'scrypt';
  N: number;
  r: number;
  p: number;
  /** base64 */
  salt: string;
}

export const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 } as const;

export interface SealedBox {
  /** base64 12-byte nonce */
  iv: string;
  /** base64 ciphertext || 16-byte tag */
  ct: string;
}

function scrypt(password: Buffer, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export function newKdfParams(overrides: Partial<Omit<KdfParams, 'algo' | 'salt'>> = {}): KdfParams {
  return { algo: 'scrypt', ...DEFAULT_KDF, ...overrides, salt: randomBytes(32).toString('base64') };
}

export async function deriveKey(password: string, params: KdfParams): Promise<Buffer> {
  const pw = Buffer.from(password.normalize('NFKC'), 'utf8');
  try {
    return await scrypt(pw, Buffer.from(params.salt, 'base64'), 32, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: 256 * params.N * params.r + 1024 * 1024,
    });
  } finally {
    pw.fill(0);
  }
}

export function seal(key: Buffer, plaintext: Uint8Array, aad: string): SealedBox {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64') };
}

/** Throws if the key is wrong, the ciphertext was tampered with, or the AAD differs. */
export function open(key: Buffer, box: SealedBox, aad: string): Buffer {
  const raw = Buffer.from(box.ct, 'base64');
  if (raw.length < 16) throw new Error('ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function wipe(...bufs: (Uint8Array | null | undefined)[]): void {
  for (const b of bufs) b?.fill(0);
}
