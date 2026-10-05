import type { ExitRuleSpec, ExitRuleState } from '@term/core';

export type ExitAction =
  | { kind: 'partial'; pctOfBaseline: number; reasons: string[] }
  | { kind: 'all'; reason: string };

export interface ExitEvaluation {
  action: ExitAction | null;
  state: ExitRuleState;
  gainPct: number;
}

export function validateExitSpec(spec: ExitRuleSpec): string[] {
  const p: string[] = [];
  const total = spec.takeProfits.reduce((s, t) => s + t.sellPct, 0);
  if (total > 100) p.push(`take-profit tiers sell ${total}% (> 100%) of the position`);
  for (const t of spec.takeProfits) {
    if (t.gainPct <= 0) p.push('take-profit gain must be positive');
    if (t.sellPct <= 0 || t.sellPct > 100) p.push('take-profit sell % must be in (0, 100]');
  }
  if (spec.stopLossPct !== undefined && (spec.stopLossPct <= 0 || spec.stopLossPct >= 100)) p.push('stop loss must be in (0, 100)');
  if (spec.trailingStopPct !== undefined && (spec.trailingStopPct <= 0 || spec.trailingStopPct >= 100)) p.push('trailing stop must be in (0, 100)');
  return p;
}

/**
 * Pure exit-rule evaluation on a price tick.
 *
 * - Take-profit tiers sell a % of the *baseline* position (size when the rule
 *   was created), each tier fires once: 25% @ +50%, 25% @ +100%, … then hold.
 * - Stop loss exits everything at −X% from average entry.
 * - Trailing stop exits everything when price falls X% from its peak since
 *   activation (optionally only after reaching +activation%).
 */
export function evaluateExitRule(spec: ExitRuleSpec, state: ExitRuleState, avgEntry: number, price: number): ExitEvaluation {
  const next: ExitRuleState = { ...state, firedTiers: [...state.firedTiers], peakSolPerToken: Math.max(state.peakSolPerToken, price) };
  if (state.stopped || avgEntry <= 0 || price <= 0) return { action: null, state: next, gainPct: 0 };
  const gainPct = (price / avgEntry - 1) * 100;

  if (spec.stopLossPct !== undefined && gainPct <= -spec.stopLossPct) {
    next.stopped = true;
    return { action: { kind: 'all', reason: `stop loss: ${gainPct.toFixed(1)}% ≤ −${spec.stopLossPct}%` }, state: next, gainPct };
  }

  if (spec.trailingStopPct !== undefined) {
    const peakGain = (next.peakSolPerToken / avgEntry - 1) * 100;
    const armed = spec.trailingActivationPct === undefined || peakGain >= spec.trailingActivationPct;
    const drawFromPeak = (1 - price / next.peakSolPerToken) * 100;
    if (armed && drawFromPeak >= spec.trailingStopPct) {
      next.stopped = true;
      return {
        action: { kind: 'all', reason: `trailing stop: ${drawFromPeak.toFixed(1)}% below peak (limit ${spec.trailingStopPct}%)` },
        state: next,
        gainPct,
      };
    }
  }

  let pct = 0;
  const reasons: string[] = [];
  spec.takeProfits.forEach((t, i) => {
    if (!next.firedTiers.includes(i) && gainPct >= t.gainPct) {
      next.firedTiers.push(i);
      pct += t.sellPct;
      reasons.push(`take profit #${i + 1}: +${gainPct.toFixed(1)}% ≥ +${t.gainPct}% → sell ${t.sellPct}%`);
    }
  });
  if (pct > 0) {
    const allTiersDone = next.firedTiers.length === spec.takeProfits.length;
    if (pct >= 100 || (allTiersDone && spec.takeProfits.reduce((s, t) => s + t.sellPct, 0) >= 100)) next.stopped = true;
    return { action: { kind: 'partial', pctOfBaseline: Math.min(100, pct), reasons }, state: next, gainPct };
  }
  return { action: null, state: next, gainPct };
}
