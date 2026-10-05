import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  createLogger,
  decimalToRaw,
  formatSol,
  parseJson,
  pctOf,
  rawToDecimalString,
  redact,
  REDACTED,
  seededRng,
  solToLamports,
  stringifyJson,
} from '../src';

describe('units', () => {
  it('parses decimal SOL without float error', () => {
    expect(solToLamports('0.1')).toBe(100_000_000n);
    expect(solToLamports('1.000000001')).toBe(1_000_000_001n);
    expect(solToLamports(0.3)).toBe(300_000_000n);
    expect(decimalToRaw('12.5', 6)).toBe(12_500_000n);
    expect(decimalToRaw('1.23456789', 2)).toBe(123n);
    expect(() => decimalToRaw('abc', 6)).toThrow();
  });
  it('formats raw amounts', () => {
    expect(formatSol(1_500_000_000n)).toBe('1.5');
    expect(rawToDecimalString(-1234n, 3)).toBe('-1.234');
    expect(rawToDecimalString(1000n, 3)).toBe('1');
  });
  it('takes percentages of bigints', () => {
    expect(pctOf(1000n, 25)).toBe(250n);
    expect(pctOf(1000n, 33.3333)).toBe(333n);
    expect(pctOf(1000n, 100)).toBe(1000n);
    expect(pctOf(1000n, 0)).toBe(0n);
  });
});

describe('json', () => {
  it('round-trips bigints', () => {
    const v = { a: 10n ** 20n, b: [1n, 'x'] };
    expect(parseJson(stringifyJson(v))).toEqual(v);
  });
  it('canonicalizes key order', () => {
    expect(canonicalJson({ b: 1, a: 2n })).toBe(canonicalJson({ a: 2n, b: 1 }));
  });
});

describe('rng', () => {
  it('is deterministic when seeded', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
  });
});

describe('logger redaction', () => {
  const fakeSecret = '4'.repeat(10) + '5Kd3NBUAdUnhyzenEwVLy9pBKxSwXvE9FMPyEDKnAnbFqPZrj3QnSgXWiQsHxXk8RcJvd9w5V';
  const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

  it('masks sensitive keys and secret-looking values', () => {
    const r = redact({
      secretKey: 'anything',
      password: 'hunter2',
      nested: { note: `oops ${fakeSecret}`, seedPhrase: phrase },
      bytes: JSON.stringify(Array.from({ length: 64 }, (_, i) => i)),
      publicKey: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      memo: phrase,
    }) as Record<string, any>;
    expect(r.secretKey).toBe(REDACTED);
    expect(r.password).toBe(REDACTED);
    expect(r.nested.note).not.toContain(fakeSecret);
    expect(r.nested.seedPhrase).toBe(REDACTED);
    expect(r.bytes).toBe(REDACTED);
    expect(r.memo).toBe(REDACTED);
    expect(r.publicKey).toBe('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
  });

  it('never writes secrets to the sink', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'trace', sink: (l) => lines.push(l) });
    log.info('import', { privateKey: fakeSecret, msg2: fakeSecret });
    log.child({ walletSecret: 'x' }).error('fail', { err: new Error(`bad key ${fakeSecret}`) });
    const all = lines.join('\n');
    expect(all).not.toContain(fakeSecret);
    expect(all).not.toContain('"x"');
  });
});
