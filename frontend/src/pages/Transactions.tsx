import { useState } from 'react';
import { get, api, getToken } from '../api';
import { useAsync } from '../components/Common';
import { TxnModal } from '../components/TxnModal';
import { money, num } from '../format';

export default function Transactions() {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const list = useAsync<any[]>(() => get('/api/transactions?limit=1000'));
  const rows = (list.data ?? []).filter((r) => !q || (r.instrument + ' ' + r.owner + ' ' + r.type + ' ' + r.account).toLowerCase().includes(q.toLowerCase()));
  const del = async (id: number) => {
    if (!confirm('Delete this transaction? Holdings and gains are rebuilt from the remaining ledger. If a later trade would become invalid the delete is refused.')) return;
    try { await api('DELETE', `/api/transactions/${id}`); setErr(null); list.reload(); } catch (e: any) { setErr(e.message); }
  };
  const exportCsv = async () => {
    const res = await fetch('/api/export/transactions.csv', { headers: { authorization: `Bearer ${getToken()}` } });
    const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = 'transactions.csv'; a.click();
  };
  return (
    <div className="wrap">
      <section className="card">
        <div className="sec-head"><h2>Transactions</h2><div className="hold-meta"><button className="btn primary" onClick={() => setAdding(true)}>+ Record transaction</button><button className="btn" onClick={exportCsv}>Export CSV</button></div></div>
        <p className="xnote">The ledger is the source of truth. Units, average cost, tax lots and realised gains are rebuilt from it after every change. “OPENING” rows are the balances imported from your prototype (their purchase dates are unknown).</p>
        <input className="search" placeholder="Filter by instrument, owner or type" value={q} onChange={(e) => setQ(e.target.value)} />
        {err && <div className="banner-err" role="alert">{err}</div>}
        <div className="scroll2"><table><thead><tr><th>Date</th><th>Owner / account</th><th>Instrument</th><th>Type</th><th>Units</th><th>Amount (INR)</th><th>Charges</th><th>Source</th><th /></tr></thead><tbody>
          {rows.map((r) => <tr key={r.id}><td>{r.date}</td><td>{r.owner} / {r.account}</td><td>{r.instrument}{r.bucket === 'UNVESTED' ? ' (unvested)' : ''}</td><td>{r.type}</td><td className="num">{r.quantity != null ? num(r.quantity) : ''}</td><td className="num">{r.amount_inr != null ? money(r.amount_inr) : ''}{r.currency !== 'INR' && r.amount != null ? ` (${r.currency} ${num(r.amount, 2)})` : ''}</td><td className="num">{r.charges ? money(r.charges) : ''}</td><td>{r.source}</td>
            <td><button className="lnk" onClick={() => del(r.id)}>Delete</button></td></tr>)}</tbody></table></div>
        {list.loading && <p>Loading…</p>}
      </section>
      {adding && <TxnModal onClose={() => setAdding(false)} onSaved={list.reload} />}
    </div>
  );
}
