import { useState } from 'react';
import { get } from '../api';
import { useAsync } from '../components/Common';
import { money, pct, cls, num, signed } from '../format';

export default function Reports() {
  const [fy, setFy] = useState('');
  const gains = useAsync<any>(() => get('/api/reports/gains' + (fy ? `?fy=${encodeURIComponent(fy)}` : '')), [fy]);
  const income = useAsync<any>(() => get('/api/reports/income'));
  const x = useAsync<any>(() => get('/api/reports/xirr'));
  const g = gains.data;
  return (
    <div className="wrap">
      <section className="card">
        <div className="sec-head"><h2>Realised gains</h2><label className="fld"><span>Financial year</span><input placeholder="FY 2026-27 (blank = all)" value={fy} onChange={(e) => setFy(e.target.value)} /></label></div>
        {g && <>
          <div className="hold-meta"><span className="chip">Total {signed(g.totals.gain)}</span><span className="chip">Up to 1 year {signed(g.totals.upTo1y)}</span><span className="chip">Over 1 year {signed(g.totals.over1y)}</span><span className="chip warn">Unknown period {signed(g.totals.unknown)}</span></div>
          <p className="banner-err" style={{ background: 'var(--warn-bg)', color: 'var(--warn)' }}>{g.caution}</p>
          <div className="scroll2"><table><thead><tr><th>Sold</th><th>Owner</th><th>Instrument</th><th>Units</th><th>Acquired</th><th>Days</th><th>Cost</th><th>Proceeds</th><th>Gain</th><th>Bucket</th></tr></thead><tbody>
            {g.rows.map((r: any, i: number) => <tr key={i}><td>{r.sold}</td><td>{r.owner}</td><td>{r.instrument}</td><td className="num">{num(r.qty)}</td><td>{r.openingLot ? 'unknown' : r.acquired}</td><td>{r.openingLot ? '' : r.holdingDays}</td><td className="num">{money(r.cost)}</td><td className="num">{money(r.proceeds)}</td><td className={'num ' + cls(r.gain)}>{signed(r.gain)}</td><td>{r.bucket}</td></tr>)}</tbody></table></div>
          {g.rows.length === 0 && <p className="xnote">No sales recorded yet.</p>}</>}
      </section>
      <section className="card">
        <div className="sec-head"><h2>Annualised return (XIRR)</h2></div>
        <div className="scroll2"><table><thead><tr><th>Portfolio</th><th>XIRR</th><th>Flows</th><th>Share of value measurable</th></tr></thead><tbody>
          {x.data?.owners.map((o: any) => <tr key={o.owner}><td>{o.owner}</td><td className={'num ' + cls(o.xirr)}>{o.xirr == null ? 'not enough dated flows' : pct(o.xirr)}</td><td>{o.flowCount}</td><td className="num">{(o.coverage * 100).toFixed(0)}%</td></tr>)}</tbody></table></div>
        <p className="xnote">{x.data?.note}</p>
      </section>
      <section className="card">
        <div className="sec-head"><h2>Dividend and income</h2></div>
        {income.data && (Object.keys(income.data.byFy).length === 0 ? <p className="xnote">No income recorded.</p> : <div className="hold-meta">{Object.entries<number>(income.data.byFy).map(([k, v]) => <span className="chip" key={k}>{k}: {money(v)}</span>)}</div>)}
        <p className="xnote">PMS income imported from your report is cumulative to 5 Nov 2026 and dated that day.</p>
      </section>
    </div>
  );
}
