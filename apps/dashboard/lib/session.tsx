'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { API_URL, get, getToken, loadToken, post, setToken, setUnauthorizedHandler } from './api';
import type { LegEvent, Mode, Status } from './types';

export interface WsMessage {
  type: string;
  data: any;
  at: number;
}

interface SessionCtx {
  status: Status | null;
  ready: boolean;
  refreshStatus: () => Promise<void>;
  unlock: (password: string) => Promise<void>;
  init: (password: string) => Promise<void>;
  lock: () => Promise<void>;
  setMode: (mode: Mode, password?: string) => Promise<void>;
  /** Subscribe to WebSocket pushes; returns an unsubscribe fn. */
  subscribe: (fn: (m: WsMessage) => void) => () => void;
  legEvents: LegEvent[];
  alerts: WsMessage[];
  prices: Record<string, { usd: number; sol: number; at: number }>;
  wsConnected: boolean;
  /** This client holds a session token (the vault may be unlocked by another client). */
  hasToken: boolean;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [ready, setReady] = useState(false);
  const [legEvents, setLegEvents] = useState<LegEvent[]>([]);
  const [alerts, setAlerts] = useState<WsMessage[]>([]);
  const [prices, setPrices] = useState<SessionCtx['prices']>({});
  const [wsConnected, setWsConnected] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const storeToken = (t: string | null) => {
    setToken(t);
    setHasToken(!!t);
  };
  const subs = useRef(new Set<(m: WsMessage) => void>());
  const wsRef = useRef<WebSocket | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await get<Status>('/api/status'));
    } catch {
      setStatus(null);
    } finally {
      setReady(true);
    }
  }, []);

  const connectWs = useCallback(() => {
    const t = getToken();
    if (!t || wsRef.current) return;
    const ws = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/ws?token=${t}`);
    wsRef.current = ws;
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => {
      setWsConnected(false);
      wsRef.current = null;
      // reconnect while we still hold a token
      setTimeout(() => getToken() && connectWs(), 3000);
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as WsMessage;
      if (m.type === 'leg') setLegEvents((xs) => [m.data as LegEvent, ...xs].slice(0, 2000));
      if (m.type === 'alert') setAlerts((xs) => [m, ...xs].slice(0, 100));
      if (m.type === 'prices') {
        setPrices((p) => {
          const n = { ...p };
          for (const q of m.data as { mint: string; usd: number; sol: number; at: number }[]) n[q.mint] = q;
          return n;
        });
      }
      if (m.type === 'mode' || m.type === 'lock') void refreshStatus();
      if (m.type === 'lock') storeToken(null);
      for (const s of subs.current) s(m);
    };
  }, [refreshStatus]);

  useEffect(() => {
    setHasToken(!!loadToken());
    setUnauthorizedHandler(() => {
      storeToken(null);
      void refreshStatus();
    });
    void refreshStatus().then(connectWs);
    const i = setInterval(refreshStatus, 15_000);
    return () => clearInterval(i);
  }, [refreshStatus, connectWs]);

  const unlock = async (password: string) => {
    const r = await post<{ token: string }>('/api/vault/unlock', { password });
    storeToken(r.token);
    await refreshStatus();
    connectWs();
  };
  const init = async (password: string) => {
    const r = await post<{ token: string }>('/api/vault/init', { password });
    storeToken(r.token);
    await refreshStatus();
    connectWs();
  };
  const lock = async () => {
    await post('/api/vault/lock').catch(() => undefined);
    storeToken(null);
    wsRef.current?.close();
    await refreshStatus();
  };
  const setMode = async (mode: Mode, password?: string) => {
    await post('/api/mode', { mode, password });
    await refreshStatus();
  };
  const subscribe = (fn: (m: WsMessage) => void) => {
    subs.current.add(fn);
    return () => subs.current.delete(fn);
  };

  return (
    <Ctx.Provider value={{ status, ready, refreshStatus, unlock, init, lock, setMode, subscribe, legEvents, alerts, prices, wsConnected, hasToken }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSession(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSession outside provider');
  return c;
}
