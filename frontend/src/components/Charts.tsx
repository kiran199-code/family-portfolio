import { useState } from 'react';
import { money, exact, pct, cls } from '../format';

export const COLORS: Record<string, string> = { Personal: 'var(--p-personal)', HUF: 'var(--p-huf)', Sravanthi: 'var(--p-sravanthi)', ULIP: 'var(--p-ulip)' };
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#6250d6', '#d19a1f', '#b83a2c', '#3b4a5a', '#8a95a0', '#0f766e'];

export function Donut({ items, onPick }: { items: { key: string; label: string; value: number; color?: string }[]; onPick?: (k: string) => void }) {
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  const [hover, setHover] = useState<string | null>(null);
  const R = 70, C = 2 * Math.PI * R;
  let off = 0;
  const h = items.find((i) => i.key === hover);
  return (
    <svg className={'donut' + (hover ? ' dim' : '')} viewBox="0 0 200 200" role="img" aria-label="Allocation donut">
      <g transform="rotate(-90 100 100)">
        {items.map((it, i) => {
          const len = (it.value / total) * C;
          const el = (
            <circle key={it.key} className={'seg2' + (hover === it.key ? ' on' : '')} cx="100" cy="100" r={R} stroke={it.color ?? PALETTE[i % PALETTE.length]}
              strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} tabIndex={0} onMouseEnter={() => setHover(it.key)} onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(it.key)} onBlur={() => setHover(null)} onClick={() => onPick?.(it.key)}><title>{`${it.label} ${((it.value / total) * 100).toFixed(1)}%`}</title></circle>
          );
          off += len; return el;
        })}
      </g>
      <text x="100" y="96" fontSize="11" fill="var(--muted)">{h ? h.label : 'Total'}</text>
      <text x="100" y="118" fontSize="16">{money(h ? h.value : total)}</text>
    </svg>
  );
}

export function ReturnsChart({ rows }: { rows: { name: string; ret: number; portfolio: string; value: number }[] }) {
  if (!rows.length) return <p className="xnote">No holdings with a cost to chart.</p>;
  const max = Math.max(...rows.map((r) => Math.abs(r.ret)), 0.05);
  const min = Math.min(...rows.map((r) => r.ret), 0), hi = Math.max(...rows.map((r) => r.ret), 0);
  const span = Math.max(hi - min, 0.01);
  const zero = (-min / span) * 100;
  void max;
  return (
    <div className="rchart">
      {rows.map((r, i) => {
        const l = r.ret >= 0 ? zero : zero - (Math.abs(r.ret) / span) * 100, w = (Math.abs(r.ret) / span) * 100;
        return (
          <div className="rr" key={i} title={`${r.name}: ${pct(r.ret)} on ${money(r.value)}`}>
            <span className="nm"><span className="dot" style={{ background: COLORS[r.portfolio] }} />{r.name}</span>
            <span className="tr" style={{ ['--zero' as any]: zero + '%' }}><i style={{ left: l + '%', width: w + '%', background: r.ret >= 0 ? 'var(--good)' : 'var(--bad)' }} /></span>
            <span className={'vl ' + cls(r.ret)}>{pct(r.ret)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function HistoryChart({ rows }: { rows: { date: string; total: number; cost: number }[] }) {
  if (rows.length < 2) return <p className="xnote">{rows.length === 1 ? `Only one snapshot so far (${rows[0].date}); the line appears from the second one.` : 'No snapshots yet. One is saved after each refresh that brings a new close or NAV.'}</p>;
  const W = 640, H = 220, P = 40;
  const vals = rows.flatMap((r) => [r.total, r.cost]);
  const lo = Math.min(...vals) * 0.98, hi = Math.max(...vals) * 1.02;
  const x = (i: number) => P + (i / (rows.length - 1)) * (W - 2 * P), y = (v: number) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const line = (k: 'total' | 'cost') => rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[k]).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: 720 }} role="img" aria-label="Portfolio value history">
      <line x1={P} x2={W - P} y1={H - P} y2={H - P} stroke="var(--line)" />
      <path d={line('cost')} fill="none" stroke="var(--faint)" strokeDasharray="4 3" strokeWidth="1.5" />
      <path d={line('total')} fill="none" stroke="var(--p-personal)" strokeWidth="2" />
      {rows.map((r, i) => <circle key={i} cx={x(i)} cy={y(r.total)} r="3" fill="var(--p-personal)"><title>{`${r.date}: ${exact(r.total)}`}</title></circle>)}
      <text x={P} y={14} fontSize="11" fill="var(--muted)">{money(hi)}</text><text x={P} y={H - P + 16} fontSize="11" fill="var(--muted)">{rows[0].date}</text>
      <text x={W - P} y={H - P + 16} fontSize="11" fill="var(--muted)" textAnchor="end">{rows[rows.length - 1].date}</text>
    </svg>
  );
}
