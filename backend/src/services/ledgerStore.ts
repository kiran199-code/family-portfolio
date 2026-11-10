import type pg from 'pg';
import { replay, LedgerTxn, LedgerResult } from '../domain/ledger.js';

type C = pg.PoolClient | pg.Pool;

export async function loadLedger(c: C, accountId: number): Promise<LedgerTxn[]> {
  const r = await c.query(
    `select id, instrument_id, to_char(trade_date,'YYYY-MM-DD') d, type, bucket, quantity, amount_inr, charges, ratio_num, ratio_den, cost_fraction, ref_instrument_id
       from txn where account_id=$1 and deleted_at is null order by trade_date, id`, [accountId]);
  return r.rows.map((x) => ({
    id: Number(x.id), instrumentId: x.instrument_id, date: x.d, type: x.type, bucket: x.bucket, quantity: x.quantity,
    amountInr: x.amount_inr, charges: x.charges, ratioNum: x.ratio_num, ratioDen: x.ratio_den, costFraction: x.cost_fraction, refInstrumentId: x.ref_instrument_id,
  }));
}

/** Replays the ledger of one account and rewrites the derived tables. Throws LedgerError (and writes nothing) if the ledger is invalid. */
export async function rebuildAccount(c: pg.PoolClient, accountId: number): Promise<LedgerResult> {
  const res = replay(await loadLedger(c, accountId));
  await c.query('delete from tax_lot where account_id=$1', [accountId]);
  await c.query('delete from holding where account_id=$1', [accountId]);
  await c.query('delete from realised_gain where account_id=$1', [accountId]);
  await c.query('delete from income where account_id=$1', [accountId]);
  for (const l of res.lots) await c.query('insert into tax_lot(account_id,instrument_id,bucket,source_txn_id,acquired,opening,qty,unit_cost_inr) values ($1,$2,$3,$4,$5,$6,$7,$8)', [accountId, l.instrumentId, l.bucket, l.sourceTxnId, l.acquired, l.opening, l.qty, l.unitCost]);
  for (const h of res.holdings) await c.query('insert into holding(account_id,instrument_id,bucket,quantity,cost_inr,income_inr) values ($1,$2,$3,$4,$5,$6)', [accountId, h.instrumentId, h.bucket, h.quantity, h.cost, h.income]);
  for (const r of res.realised) await c.query('insert into realised_gain(account_id,instrument_id,sell_txn_id,lot_txn_id,qty,acquired,sold,opening_lot,cost_inr,proceeds_inr,gain_inr,holding_days) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [accountId, r.instrumentId, r.sellTxnId, r.lotTxnId, r.qty, r.acquired, r.sold, r.openingLot, r.cost, r.proceeds, r.gain, r.holdingDays]);
  for (const i of res.income) await c.query('insert into income(account_id,instrument_id,txn_id,on_date,amount_inr) values ($1,$2,$3,$4,$5)', [accountId, i.instrumentId, i.txnId, i.date, i.amount]);
  return res;
}
