// Pure ledger engine. No database access. Given every transaction of one account it derives
// tax lots, holdings, realised gains and income. Rebuilding from the ledger always gives the same answer.

export type TxnType =
  | 'OPENING' | 'BUY' | 'SELL' | 'SIP' | 'SWITCH_IN' | 'SWITCH_OUT' | 'DIVIDEND'
  | 'BONUS' | 'SPLIT' | 'DEMERGER' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'VEST' | 'FEE';
export type Bucket = 'AVAILABLE' | 'UNVESTED';

export interface LedgerTxn {
  id: number;
  instrumentId: number;
  date: string; // YYYY-MM-DD
  type: TxnType;
  bucket?: Bucket;
  quantity?: number | null;
  amountInr?: number | null;
  charges?: number | null;
  ratioNum?: number | null;
  ratioDen?: number | null;
  costFraction?: number | null;
  refInstrumentId?: number | null;
}

export interface Lot {
  sourceTxnId: number;
  instrumentId: number;
  bucket: Bucket;
  acquired: string;
  opening: boolean;
  qty: number;
  unitCost: number;
}

export interface RealisedRow {
  sellTxnId: number;
  lotTxnId: number;
  instrumentId: number;
  qty: number;
  acquired: string;
  sold: string;
  openingLot: boolean;
  cost: number;
  proceeds: number;
  gain: number;
  holdingDays: number;
}

export interface HoldingRow { instrumentId: number; bucket: Bucket; quantity: number; cost: number; income: number }
export interface IncomeRow { txnId: number; instrumentId: number; date: string; amount: number }

export interface LedgerResult {
  lots: Lot[];
  holdings: HoldingRow[];
  realised: RealisedRow[];
  income: IncomeRow[];
}

export class LedgerError extends Error {
  constructor(message: string, public txnId?: number) {
    super(message);
  }
}

const EPS = 1e-6;
const ADD_TYPES = new Set<TxnType>(['OPENING', 'BUY', 'SIP', 'SWITCH_IN', 'TRANSFER_IN']);
const REALISING_OUT = new Set<TxnType>(['SELL', 'SWITCH_OUT']);

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

export function replay(input: LedgerTxn[]): LedgerResult {
  const txns = [...input].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  const lots: Lot[] = [];
  const realised: RealisedRow[] = [];
  const income: IncomeRow[] = [];

  const need = (v: number | null | undefined, what: string, t: LedgerTxn): number => {
    if (v == null || !Number.isFinite(v)) throw new LedgerError(`${t.type} needs ${what}`, t.id);
    return v;
  };
  const sortLots = (ls: Lot[]) => ls.sort((a, b) => (a.acquired < b.acquired ? -1 : a.acquired > b.acquired ? 1 : a.sourceTxnId - b.sourceTxnId));
  const liveLots = (inst: number, bucket: Bucket) => sortLots(lots.filter((l) => l.instrumentId === inst && l.bucket === bucket && l.qty > EPS));

  for (const t of txns) {
    const bucket: Bucket = t.bucket ?? 'AVAILABLE';
    const charges = t.charges ?? 0;

    if (ADD_TYPES.has(t.type)) {
      const q = need(t.quantity, 'quantity', t);
      if (q <= 0) throw new LedgerError(`${t.type} quantity must be positive`, t.id);
      const amt = t.amountInr ?? 0;
      lots.push({
        sourceTxnId: t.id, instrumentId: t.instrumentId, bucket, acquired: t.date,
        opening: t.type === 'OPENING', qty: q, unitCost: (amt + charges) / q,
      });
    } else if (t.type === 'BONUS') {
      const q = need(t.quantity, 'quantity', t);
      lots.push({ sourceTxnId: t.id, instrumentId: t.instrumentId, bucket, acquired: t.date, opening: false, qty: q, unitCost: 0 });
    } else if (REALISING_OUT.has(t.type) || t.type === 'TRANSFER_OUT') {
      let remaining = need(t.quantity, 'quantity', t);
      const available = liveLots(t.instrumentId, bucket).reduce((s, l) => s + l.qty, 0);
      if (remaining > available + EPS) {
        throw new LedgerError(`Cannot ${t.type.toLowerCase()} ${remaining}: only ${available} held on ${t.date}`, t.id);
      }
      const totalQty = remaining;
      const proceedsTotal = (t.amountInr ?? 0) - charges;
      for (const lot of liveLots(t.instrumentId, bucket)) {
        if (remaining <= EPS) break;
        const take = Math.min(lot.qty, remaining);
        if (REALISING_OUT.has(t.type)) {
          const cost = take * lot.unitCost;
          const proceeds = (proceedsTotal * take) / totalQty;
          realised.push({
            sellTxnId: t.id, lotTxnId: lot.sourceTxnId, instrumentId: t.instrumentId, qty: take,
            acquired: lot.acquired, sold: t.date, openingLot: lot.opening, cost, proceeds,
            gain: proceeds - cost, holdingDays: daysBetween(lot.acquired, t.date),
          });
        }
        lot.qty -= take;
        remaining -= take;
      }
    } else if (t.type === 'SPLIT') {
      const num = need(t.ratioNum, 'ratioNum', t), den = need(t.ratioDen, 'ratioDen', t);
      if (num <= 0 || den <= 0) throw new LedgerError('SPLIT ratio must be positive', t.id);
      for (const l of lots) if (l.instrumentId === t.instrumentId && l.qty > EPS) { l.qty = (l.qty * num) / den; l.unitCost = (l.unitCost * den) / num; }
    } else if (t.type === 'DEMERGER') {
      const ref = need(t.refInstrumentId, 'refInstrumentId', t);
      const num = need(t.ratioNum, 'ratioNum', t), den = need(t.ratioDen, 'ratioDen', t), f = need(t.costFraction, 'costFraction', t);
      if (f < 0 || f > 1) throw new LedgerError('costFraction must be between 0 and 1', t.id);
      const created: Lot[] = [];
      for (const l of lots) {
        if (l.instrumentId !== t.instrumentId || l.qty <= EPS) continue;
        const newQty = (l.qty * num) / den;
        created.push({ sourceTxnId: l.sourceTxnId, instrumentId: ref, bucket: l.bucket, acquired: l.acquired, opening: l.opening, qty: newQty, unitCost: (l.unitCost * f * l.qty) / newQty });
        l.unitCost = l.unitCost * (1 - f);
      }
      lots.push(...created);
    } else if (t.type === 'VEST') {
      let remaining = need(t.quantity, 'quantity', t);
      const unv = liveLots(t.instrumentId, 'UNVESTED');
      if (remaining > unv.reduce((s, l) => s + l.qty, 0) + EPS) throw new LedgerError('Not enough unvested units to vest', t.id);
      const newCost = t.amountInr != null ? t.amountInr / remaining : null;
      for (const l of unv) {
        if (remaining <= EPS) break;
        const take = Math.min(l.qty, remaining);
        l.qty -= take;
        remaining -= take;
        lots.push({ sourceTxnId: t.id, instrumentId: t.instrumentId, bucket: 'AVAILABLE', acquired: newCost != null ? t.date : l.acquired, opening: l.opening && newCost == null, qty: take, unitCost: newCost ?? l.unitCost });
      }
    } else if (t.type === 'DIVIDEND') {
      income.push({ txnId: t.id, instrumentId: t.instrumentId, date: t.date, amount: need(t.amountInr, 'amountInr', t) - charges });
    }
    // FEE: recorded in the ledger only.
  }

  const hmap = new Map<string, HoldingRow>();
  for (const l of lots) {
    if (l.qty <= EPS) continue;
    const k = `${l.instrumentId}|${l.bucket}`;
    const h = hmap.get(k) ?? { instrumentId: l.instrumentId, bucket: l.bucket, quantity: 0, cost: 0, income: 0 };
    h.quantity += l.qty;
    h.cost += l.qty * l.unitCost;
    hmap.set(k, h);
  }
  for (const i of income) {
    const k = `${i.instrumentId}|AVAILABLE`;
    const h = hmap.get(k) ?? { instrumentId: i.instrumentId, bucket: 'AVAILABLE' as Bucket, quantity: 0, cost: 0, income: 0 };
    h.income += i.amount;
    hmap.set(k, h);
  }
  return { lots: lots.filter((l) => l.qty > EPS), holdings: [...hmap.values()], realised, income };
}

/** Preview: what changes if `candidate` is added. Throws LedgerError when the ledger would become invalid. */
export function preview(existing: LedgerTxn[], candidate: LedgerTxn) {
  const before = replay(existing);
  const after = replay([...existing, candidate]);
  const pick = (r: LedgerResult) => r.holdings.filter((h) => h.instrumentId === candidate.instrumentId);
  const newRealised = after.realised.filter((r) => r.sellTxnId === candidate.id);
  return {
    before: pick(before),
    after: pick(after),
    realisedGain: newRealised.reduce((s, r) => s + r.gain, 0),
    realised: newRealised,
    // Rebuilding with a back-dated transaction can change realised gains of later trades.
    laterRealisedChanged: Math.abs(after.realised.filter((r) => r.sellTxnId !== candidate.id).reduce((s, r) => s + r.gain, 0) - before.realised.reduce((s, r) => s + r.gain, 0)) > 0.005,
  };
}
