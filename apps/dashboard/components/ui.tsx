'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';

export function Stat({ label, value, sub, cls }: { label: string; value: ReactNode; sub?: ReactNode; cls?: string }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className={`value ${cls ?? ''}`}>{value}</div>
      {sub !== undefined && <div className="sub">{sub}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  return error ? <div className="alert error">{error}</div> : null;
}

export function Copy({ text, label }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <span
      className="mono"
      style={{ cursor: 'pointer' }}
      title={text}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1000);
      }}
    >
      {label ?? `${text.slice(0, 4)}…${text.slice(-4)}`}
      {ok ? ' ✓' : ''}
    </span>
  );
}

/**
 * Single-series line chart with crosshair tooltip. One series → no legend;
 * the card title names it. Values in the tooltip use text colour, not series colour.
 */
export function LineChart({ points, format, height = 180 }: { points: { x: number; y: number }[]; format: (y: number) => string; height?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 800;
  const H = height;
  const pad = { l: 56, r: 12, t: 10, b: 22 };
  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    if (y0 === y1) [y0, y1] = [y0 - 1, y1 + 1];
    const sx = (x: number) => pad.l + ((x - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
    const sy = (y: number) => pad.t + (1 - (y - y0) / (y1 - y0)) * (H - pad.t - pad.b);
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
    const area = `${d}L${sx(x1)},${H - pad.b}L${sx(x0)},${H - pad.b}Z`;
    const ticks = [y0, (y0 + y1) / 2, y1];
    return { sx, sy, d, area, ticks, x0, x1 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, H]);

  if (!geo) return <div className="muted" style={{ height, display: 'grid', placeItems: 'center' }}>Not enough data yet</div>;
  const hp = hover !== null ? points[hover] : null;

  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={ref}
        className="chart"
        style={{ height }}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = ref.current!.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * W;
          let best = 0;
          points.forEach((p, i) => {
            if (Math.abs(geo.sx(p.x) - x) < Math.abs(geo.sx(points[best]!.x) - x)) best = i;
          });
          setHover(best);
        }}
      >
        {geo.ticks.map((t, i) => (
          <g key={i}>
            <line className="grid-line" x1={pad.l} x2={W - pad.r} y1={geo.sy(t)} y2={geo.sy(t)} />
            <text className="axis-label" x={pad.l - 6} y={geo.sy(t) + 3} textAnchor="end">{format(t)}</text>
          </g>
        ))}
        <text className="axis-label" x={pad.l} y={H - 6}>{new Date(geo.x0).toLocaleDateString()}</text>
        <text className="axis-label" x={W - pad.r} y={H - 6} textAnchor="end">{new Date(geo.x1).toLocaleDateString()}</text>
        <path className="area" d={geo.area} />
        <path className="series" d={geo.d} vectorEffect="non-scaling-stroke" />
        {hp && (
          <>
            <line className="cross" x1={geo.sx(hp.x)} x2={geo.sx(hp.x)} y1={pad.t} y2={H - pad.b} vectorEffect="non-scaling-stroke" />
            <circle cx={geo.sx(hp.x)} cy={geo.sy(hp.y)} r={4} fill="var(--accent)" stroke="var(--panel)" strokeWidth={2} />
          </>
        )}
      </svg>
      {hp && (
        <div className="tooltip" style={{ left: `${(geo.sx(hp.x) / W) * 100}%`, top: 4, transform: 'translateX(-50%)' }}>
          {new Date(hp.x).toLocaleString()} · {format(hp.y)}
        </div>
      )}
    </div>
  );
}

/** Horizontal diverging bars (P&L by key). Sign is shown in text, not colour alone. */
export function PnlBars({ rows, format }: { rows: { key: string; value: number }[]; format: (v: number) => string }) {
  const max = Math.max(1e-12, ...rows.map((r) => Math.abs(r.value)));
  if (!rows.length) return <div className="muted">No realized P&amp;L yet</div>;
  return (
    <table>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} title={`${r.key}: ${format(r.value)}`}>
            <td style={{ width: '30%' }}>{r.key}</td>
            <td style={{ width: '50%' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  {r.value < 0 && <i style={{ display: 'block', height: 10, width: `${(Math.abs(r.value) / max) * 100}%`, background: 'var(--neg)', borderRadius: '4px 0 0 4px' }} />}
                </div>
                <div>{r.value > 0 && <i style={{ display: 'block', height: 10, width: `${(r.value / max) * 100}%`, background: 'var(--pos)', borderRadius: '0 4px 4px 0' }} />}</div>
              </div>
            </td>
            <td className="num">{format(r.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
