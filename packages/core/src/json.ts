/**
 * bigint-safe JSON. bigints are encoded as {"$big":"123"} so they round-trip;
 * `toWire` instead renders them as plain decimal strings for API clients.
 */
export function stringifyJson(value: unknown, space?: number): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? { $big: v.toString() } : v), space);
}

export function parseJson<T = unknown>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.$big === 'string' && Object.keys(v).length === 1) {
      return BigInt(v.$big);
    }
    return v;
  }) as T;
}

/** Convert bigints to strings recursively (for HTTP responses). */
export function toWire<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** Deterministic JSON (sorted keys) for hashing. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === 'bigint') return { $big: v.toString() };
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}
