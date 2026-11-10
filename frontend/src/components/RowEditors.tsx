import { useState } from 'react';
import { post, api } from '../api';
import { Modal } from './Common';
import type { Row } from '../types';

export function OverrideModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const [price, setPrice] = useState(''); const [date, setDate] = useState(new Date().toISOString().slice(0, 10)); const [reason, setReason] = useState(''); const [err, setErr] = useState<string | null>(null);
  const save = async () => { try { await post('/api/overrides', { instrumentId: row.instrumentId, price: Number(price), asOfDate: date, reason: reason || undefined }); onSaved(); onClose(); } catch (e: any) { setErr(e.details?.join('; ') ?? e.message); } };
  return (
    <Modal title={`Enter a price by hand: ${row.shortName}`} onClose={onClose}>
      <p className="xnote">Use this when no live source has the value (for example a ULIP NAV or an unmapped stock). It is labelled “manual” everywhere and is replaced automatically when a newer live value arrives. Current: {row.price ?? 'none'} ({row.priceDate ?? 'undated'}).</p>
      <div className="form">
        <label className="fld"><span>Price / NAV ({row.currency})</span><input type="number" step="any" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
        <label className="fld"><span>As of</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="fld wide"><span>Where did it come from?</span><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. insurer portal, broker app" /></label>
      </div>
      {err && <div className="banner-err" role="alert">{err}</div>}
      <div className="actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!price || Number(price) <= 0} onClick={save}>Save</button></div>
    </Modal>
  );
}

export function BalanceModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(String(row.value ?? '')); const [cost, setCost] = useState(row.cost ? String(row.cost) : ''); const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10)); const [err, setErr] = useState<string | null>(null);
  const save = async () => { try { await api('PUT', `/api/balances/${row.balanceId}`, { value: Number(value), cost: cost === '' ? null : Number(cost), asOf: asOf || null }); onSaved(); onClose(); } catch (e: any) { setErr(e.details?.join('; ') ?? e.message); } };
  return (
    <Modal title={`Update balance: ${row.name}`} onClose={onClose}>
      <p className="xnote">This asset has no live source, so it is valued as you enter it. Every change is recorded in the audit log.</p>
      <div className="form">
        <label className="fld"><span>Value (INR)</span><input type="number" step="any" value={value} onChange={(e) => setValue(e.target.value)} /></label>
        <label className="fld"><span>Cost / invested (INR)</span><input type="number" step="any" value={cost} onChange={(e) => setCost(e.target.value)} /></label>
        <label className="fld"><span>As of</span><input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
      </div>
      {err && <div className="banner-err" role="alert">{err}</div>}
      <div className="actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={value === ''} onClick={save}>Save</button></div>
    </Modal>
  );
}
