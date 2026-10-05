import { describe, expect, it } from 'vitest';
import { WSOL_MINT } from '@term/core';
import { JupiterPriceProvider, PriceService, StaticPriceProvider } from '../src';

describe('PriceService', () => {
  it('derives SOL prices and emits ticks', async () => {
    const p = new StaticPriceProvider();
    p.set(WSOL_MINT, 200);
    p.set('MINT', 0.002);
    const svc = new PriceService(p);
    svc.watch('MINT');
    const ticks: number[] = [];
    svc.on('tick', (qs) => ticks.push(qs.length));
    await svc.refresh();
    expect(svc.solUsd()).toBe(200);
    expect(svc.solPrice('MINT')).toBeCloseTo(0.00001);
    expect(ticks).toEqual([2]);
  });

  it('parses Jupiter v3 responses', async () => {
    const fake = (async (url: string) => {
      expect(url).toContain('/price/v3?ids=');
      return new Response(JSON.stringify({ [WSOL_MINT]: { usdPrice: 150.5 }, X: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new JupiterPriceProvider('https://example.test', fake).getUsdPrices([WSOL_MINT, 'X']);
    expect(r.get(WSOL_MINT)).toBe(150.5);
    expect(r.has('X')).toBe(false);
  });
});
