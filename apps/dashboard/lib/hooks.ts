'use client';

import { useCallback, useEffect, useState } from 'react';
import { get } from './api';

/** Fetch JSON from the engine; re-fetches on `deps` change and on `reload()`. */
export function useApi<T>(path: string | null, deps: unknown[] = [], intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await get<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    void reload();
    if (!intervalMs) return;
    const i = setInterval(reload, intervalMs);
    return () => clearInterval(i);
  }, [reload, intervalMs]);
  return { data, error, loading, reload, setData };
}
