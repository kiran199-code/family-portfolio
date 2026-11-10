import { useEffect, useMemo, useState } from 'react';
import { get, post, ApiError } from '../api';
import { Modal } from './Common';
import { money, num, signed } from '../format';

const TYPES = ['BUY', 'SELL', 'SIP', 'SWITCH_IN', 'SWITCH_OUT', 'DIVIDEND', 'BONUS', 'SPLIT', 'DEMERGER', 'TRANSFER_IN', 'TRANSFER_OUT', 'VEST'] as const;
const HELP: Record<string, string> = {
  BUY: 'Adds units. Charges are added to cost.', SELL: 'Uses the oldest units first (FIFO) and records the realised gain.', SIP: 'A regular purchase, same as BUY.',
  SWITCH_IN: 'Units received from a switch.', SWITCH_OUT: 'Units redeemed in a switch (a realised sale).', DIVIDEND: 'Income received. Enter the amount only.',
  BONUS: 'Free units at zero cost. Enter the quantity.', SPLIT: 'Enter new units per old unit, e.g. 5 and 1 for a 5-for-1 split. Total cost is unchanged.',
  DEMERGER: 'Moves part of the cost to a new instrument. Enter the new units per old unit, the cost share (0 to 1) and the new instrument.',
  TRANSFER_IN: 'Units moved in from elsewhere (no sale).', TRANSFER_OUT: 'Units moved out (not a sale, no gain recorded).', VEST: 'Moves unvested units to available.',
};

export interface TxnPrefill { accountId?: number; instrumentId?: number; type?: (typeof TYPES)[number]; bucket?: 'AVAILABLE' | 'UNVESTED' }

export function TxnModal({ prefill, onClose, onSaved }: { prefill?: TxnPrefill; onClose: () => void; onSaved: () => void }) {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [insts, setInsts] = useState<any[]>([]);
  const [f, setF] = useState<Record<string, string>>({ type: prefill?.type ?? 'BUY', accountId: String(prefill?.accountId ?? ''), instrumentId: String(prefill?.instrumentId ?? ''), bucket: prefill?.bucket ?? 'AVAILABLE', date: new Date().toISOString().slice(0, 10) });
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => { get('/api/accounts').then(setAccounts); get('/api/instruments').then(setInsts); }, []);
  const inst = insts.find((i) => String(i.id) === f.instrumentId);
  const foreign = inst && inst.currency !== 'INR';
  const type = f.type;
  const showQty = !['DIVIDEND'].includes(type), showAmt = ['BUY', 'SELL', 'SIP', 'SWITCH_IN', 'SWITCH_OUT', 'DIVIDEND', 'VEST'].includes(type), showRatio = ['SPLIT', 'DEMERGER'].includes(type);

  const body = useMemo(() => {
    const n = (k: string) => (f[k] === undefined || f[k] === '' ? undefined : Number(f[k]));
    if (!f.accountId || !f.instrumentId || !f.date) return null;
    return {
      accountId: Number(f.accountId), instrumentId: Number(f.instrumentId), date: f.date, type, bucket: f.bucket, quantity: showQty ? n('quantity') : undefined,
      price: n('price'), amount: n('amount'), fxRate: n('fxRate'), charges: n('charges'), ratioNum: n('ratioNum'), ratioDen: n('ratioDen'), costFraction: n('costFraction'),
      refInstrumentId: n('refInstrumentId'), notes: f.notes || undefined,
    };
  }, [f, type, showQty]);

  useEffect(() => {
    if (!body) { setPreview(null); return; }
    const t = setTimeout(() => { post('/api/transactions/preview', body).then((p) => { setPreview(p); setErr(null); }).catch((e: ApiError) => { setPreview(null); setErr(e.details?.join('; ') ?? e.message); }); }, 350);
    return () => clearTimeout(t);
  }, [body]);

  const save = async () => {
    if (!body) return; setBusy(true);
    try { await post('/api/transactions', body); onSaved(); onClose(); } catch (e: any) { setErr(e.details?.join('; ') ?? e.message); } finally { setBusy(false); }
  };
  const input = (k: string, label: string, p: { type?: string; step?: string; placeholder?: string } = {}) => (
    <label className="fld"><span>{label}</span><input value={f[k] ?? ''} onChange={(e) => set(k, e.target.value)} type={p.type ?? 'number'} step={p.step ?? 'any'} placeholder={p.placeholder} /></label>
  );
  const before = preview?.before?.[0], after = preview?.after?.find((h: any) => h.bucket === f.bucket) ?? preview?.after?.[0];

  return (
    <Modal title="Record a transaction" onClose={onClose}>
      <div className="form">
        <label className="fld"><span>Type</span><select value={type} onChange={(e) => set('type', e.target.value)}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
        <label className="fld"><span>Date</span><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></label>
        <label className="fld wide"><span>Account</span><select value={f.accountId} onChange={(e) => set('accountId', e.target.value)}><option value="">Choose…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.owner} / {a.label}</option>)}</select></label>
        <label className="fld wide"><span>Instrument</span><select value={f.instrumentId} onChange={(e) => set('instrumentId', e.target.value)}><option value="">Choose…</option>{insts.filter((i) => i.asset_class !== 'INDEX').map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
        <p className="xnote wide">{HELP[type]}</p>
        {showQty && input('quantity', 'Quantity / units')}
        {showAmt && type !== 'DIVIDEND' && input('price', `Price${inst ? ' (' + inst.currency + ')' : ''}`)}
        {showAmt && input('amount', `Total amount${inst ? ' (' + inst.currency + ')' : ''}`)}
        {foreign && input('fxRate', `${inst.currency}/INR rate on the trade date`)}
        {['BUY', 'SELL', 'SIP', 'SWITCH_IN', 'SWITCH_OUT'].includes(type) && input('charges', 'Charges (INR)')}
        {showRatio && input('ratioNum', 'New units …')}{showRatio && input('ratioDen', '… per this many old units')}
        {type === 'DEMERGER' && input('costFraction', 'Cost share moved (0 to 1)')}
        {type === 'DEMERGER' && <label className="fld wide"><span>New instrument</span><select value={f.refInstrumentId ?? ''} onChange={(e) => set('refInstrumentId', e.target.value)}><option value="">Choose…</option>{insts.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>}
        {(type === 'VEST' || f.bucket === 'UNVESTED' || inst?.currency !== 'INR') && <label className="fld"><span>Bucket</span><select value={f.bucket} onChange={(e) => set('bucket', e.target.value)}><option>AVAILABLE</option><option>UNVESTED</option></select></label>}
        <label className="fld wide"><span>Notes</span><input type="text" value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></label>
      </div>
      {err && <div className="banner-err" role="alert">{err}</div>}
      {preview?.ok && (
        <div className="preview" aria-live="polite">
          <b>After this transaction</b>
          <div>Units: <span className="num">{num(before?.quantity ?? 0)}</span> → <span className="num">{num(after?.quantity ?? 0)}</span></div>
          <div>Cost: <span className="num">{money(before?.cost ?? 0)}</span> → <span className="num">{money(after?.cost ?? 0)}</span>{after?.quantity ? <> · average <span className="num">{money(after.cost / after.quantity)}</span> per unit</> : null}</div>
          {preview.realised?.length > 0 && <div>Realised gain: <b className={preview.realisedGain >= 0 ? 'pos' : 'neg'}>{signed(preview.realisedGain)}</b>{preview.realised.some((r: any) => r.openingLot) && <span className="xnote"> (part of this uses an opening balance whose purchase date is unknown)</span>}</div>}
          {preview.laterRealisedChanged && <div className="chip warn">This back-dated entry changes realised gains of later trades</div>}
        </div>
      )}
      <div className="actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !body || !preview?.ok} onClick={save}>{busy ? 'Saving…' : 'Confirm and save'}</button></div>
    </Modal>
  );
}
