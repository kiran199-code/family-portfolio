import { UserError } from '../errors.js';
import { z } from 'zod';
import { pool, tx, audit } from '../db.js';

export const OverrideInput = z.object({ instrumentId: z.number().int().positive(), price: z.number().positive(), asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().max(300).optional() });
export async function createOverride(i: z.infer<typeof OverrideInput>, user: string | null) {
  return tx(async (c) => {
    const id = (await c.query('insert into manual_override(instrument_id,price,as_of_date,reason,entered_by) values ($1,$2,$3,$4,$5) returning id', [i.instrumentId, i.price, i.asOfDate, i.reason ?? null, user])).rows[0].id;
    await audit(c, user, 'manual_override', id, 'create', null, i);
    return id;
  });
}
export async function listOverrides() {
  return (await pool.query(`select m.id, m.instrument_id, i.name, m.price, to_char(m.as_of_date,'YYYY-MM-DD') as_of_date, m.reason, m.entered_by, m.created_at, m.active from manual_override m join instrument i on i.id=m.instrument_id order by m.created_at desc limit 200`)).rows;
}
export async function deactivateOverride(id: number, user: string | null) {
  await tx(async (c) => { await c.query('update manual_override set active=false where id=$1', [id]); await audit(c, user, 'manual_override', id, 'deactivate', null, null); });
}

export const BalanceInput = z.object({ value: z.number().nonnegative(), cost: z.number().nonnegative().nullable().optional(), asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() });
export async function updateBalance(id: number, i: z.infer<typeof BalanceInput>, user: string | null) {
  return tx(async (c) => {
    const before = (await c.query('select * from asset_balance where id=$1', [id])).rows[0];
    if (!before) throw new UserError('Balance not found');
    await c.query('update asset_balance set value_inr=$2, cost_inr=coalesce($3, cost_inr), as_of=$4, updated_at=now() where id=$1', [id, i.value, i.cost ?? null, i.asOf ?? null]);
    await audit(c, user, 'asset_balance', id, 'update', before, i);
  });
}

export const InstrumentInput = z.object({
  assetClass: z.enum(['EQUITY_IN', 'EQUITY_SG', 'MF', 'ULIP_FUND', 'INDEX', 'OTHER']),
  name: z.string().min(2), shortName: z.string().optional(), symbol: z.string().optional(), exchange: z.string().optional(), isin: z.string().optional(),
  amfiCode: z.string().optional(), currency: z.string().length(3).default('INR'), plan: z.enum(['Direct', 'Regular']).optional(), meta: z.record(z.string(), z.any()).optional(),
});
export async function createInstrument(i: z.infer<typeof InstrumentInput>, user: string | null) {
  return tx(async (c) => {
    const id = (await c.query(
      `insert into instrument(asset_class,name,short_name,symbol,exchange,isin,amfi_code,currency,plan,meta) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [i.assetClass, i.name, i.shortName ?? i.name, i.symbol ?? null, i.exchange ?? (i.assetClass === 'EQUITY_IN' ? 'NSE' : null), i.isin ?? null, i.amfiCode ?? null, i.currency, i.plan ?? null, i.meta ?? {}])).rows[0].id;
    await audit(c, user, 'instrument', id, 'create', null, i);
    return id;
  });
}
export const InstrumentPatch = z.object({
  symbol: z.string().nullable().optional(), isin: z.string().nullable().optional(), exchange: z.string().nullable().optional(), symbolVerified: z.boolean().optional(),
  providerSymbols: z.record(z.string(), z.any()).optional(), active: z.boolean().optional(), meta: z.record(z.string(), z.any()).optional(), amfiCode: z.string().nullable().optional(),
});
export async function patchInstrument(id: number, p: z.infer<typeof InstrumentPatch>, user: string | null) {
  return tx(async (c) => {
    const before = (await c.query('select * from instrument where id=$1', [id])).rows[0];
    if (!before) throw new UserError('Instrument not found');
    await c.query(
      `update instrument set symbol = case when $2::boolean then $3 else symbol end, isin = case when $4::boolean then $5 else isin end, exchange = case when $6::boolean then $7 else exchange end,
         symbol_verified = coalesce($8, symbol_verified), provider_symbols = provider_symbols || coalesce($9::jsonb,'{}'::jsonb), active = coalesce($10, active), meta = meta || coalesce($11::jsonb,'{}'::jsonb),
         amfi_code = case when $12::boolean then $13 else amfi_code end where id=$1`,
      [id, 'symbol' in p, p.symbol ?? null, 'isin' in p, p.isin ?? null, 'exchange' in p, p.exchange ?? null, p.symbolVerified ?? null,
       p.providerSymbols ? JSON.stringify(p.providerSymbols) : null, p.active ?? null, p.meta ? JSON.stringify(p.meta) : null, 'amfiCode' in p, p.amfiCode ?? null]);
    await audit(c, user, 'instrument', id, 'update', before, p);
  });
}
export async function listInstruments(filter: { assetClass?: string; q?: string }) {
  const where = ['1=1']; const args: any[] = [];
  if (filter.assetClass) { args.push(filter.assetClass); where.push(`i.asset_class=$${args.length}`); }
  if (filter.q) { args.push('%' + filter.q.toLowerCase() + '%'); where.push(`(lower(i.name) like $${args.length} or lower(coalesce(i.symbol,'')) like $${args.length})`); }
  return (await pool.query(
    `select i.id, i.asset_class, i.name, i.short_name, i.symbol, i.exchange, i.isin, i.amfi_code, i.currency, i.plan, i.symbol_verified, i.active, i.provider_symbols, i.meta,
            p.price, to_char(p.as_of_date,'YYYY-MM-DD') price_date, p.kind, p.source, p.verify
       from instrument i left join price_cache p on p.instrument_id=i.id where ${where.join(' and ')} order by i.asset_class, i.name limit 500`, args)).rows;
}

export async function accounts() {
  return (await pool.query(`select a.id, a.kind, a.label, a.meta, o.code owner from account a join owner o on o.id=a.owner_id order by o.id, a.id`)).rows;
}
export async function watchlist() { return (await pool.query('select * from watchlist order by id')).rows; }
export async function flags() { return (await pool.query('select id, created_at, text, resolved from note_flag order by id')).rows; }
export const WatchInput = z.object({ whenLabel: z.string().optional(), category: z.string().optional(), title: z.string().min(1), detail: z.string().optional(), note: z.string().optional() });
export async function addWatch(i: z.infer<typeof WatchInput>, user: string | null) {
  return tx(async (c) => { const id = (await c.query('insert into watchlist(when_label,category,title,detail,note) values ($1,$2,$3,$4,$5) returning id', [i.whenLabel ?? null, i.category ?? null, i.title, i.detail ?? null, i.note ?? null])).rows[0].id; await audit(c, user, 'watchlist', id, 'create', null, i); return id; });
}
