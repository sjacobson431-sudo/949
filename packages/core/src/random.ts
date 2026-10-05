import { randomInt } from 'node:crypto';

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
}

/** Cryptographic RNG (default). */
export const cryptoRng: Rng = {
  next: () => randomInt(0, 2 ** 48 - 1) / 2 ** 48,
};

/** Deterministic RNG (mulberry32) for tests and reproducible previews. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export function uniform(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng.next();
}
