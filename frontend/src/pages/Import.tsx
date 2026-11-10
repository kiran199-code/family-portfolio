import { useState } from 'react';
import { post } from '../api';
import { money, num } from '../format';

const SAMPLE = 'date,account,instrument,type,quantity,price,amount,charges,notes\n2026-11-17,Personal/Mutual funds,103360,BUY,10,,1700,,SIP\n';

export default function Import() {
  const [csv, setCsv] = useState(SAMPLE);
  const [prev, setPrev] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [owner, setOwner] = useState('Personal');
  const [stmt, setStmt] = useState('instrument,units\n103360,4358.544');
  const [recon, setRecon] = useState<any>(null);

  const preview = async () => { setErr(null); setMsg(null); try { setPrev(await post('/api/import/preview', { csv, filename: 'pasted.csv' })); } catch (e: any) { setErr(e.details?.join('; ') ?? e.message); } };
  const commit = async (includeDuplicates = false) => { try { const r = await post('/api/import/commit', { batchId: prev.batchId, includeDuplicates }); setMsg(`Imported ${r.inserted} transactions.`); setPrev(null); } catch (e: any) { setErr(e.message); } };
  const onFile = async (f?: File) => { if (f) setCsv(await f.text()); };
  const runRecon = async () => {
    try {
      const lines = stmt.trim().split(/\r?\n/).slice(1).map((l) => l.split(',').map((x) => x.trim()));
      setRecon(await post('/api/reconcile', { owner, statement: lines.map(([instrument, units]) => ({ instrument, units: Number(units) })) }));
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="wrap">
      <section className="card">
        <div className="sec-head"><h2>Import transactions (CSV)</h2></div>
        <p className="xnote">Columns: date, account, instrument, type, quantity, price, amount, charges, bucket, fx_rate, notes. <b>account</b> is “Owner/Account label” (e.g. Personal/Mutual funds). <b>instrument</b> is the AMFI code, ISIN, symbol or exact name. CAMS/KFintech PDFs and broker-specific tradebooks are not read directly; convert them to this layout first. You always see a preview before anything is written.</p>
        <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
        <textarea className="mono" rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} aria-label="CSV text" />
        <div className="actions"><button className="btn primary" onClick={preview}>Preview</button></div>
        {err && <div className="banner-err" role="alert">{err}</div>}
        {msg && <div className="chip good">{msg}</div>}
        {prev && (
          <>
            <p><b>{prev.ok}</b> ready · <b>{prev.duplicates}</b> possible duplicates · <b className={prev.errors ? 'neg' : ''}>{prev.errors}</b> with errors</p>
            <div className="scroll2"><table><thead><tr><th>Line</th><th>Account</th><th>Instrument</th><th>Type</th><th>Units</th><th>Status</th></tr></thead><tbody>
              {prev.rows.map((r: any) => <tr key={r.line}><td>{r.line}</td><td>{r.accountLabel ?? r.raw.account}</td><td>{r.instrumentName ?? r.raw.instrument}</td><td>{r.input?.type ?? r.raw.type}</td><td className="num">{r.input?.quantity ?? ''}</td><td className={r.error ? 'neg' : r.duplicate ? '' : 'pos'}>{r.error ?? (r.duplicate ? 'possible duplicate (skipped)' : 'ok')}</td></tr>)}</tbody></table></div>
            {prev.changes.length > 0 && <><h3 className="sub-h">What changes</h3><div className="scroll2"><table><thead><tr><th>Instrument</th><th>Units before → after</th><th>Cost before → after</th></tr></thead><tbody>
              {prev.changes.map((c: any, i: number) => <tr key={i}><td>{c.instrument}</td><td className="num">{num(c.beforeQty)} → {num(c.afterQty)}</td><td className="num">{money(c.beforeCost)} → {money(c.afterCost)}</td></tr>)}</tbody></table></div></>}
            <div className="actions"><button className="btn primary" disabled={prev.errors > 0 || prev.ok === 0} onClick={() => commit(false)}>Commit {prev.ok} rows</button></div>
          </>
        )}
      </section>
      <section className="card">
        <div className="sec-head"><h2>Reconcile with a statement</h2></div>
        <p className="xnote">Paste units from your CAMS/KFintech or broker statement (instrument,units) to see where the ledger disagrees.</p>
        <label className="fld"><span>Owner</span><select value={owner} onChange={(e) => setOwner(e.target.value)}><option>Personal</option><option>HUF</option><option>Sravanthi</option></select></label>
        <textarea className="mono" rows={5} value={stmt} onChange={(e) => setStmt(e.target.value)} aria-label="Statement units" />
        <div className="actions"><button className="btn" onClick={runRecon}>Compare</button></div>
        {recon && (recon.differences.length === 0 ? <div className="chip good">Ledger matches the statement for the {recon.checked} rows checked</div> :
          <div className="scroll2"><table><thead><tr><th>Instrument</th><th>Statement</th><th>Ledger</th><th>Difference</th><th /></tr></thead><tbody>{recon.differences.map((d: any, i: number) => <tr key={i}><td>{d.instrument}</td><td className="num">{d.statementUnits ?? ''}</td><td className="num">{d.ledgerUnits != null ? num(d.ledgerUnits) : ''}</td><td className="num neg">{d.difference != null ? num(d.difference) : ''}</td><td>{d.note ?? ''}</td></tr>)}</tbody></table></div>)}
      </section>
    </div>
  );
}
