import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Terminal } from '@term/runtime';
import { createApiServer, UnlockGuard } from '../src/server';
import { WebSocket } from 'ws';
import { request } from 'node:http';

const PORT = 18787;
const ORIGIN = 'http://localhost:3999';
const PW = 'api test passphrase that is long 7!';
let term: Terminal;
let api: ReturnType<typeof createApiServer>;
let token = '';

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

beforeAll(async () => {
  term = new Terminal({
    dataDir: '/tmp', dbPath: ':memory:', rpcUrls: [], offline: true, startMode: 'READ_ONLY',
    jupiterBaseUrl: '', dexscreenerBaseUrl: '', logLevel: 'error', priceIntervalMs: 60_000, kdf: { N: 2 ** 10 },
  });
  api = createApiServer(term, { port: PORT, dashboardOrigin: ORIGIN });
  await new Promise<void>((r) => api.server.listen(PORT, '127.0.0.1', r));
});
afterAll(async () => {
  await api.close();
  term.close();
});

describe('engine API', () => {
  it('requires auth, rejects foreign origins and hosts', async () => {
    expect((await call('GET', '/api/status')).json.initialized).toBe(false);
    expect((await call('GET', '/api/wallets')).status).toBe(401);
    expect((await call('GET', '/api/status', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    // the dashboard origin is accepted under both loopback spellings
    expect((await call('GET', '/api/status', undefined, { origin: 'http://127.0.0.1:3999' })).status).toBe(200);
    // DNS-rebinding defence: a foreign Host header is refused
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: PORT, path: '/api/status', headers: { host: 'attacker.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it('initializes, generates wallets, previews and executes a paper distribution', async () => {
    const init = await call('POST', '/api/vault/init', { password: PW });
    expect(init.status).toBe(200);
    token = init.json.token;
    const gen = await call('POST', '/api/wallets/generate', { count: 4, group: 'g' });
    expect(gen.json).toHaveLength(4);
    const [primary, ...rest] = gen.json.map((w: any) => w.publicKey);
    // READ_ONLY blocks planning
    const ro = await call('POST', '/api/plans/distribute', { recipients: rest, total: '1000000000', spec: { kind: 'equal' }, priority: { level: 'none' } });
    expect(ro.status).toBe(403);
    expect((await call('POST', '/api/mode', { mode: 'SIMULATION' })).json.mode).toBe('SIMULATION');
    expect((await call('POST', '/api/paper/deposit', { wallet: primary, sol: '10' })).status).toBe(200);

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`, { headers: { origin: ORIGIN } });
    const msgs: any[] = [];
    await new Promise((r) => ws.on('open', r));
    ws.on('message', (m) => msgs.push(JSON.parse(String(m))));

    const plan = await call('POST', '/api/plans/distribute', { recipients: rest, total: '3000000000', spec: { kind: 'equal' }, priority: { level: 'none' } });
    expect(plan.status).toBe(200);
    expect(plan.json.legs).toHaveLength(3);
    expect(typeof plan.json.totals.lamportsOut).toBe('string');
    expect((await call('POST', `/api/plans/${plan.json.id}/execute`, { hash: '0'.repeat(64) })).status).toBe(409);
    const ex = await call('POST', `/api/plans/${plan.json.id}/execute`, { hash: plan.json.hash });
    expect(ex.json.accepted).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(msgs.some((m) => m.type === 'plan' && m.data.status === 'DONE')).toBe(true);
    expect(msgs.filter((m) => m.type === 'leg' && m.data.status === 'PAPER_FILLED')).toHaveLength(3);
    ws.close();

    const txs = await call('GET', '/api/transactions');
    expect(txs.json.length).toBeGreaterThanOrEqual(4);
    const csv = await fetch(`http://127.0.0.1:${PORT}/api/wallets/export.csv`, { headers: { authorization: `Bearer ${token}` } });
    expect((await csv.text()).split('\n')[0]).toContain('public_key');
  });

  it('validates input with clear errors', async () => {
    const bad = await call('POST', '/api/plans/trade', { mint: 'not-a-key', side: 'BUY' });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toMatch(/mint/);
  });

  it('locks: token stops working', async () => {
    expect((await call('POST', '/api/vault/lock')).status).toBe(200);
    expect((await call('GET', '/api/wallets')).status).toBe(401);
    const bad = await call('POST', '/api/vault/unlock', { password: 'wrong wrong wrong wrong 1!' });
    expect(bad.status).toBe(401);
    const ok = await call('POST', '/api/vault/unlock', { password: PW });
    token = ok.json.token;
    expect((await call('GET', '/api/wallets')).status).toBe(200);
  });

  it('backs off after repeated unlock failures', () => {
    let now = 0;
    const g = new UnlockGuard(() => now);
    g.fail();
    g.fail();
    g.check();
    g.fail();
    expect(() => g.check()).toThrow(/retry/);
    now += 5_001;
    g.check();
  });
});
