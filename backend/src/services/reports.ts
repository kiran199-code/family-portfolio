import { pool } from '../db.js';
import { xirr, Flow } from '../domain/xirr.js';
import { effectivePrices, fxRates } from './dashboard.js';
import { istDate } from './calendar.js';

/** Indian financial year of a date: 'FY 2025-26' for 1 Apr 2025 to 31 Mar 2026. */
export function fyOf(date: string): string {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  const s = m >= 4 ? y : y - 1;
  return `FY ${s}-${String((s + 1) % 100).padStart(2, '0')}`;
}

export async function gainsReport(fy?: string) {
  const rows = (await pool.query(
    `select g.*, to_char(g.acquired,'YYYY-MM-DD') acq, to_char(g.sold,'YYYY-MM-DD') sold_d, i.name instrument, i.asset_class, o.code owner
       from realised_gain g join instrument i on i.id=g.instrument_id join account a on a.id=g.account_id join owner o on o.id=a.owner_id order by g.sold, g.id`)).rows;
  const out = rows.map((r) => ({
    owner: r.owner, instrument: r.instrument, assetClass: r.asset_class, qty: r.qty, acquired: r.acq, sold: r.sold_d, fy: fyOf(r.sold_d), holdingDays: r.holding_days,
    cost: r.cost_inr, proceeds: r.proceeds_inr, gain: r.gain_inr, openingLot: r.opening_lot,
    // Display bucket only. Tax rules differ by asset class and purchase date: do NOT use this for filing without checking current rules.
    bucket: r.opening_lot ? 'unknown (opening balance)' : r.holding_days > 365 ? 'over 1 year' : 'up to 1 year',
  })).filter((r) => !fy || r.fy === fy);
  const sum = (f: (x: typeof out[0]) => boolean) => out.filter(f).reduce((s, x) => s + x.gain, 0);
  return {
    fy: fy ?? 'all', rows: out,
    totals: { gain: sum(() => true), upTo1y: sum((x) => x.bucket === 'up to 1 year'), over1y: sum((x) => x.bucket === 'over 1 year'), unknown: sum((x) => x.openingLot) },
    caution: 'Holding-period buckets use a simple 365-day split for display only. Capital-gains tax rules differ by asset class, purchase date and fund type. Verify against the current Income Tax Act before relying on any figure. Opening balances have no acquisition date, so their period is unknown.',
  };
}

export async function incomeReport() {
  const r = (await pool.query(`select to_char(d.on_date,'YYYY-MM-DD') d, d.amount_inr, i.name instrument, o.code owner from income d join instrument i on i.id=d.instrument_id join account a on a.id=d.account_id join owner o on o.id=a.owner_id order by d.on_date`)).rows;
  const byFy: Record<string, number> = {};
  for (const x of r) byFy[fyOf(x.d)] = (byFy[fyOf(x.d)] ?? 0) + x.amount_inr;
  return { rows: r.map((x) => ({ owner: x.owner, instrument: x.instrument, date: x.d, amount: x.amount_inr, fy: fyOf(x.d) })), byFy };
}

/**
 * XIRR per owner from real dated cash flows only. Opening balances have no purchase date, so they are left out of
 * both the flows and the terminal value; `coverage` says how much of the portfolio is therefore measurable.
 */
export async function xirrReport() {
  const prices = await effectivePrices(pool), fx = await fxRates(pool);
  const factor = (ccy: string) => (ccy === 'INR' ? 1 : fx.get(ccy + 'INR')?.rate ?? NaN);
  const owners = (await pool.query('select id, code from owner order by id')).rows;
  const today = istDate();
  const out = [];
  for (const o of owners) {
    const flows: Flow[] = [];
    const buys = (await pool.query(
      `select to_char(t.trade_date,'YYYY-MM-DD') d, t.amount_inr, t.charges from txn t join account a on a.id=t.account_id where a.owner_id=$1 and t.deleted_at is null and t.type in ('BUY','SIP','SWITCH_IN') and t.amount_inr is not null`, [o.id])).rows;
    for (const b of buys) flows.push({ date: b.d, amount: -(b.amount_inr + (b.charges ?? 0)) });
    const sells = (await pool.query(`select to_char(g.sold,'YYYY-MM-DD') d, sum(g.proceeds_inr) p from realised_gain g join account a on a.id=g.account_id where a.owner_id=$1 and not g.opening_lot group by g.sold`, [o.id])).rows;
    for (const s of sells) flows.push({ date: s.d, amount: s.p });
    const lots = (await pool.query(`select l.instrument_id, i.currency, sum(l.qty) q from tax_lot l join account a on a.id=l.account_id join instrument i on i.id=l.instrument_id where a.owner_id=$1 and not l.opening group by l.instrument_id, i.currency`, [o.id])).rows;
    let terminal = 0;
    for (const l of lots) { const p = prices.get(l.instrument_id)?.price; if (p != null) terminal += l.q * p * factor(l.currency); }
    if (terminal > 0) flows.push({ date: today, amount: terminal });
    const total = (await pool.query(`select coalesce(sum(h.quantity * p.price),0) v from holding h join account a on a.id=h.account_id left join price_cache p on p.instrument_id=h.instrument_id where a.owner_id=$1`, [o.id])).rows[0].v;
    out.push({ owner: o.code, xirr: xirr(flows), flowCount: flows.length, measurableValue: terminal, coverage: total ? Math.min(1, terminal / total) : 0 });
  }
  return { owners: out, note: 'Only transactions with a real date are measured. A portfolio made only of opening balances has no XIRR until purchases are recorded or acquisition dates are added. Dividends are not included.' };
}
