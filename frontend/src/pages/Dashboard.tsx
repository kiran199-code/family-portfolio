import { useMemo, useState } from 'react';
import { get, post } from '../api';
import { useAsync, Chip, PriceBadges } from '../components/Common';
import { Donut, ReturnsChart, HistoryChart, COLORS } from '../components/Charts';
import { TxnModal, TxnPrefill } from '../components/TxnModal';
import { OverrideModal, BalanceModal } from '../components/RowEditors';
import { money, exact, signed, pct, cls, num, shortDate } from '../format';
import type { Dashboard as D, Row, Part, Portfolio } from '../types';

const NAV = [['s-hero', 'Overview'], ['s-hold', 'Holdings'], ['s-returns', 'Returns'], ['s-market', 'Market'], ['s-exposure', 'Look-through'], ['s-alloc', 'Allocation'], ['s-history', 'History'], ['s-watch', 'Watchlist'], ['s-notes', 'Notes']];

export default function Dashboard() {
  const dash = useAsync<D>(() => get('/api/dashboard'));
  const snaps = useAsync<any[]>(() => get('/api/snapshots'));
  const watch = useAsync<any[]>(() => get('/api/watchlist'));
  const flags = useAsync<any[]>(() => get('/api/flags'));
  const [sel, setSel] = useState('Personal');
  const [sub, setSub] = useState<Record<string, string>>({});
  const [txn, setTxn] = useState<TxnPrefill | null>(null);
  const [ovr, setOvr] = useState<Row | null>(null);
  const [bal, setBal] = useState<Row | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [result, setResult] = useState<any[] | null>(null);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);

  const reloadAll = () => { dash.reload(); snaps.reload(); };
  const refresh = async () => {
    setRefreshing(true); setRefreshErr(null);
    try { const r = await post('/api/refresh', { job: 'all' }); setResult(r.results); reloadAll(); } catch (e: any) { setRefreshErr(e.message); } finally { setRefreshing(false); }
  };

  const d = dash.data;
  const returns = useMemo(() => {
    if (!d) return [];
    return d.portfolios.flatMap((p) => p.parts.filter((x) => ['mf', 'stocks', 'pms'].includes(x.key)).flatMap((x) => x.rows.filter((r) => r.retPct != null && r.value != null).map((r) => ({ name: r.shortName, ret: r.retPct as number, portfolio: p.code, value: r.value as number })))).sort((a, b) => b.ret - a.ret);
  }, [d]);

  if (dash.loading && !d) return <div className="wrap"><p>Loading…</p></div>;
  if (dash.error || !d) return <div className="wrap"><div className="banner-err">{dash.error ?? 'Could not load the dashboard'}</div></div>;

  const t = d.totals;
  const portfolio = d.portfolios.find((p) => p.code === sel)!;
  const partKey = sub[sel] ?? portfolio.parts[0]?.key;
  const part = portfolio.parts.find((p) => p.key === partKey) ?? portfolio.parts[0];
  const unverified = d.portfolios.flatMap((p) => p.parts.flatMap((x) => x.rows)).filter((r) => r.verify && r.instrumentId != null).length;
  const seedRows = d.portfolios.flatMap((p) => p.parts.flatMap((x) => x.rows)).filter((r) => r.kind === 'seed').length;

  return (
    <div className="wrap">
      <header className="masthead" id="top">
        <div className="mh">
          <h1>Family Portfolio</h1>
          <div className="asof">
            <span className="chip" title="Newest and oldest price dates across all holdings">Prices {shortDate(d.asOf.oldestPriceDate)} to {shortDate(d.asOf.latestPriceDate)}</span>
            {seedRows > 0 && <span className="chip warn">{seedRows} values still from the prototype seed</span>}
            {unverified > 0 && <span className="chip warn">{unverified} to verify</span>}
          </div>
          <div className="rfx">
            <button className={'rfb' + (refreshing ? ' busy' : '')} onClick={refresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh live prices'}</button>
            <span className="rfs">{refreshErr ?? 'Fetches NAVs, stock closes and FX now, then saves a snapshot if anything new arrived.'}</span>
          </div>
        </div>
      </header>

      {result && <RefreshResult result={result} onClose={() => setResult(null)} />}
      {d.warnings.length > 0 && <div className="banner-err" role="alert"><b>Not valued:</b> {d.warnings.slice(0, 4).join(' · ')}{d.warnings.length > 4 ? ` · +${d.warnings.length - 4} more` : ''}</div>}

      <nav className="qnav" aria-label="Sections">{NAV.map(([id, l]) => <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }}>{l}</a>)}</nav>

      <section className="card hero" id="s-hero">
        <div>
          <div className="lbl">Total value, all portfolios</div>
          <div className="big num" title={exact(t.value)}>{money(t.value)}</div>
          <div className="exact num">{exact(t.value)}</div>
          <div className="kv">
            <div><span className="kh">Overall</span><b className={cls(t.gain)}>{signed(t.gain)} ({pct(t.gainPct)})</b><span>vs cost {money(t.cost)}</span></div>
            <div><span className="kh">Daily</span><b className={cls(t.day)}>{signed(t.day)} ({pct(t.dayPct)})</b><span className="xnote">vs previous NAV or close, {t.n} of {t.m} holdings (periods differ)</span></div>
          </div>
        </div>
        <div className="alloc">
          <div className="lbl">Where it sits</div>
          <div className="dwrap">
            <Donut items={d.portfolios.map((p) => ({ key: p.code, label: p.label, value: p.value, color: COLORS[p.code] }))} onPick={(k) => { setSel(k); document.getElementById('s-hold')?.scrollIntoView({ behavior: 'smooth' }); }} />
            <div className="dleg">{d.portfolios.map((p) => <button key={p.code} onClick={() => setSel(p.code)}><span className="dot" style={{ background: COLORS[p.code] }} />{p.label} <span className="num">{money(p.value)} · {((p.value / t.value) * 100).toFixed(1)}%</span></button>)}</div>
          </div>
        </div>
      </section>

      <div className="pcards" role="tablist" id="pcards">
        {d.portfolios.map((p) => (
          <button key={p.code} className="pcard" role="tab" aria-selected={sel === p.code} data-k={p.code} style={{ ['--c' as any]: COLORS[p.code] }} onClick={() => setSel(p.code)}>
            <span className="t"><span>{p.label}</span><span className="chip">{p.m} holdings</span></span>
            <span className="v" title={exact(p.value)}>{money(p.value)}</span>
            <span className="s"><span>Cost {money(p.cost)}</span><span className={'num ' + cls(p.gain)}>{signed(p.gain)} ({pct(p.gainPct)})</span></span>
          </button>
        ))}
      </div>

      <section className="card" id="s-hold">
        <div className="sec-head"><h2>{portfolio.label} holdings</h2><small>Cost and units come from your ledger. Prices are live where a source is configured.</small></div>
        <div className="seg" role="group" aria-label="Holding type">
          {portfolio.parts.map((p) => <button key={p.key} type="button" aria-pressed={p.key === part?.key} onClick={() => setSub({ ...sub, [sel]: p.key })}>{p.label} <span className="num">{p.m}</span></button>)}
        </div>
        {part && <PartView part={part} onBuySell={(r, type) => setTxn({ accountId: r.accountId, instrumentId: r.instrumentId ?? undefined, type, bucket: r.bucket as any })} onPrice={setOvr} onBalance={setBal} onAdd={(p) => setTxn({ accountId: p.rows[0]?.accountId })} />}
      </section>

      <section className="card" id="s-returns"><div className="sec-head"><h2>Return since cost</h2><small>Mutual funds, stocks and PMS stocks. Opening balances use the cost you gave.</small></div>
        <div className="legend">{d.portfolios.map((p) => <span key={p.code}><span className="dot" style={{ background: COLORS[p.code] }} />{p.label}</span>)}</div>
        <ReturnsChart rows={returns} /></section>

      <section className="card" id="s-market"><div className="sec-head"><h2>Market</h2><small>Index levels from your configured price source</small></div>
        <div className="idx">{d.indices.map((ix) => (
          <div className="ic" key={ix.id}><div className="n">{ix.name}</div>
            <div className="l num">{ix.level != null ? ix.level.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : 'no value'}</div>
            <div className={'num ' + cls(ix.dayPct)}>{ix.dayPct != null ? pct(ix.dayPct) : ix.dayPctText ?? ''}</div>
            <small className="xnote">{ix.kind} · {shortDate(ix.asOfDate)} · {ix.source}</small></div>))}
          {d.indices.length === 0 && <p className="xnote">No indices configured.</p>}</div></section>

      <section className="card" id="s-exposure"><div className="sec-head"><h2>Look-through: stocks you own directly and through funds</h2>
        <small>Fund holdings cover {(d.exposure.mfCoveredPct * 100).toFixed(0)}% of mutual-fund value (disclosures are monthly and may be out of date)</small></div>
        <Exposure ex={d.exposure} /></section>

      <section className="card" id="s-alloc"><div className="sec-head"><h2>Asset allocation</h2><small>Debt and cash inside funds use the latest month-end split where one is stored</small></div>
        <Donut items={d.allocation.map((a) => ({ key: a.key, label: a.label, value: a.value }))} />
        <div className="dleg" style={{ marginTop: 8 }}>{d.allocation.map((a) => <span key={a.key}>{a.label}: <span className="num">{money(a.value)} ({((a.value / t.value) * 100).toFixed(1)}%)</span></span>)}</div></section>

      <section className="card" id="s-history"><div className="sec-head"><h2>Value over time</h2><small>Not adjusted for money you add or withdraw</small></div>
        <HistoryChart rows={(snaps.data ?? []).map((s) => ({ date: s.date, total: s.total, cost: s.cost }))} />
        {(snaps.data ?? []).length > 0 && <div className="scroll2"><table><thead><tr><th>Date</th><th>Total</th><th>Cost</th><th>Personal</th><th>HUF</th><th>Sravanthi</th></tr></thead><tbody>
          {[...(snaps.data ?? [])].reverse().slice(0, 30).map((s) => <tr key={s.date} title={s.basis}><td>{s.date}</td><td className="num">{money(s.total)}</td><td className="num">{money(s.cost)}</td>{['Personal', 'HUF', 'Sravanthi'].map((k) => <td key={k} className="num">{s.data?.[k] ? money(s.data[k].v) : ''}</td>)}</tr>)}</tbody></table></div>}</section>

      <section className="card" id="s-watch"><div className="sec-head"><h2>Watchlist and dates</h2></div>
        <div className="wl">{(watch.data ?? []).map((w) => <div className="wi" key={w.id}><div className="wd">{w.when_label}<br />{w.category}</div><details><summary>{w.title}</summary><p>{w.detail}</p></details></div>)}</div></section>

      <section className="card notes" id="s-notes"><details><summary>Data notes and flags ({(flags.data ?? []).length})</summary>
        <ul>{(flags.data ?? []).map((f) => <li key={f.id}><details><summary>{String(f.text).slice(0, 110)}{String(f.text).length > 110 ? '…' : ''}</summary><p>{f.text}</p></details></li>)}</ul></details></section>

      <footer>A personal record, not investment advice. Anything marked not verified could not be confirmed from a source.</footer>

      {txn && <TxnModal prefill={txn} onClose={() => setTxn(null)} onSaved={reloadAll} />}
      {ovr && <OverrideModal row={ovr} onClose={() => setOvr(null)} onSaved={reloadAll} />}
      {bal && <BalanceModal row={bal} onClose={() => setBal(null)} onSaved={reloadAll} />}
    </div>
  );
}

function RefreshResult({ result, onClose }: { result: any[]; onClose: () => void }) {
  return (
    <div className="card" role="status">
      <div className="sec-head"><h2>Refresh result</h2><button className="btn ghost" onClick={onClose}>Dismiss</button></div>
      {result.map((r, i) => (
        <div key={i} className="refrow"><b>{r.job}</b> {r.skipped ? <Chip tone="warn">{r.skipped}</Chip> : <Chip tone={r.failed.length ? 'bad' : 'good'}>{r.updated} updated · {r.unchanged} unchanged{r.failed.length ? ` · ${r.failed.length} failed` : ''}</Chip>}
          {r.sources?.length > 0 && <span className="xnote"> via {r.sources.join(', ')}</span>}
          {[...r.failed, ...r.rejected, ...r.notes].slice(0, 6).map((m: string, j: number) => <div className="xnote" key={j}>• {m}</div>)}</div>))}
    </div>
  );
}

function PartView({ part, onBuySell, onPrice, onBalance, onAdd }: { part: Part; onBuySell: (r: Row, t: 'BUY' | 'SELL') => void; onPrice: (r: Row) => void; onBalance: (r: Row) => void; onAdd: (p: Part) => void }) {
  const g = part.value - part.cost;
  const canTxn = ['mf', 'stocks', 'pms', 'foreign', 'unvested', 'ulip'].includes(part.key);
  const rows = part.key === 'ulip' ? [] : [...part.rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return (
    <>
      <div className="hold-meta"><Chip>{part.m} holdings</Chip><Chip>Value {money(part.value)}</Chip><Chip>Cost {money(part.cost)}</Chip><Chip tone={g >= 0 ? 'good' : 'bad'}>{signed(g)} ({pct(part.cost ? part.value / part.cost - 1 : null)})</Chip>
        {canTxn && <button className="btn small" onClick={() => onAdd(part)}>+ Record transaction</button>}</div>
      {part.key === 'ulip' && part.policies?.map((p) => (
        <div key={p.accountId} className="pg" style={{ ['--c' as any]: 'var(--p-ulip)' }}>
          <div className="pgh" style={{ cursor: 'default' }}><span /><span className="pgn">{p.policy}<small>Cost {money(p.cost)} as given (not split by fund)</small></span><span className="pgv num">{money(p.value)}</span><span className={'num ' + cls(p.value - p.cost)}>{pct(p.cost ? p.value / p.cost - 1 : null)}</span><span /></div>
          <div className="pgb">{p.funds.map((r) => <HoldingRow key={r.key} r={r} showCost={false} onBuySell={onBuySell} onPrice={onPrice} onBalance={onBalance} />)}</div>
        </div>
      ))}
      {part.key !== 'ulip' && <><div className="hrow head"><div>Holding</div><div>Value</div><div>Since cost</div><div>Change</div></div>
        {rows.map((r) => <HoldingRow key={r.key} r={r} showCost onBuySell={onBuySell} onPrice={onPrice} onBalance={onBalance} />)}</>}
    </>
  );
}

function HoldingRow({ r, showCost, onBuySell, onPrice, onBalance }: { r: Row; showCost: boolean; onBuySell: (r: Row, t: 'BUY' | 'SELL') => void; onPrice: (r: Row) => void; onBalance: (r: Row) => void }) {
  const isBal = r.balanceId != null;
  const w = r.retPct == null ? 0 : Math.min(Math.abs(r.retPct) / 1, 1) * 50;
  return (
    <div className="hrow">
      <div className="hn">{r.shortName}
        <div className="sub">
          {r.plan && <Chip>{r.plan}</Chip>}{r.bucket === 'UNVESTED' && <Chip tone="warn">unvested</Chip>}
          {isBal ? <><Chip tone={r.undated ? 'warn' : undefined}>{r.undated ? 'undated' : 'as of ' + shortDate(r.priceDate)}</Chip><Chip tone="warn">not repriced</Chip></> : <PriceBadges r={r} />}
          {!isBal && r.price != null && <span className="num">{num(r.qty)} × {r.currency === 'INR' ? '₹' : r.currency + ' '}{num(r.price, 4)}</span>}
          {r.link && <a href={r.link} target="_blank" rel="noopener noreferrer">Source page</a>}
        </div>
        <div className="sub rowact">
          {r.instrumentId != null && <>
            <button className="lnk" onClick={() => onBuySell(r, 'BUY')}>Buy</button><button className="lnk" onClick={() => onBuySell(r, 'SELL')}>Sell</button>
            <button className="lnk" onClick={() => onPrice(r)}>Set price</button></>}
          {isBal && <button className="lnk" onClick={() => onBalance(r)}>Update balance</button>}
        </div>
      </div>
      <div className="hv"><div className="a" title={r.value != null ? exact(r.value) : ''}>{money(r.value)}</div><div className="b">{showCost && r.cost > 0 ? 'cost ' + money(r.cost) : isBal && r.cost ? 'invested ' + money(r.cost) : ''}{r.income > 0 ? ` · income ${money(r.income)}` : ''}</div></div>
      <div className="rt">{r.retPct != null ? <><span className={'p ' + cls(r.retPct)}>{pct(r.retPct)} <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r.value != null ? signed(r.value - r.cost) : ''}</span></span>
        <span className="track"><i style={{ left: r.retPct >= 0 ? '50%' : `${50 - w}%`, width: w + '%', background: r.retPct >= 0 ? 'var(--good)' : 'var(--bad)' }} /></span></> : <span className="p" style={{ color: 'var(--muted)' }}>n/a</span>}</div>
      <div className="chg">{r.day != null ? <><span className={'num ' + cls(r.day)}>{signed(r.day)}</span><small className={cls(r.dayPct)}>{pct(r.dayPct)}{r.prevPrice != null ? ` vs ${num(r.prevPrice, 2)}` : ''}</small></> : <span className="chip warn">no previous value</span>}</div>
    </div>
  );
}

function Exposure({ ex }: { ex: D['exposure'] }) {
  const max = ex.top[0]?.total || 1;
  return (
    <>
      <div className="xhead"><span>#</span><span>Stock</span><span>Direct vs via funds</span><span className="val">Total</span><span className="tdy"> </span></div>
      <div className="xlist">{ex.top.map((r) => (
        <details className="xi" key={r.rank}>
          <summary><span className="rk">{r.rank}</span><span className="nm">{r.name}<small>{r.direct > 0 ? 'direct ' + money(r.direct) + ' · ' : ''}{r.via.length} fund{r.via.length === 1 ? '' : 's'}</small></span>
            <span className="bar" style={{ width: `${(r.total / max) * 100}%` }}><i style={{ width: `${(r.direct / r.total) * 100}%`, background: 'var(--x-direct)' }} /><i style={{ width: `${(r.viaTotal / r.total) * 100}%`, background: 'var(--x-fund)' }} /></span>
            <span className="val">{money(r.total)}</span><span className="tdy" /></summary>
          <div className="brk">{r.direct > 0 && <div><span>Direct holding</span><span className="num">{money(r.direct)}</span></div>}{r.via.map((v: any, i: number) => <div key={i}><span>{v.fund}</span><span className="num">{money(v.value)}</span></div>)}</div>
        </details>))}</div>
      <div className="legend" style={{ marginTop: 10 }}><span><span className="dot" style={{ background: 'var(--x-direct)' }} />Direct</span><span><span className="dot" style={{ background: 'var(--x-fund)' }} />Through funds</span></div>
      {ex.excluded?.length > 0 && <details className="xfunds"><summary>Funds left out of the look-through ({ex.excluded.length})</summary><ul>{ex.excluded.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul></details>}
    </>
  );
}
