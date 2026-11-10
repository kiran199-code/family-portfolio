import { UserError } from '../errors.js';
import type pg from 'pg';
import { tx, audit, pool } from '../db.js';
import { LedgerTxn, LedgerError, preview as ledgerPreview, replay } from '../domain/ledger.js';
import { loadLedger, rebuildAccount } from './ledgerStore.js';
import { z } from 'zod';

export const TxnInput = z.object({
  accountId: z.number().int().positive(),
  instrumentId: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.enum(['OPENING', 'BUY', 'SELL', 'SIP', 'SWITCH_IN', 'SWITCH_OUT', 'DIVIDEND', 'BONUS', 'SPLIT', 'DEMERGER', 'TRANSFER_IN', 'TRANSFER_OUT', 'VEST', 'FEE']),
  bucket: z.enum(['AVAILABLE', 'UNVESTED']).optional(),
  quantity: z.number().positive().optional(),
  price: z.number().nonnegative().optional(),
  amount: z.number().nonnegative().optional(),        // in the instrument's currency
  fxRate: z.number().positive().optional(),
  amountInr: z.number().nonnegative().optional(),
  charges: z.number().nonnegative().optional(),
  ratioNum: z.number().positive().optional(),
  ratioDen: z.number().positive().optional(),
  costFraction: z.number().min(0).max(1).optional(),
  refInstrumentId: z.number().int().positive().optional(),
  notes: z.string().max(500).optional(),
});
export type TxnInputT = z.infer<typeof TxnInput>;

type C = pg.Pool | pg.PoolClient;

/** Works out the INR amount: explicit amountInr, else amount x fx, else quantity x price x fx. Never guesses an FX rate. */
export async function resolveAmounts(c: C, inp: TxnInputT) {
  const inst = (await c.query('select currency from instrument where id=$1', [inp.instrumentId])).rows[0];
  if (!inst) throw new UserError('Unknown instrument');
  const ccy: string = inst.currency;
  let fx = inp.fxRate ?? (ccy === 'INR' ? 1 : null);
  let amount = inp.amount ?? (inp.quantity != null && inp.price != null ? inp.quantity * inp.price : null);
  let amountInr = inp.amountInr ?? null;
  if (amountInr == null && amount != null) {
    if (fx == null) throw new UserError(`Enter the ${ccy}/INR rate used on the trade date (it is not guessed)`);
    amountInr = amount * fx;
  }
  if (amount == null && amountInr != null && fx) amount = amountInr / fx;
  const needsAmount = ['BUY', 'SELL', 'SIP', 'SWITCH_IN', 'SWITCH_OUT', 'DIVIDEND', 'OPENING'].includes(inp.type);
  if (needsAmount && amountInr == null) throw new UserError(`${inp.type} needs an amount (or quantity and price)`);
  return { ccy, fx, amount, amountInr };
}

function toLedger(id: number, inp: TxnInputT, amountInr: number | null): LedgerTxn {
  return { id, instrumentId: inp.instrumentId, date: inp.date, type: inp.type, bucket: inp.bucket ?? 'AVAILABLE', quantity: inp.quantity ?? null, amountInr, charges: inp.charges ?? 0, ratioNum: inp.ratioNum ?? null, ratioDen: inp.ratioDen ?? null, costFraction: inp.costFraction ?? null, refInstrumentId: inp.refInstrumentId ?? null };
}

export async function previewTxn(inp: TxnInputT) {
  const { amountInr } = await resolveAmounts(pool, inp);
  const existing = await loadLedger(pool, inp.accountId);
  try {
    const p = ledgerPreview(existing, toLedger(-1, inp, amountInr));
    return { ok: true as const, amountInr, ...p };
  } catch (e) {
    if (e instanceof LedgerError) return { ok: false as const, error: e.message };
    throw e;
  }
}

async function insertTxn(c: pg.PoolClient, inp: TxnInputT, user: string | null, source = 'manual', batchId: number | null = null): Promise<number> {
  const { ccy, fx, amount, amountInr } = await resolveAmounts(c, inp);
  const r = await c.query(
    `insert into txn(account_id,instrument_id,trade_date,type,bucket,quantity,price,amount,currency,fx_rate,amount_inr,charges,ratio_num,ratio_den,cost_fraction,ref_instrument_id,notes,source,import_batch_id,created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning id`,
    [inp.accountId, inp.instrumentId, inp.date, inp.type, inp.bucket ?? 'AVAILABLE', inp.quantity ?? null, inp.price ?? null, amount, ccy, fx, amountInr, inp.charges ?? 0, inp.ratioNum ?? null, inp.ratioDen ?? null, inp.costFraction ?? null, inp.refInstrumentId ?? null, inp.notes ?? null, source, batchId, user]);
  return Number(r.rows[0].id);
}

/** Adds a transaction and rebuilds the account. If the resulting ledger is invalid nothing is written. */
export async function createTxn(inp: TxnInputT, user: string | null) {
  return tx(async (c) => {
    const id = await insertTxn(c, inp, user);
    await rebuildAccount(c, inp.accountId);
    if (inp.type === 'DEMERGER' && inp.refInstrumentId) {
      // the new instrument's lots land in this account; nothing else to write
    }
    await audit(c, user, 'txn', id, 'create', null, inp);
    return id;
  });
}

export async function deleteTxn(id: number, user: string | null) {
  return tx(async (c) => {
    const row = (await c.query('select * from txn where id=$1 and deleted_at is null', [id])).rows[0];
    if (!row) throw new UserError('Transaction not found');
    await c.query('update txn set deleted_at=now() where id=$1', [id]);
    await rebuildAccount(c, row.account_id); // throws (and rolls back) if later trades would now be invalid
    await audit(c, user, 'txn', id, 'delete', row, null);
  });
}

export async function updateTxn(id: number, inp: TxnInputT, user: string | null) {
  return tx(async (c) => {
    const row = (await c.query('select * from txn where id=$1 and deleted_at is null', [id])).rows[0];
    if (!row) throw new UserError('Transaction not found');
    const { ccy, fx, amount, amountInr } = await resolveAmounts(c, inp);
    await c.query(
      `update txn set instrument_id=$2, trade_date=$3, type=$4, bucket=$5, quantity=$6, price=$7, amount=$8, currency=$9, fx_rate=$10, amount_inr=$11, charges=$12, ratio_num=$13, ratio_den=$14, cost_fraction=$15, ref_instrument_id=$16, notes=$17 where id=$1`,
      [id, inp.instrumentId, inp.date, inp.type, inp.bucket ?? 'AVAILABLE', inp.quantity ?? null, inp.price ?? null, amount, ccy, fx, amountInr, inp.charges ?? 0, inp.ratioNum ?? null, inp.ratioDen ?? null, inp.costFraction ?? null, inp.refInstrumentId ?? null, inp.notes ?? null]);
    await rebuildAccount(c, row.account_id);
    await audit(c, user, 'txn', id, 'update', row, inp);
  });
}

export async function listTxns(filter: { accountId?: number; instrumentId?: number; limit?: number }) {
  const where: string[] = ['t.deleted_at is null']; const args: any[] = [];
  if (filter.accountId) { args.push(filter.accountId); where.push(`t.account_id=$${args.length}`); }
  if (filter.instrumentId) { args.push(filter.instrumentId); where.push(`t.instrument_id=$${args.length}`); }
  args.push(filter.limit ?? 500);
  const r = await pool.query(
    `select t.id, t.account_id, a.label account, o.code owner, t.instrument_id, i.name instrument, i.asset_class, to_char(t.trade_date,'YYYY-MM-DD') date, t.type, t.bucket, t.quantity, t.price, t.amount, t.currency, t.fx_rate, t.amount_inr, t.charges, t.notes, t.source, t.created_by
       from txn t join account a on a.id=t.account_id join owner o on o.id=a.owner_id join instrument i on i.id=t.instrument_id where ${where.join(' and ')} order by t.trade_date desc, t.id desc limit $${args.length}`, args);
  return r.rows;
}

export { insertTxn, toLedger, replay };
