import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';
import { migrate } from '../src/cli/migrate.js';
import { seedFromData } from '../src/services/seed.js';
import { buildApp } from '../src/app.js';
import { applyPrice, refreshMutualFunds, refreshStocks, saveCredentials } from '../src/services/pricing.js';
import { saveSnapshot } from '../src/services/jobs.js';
import { config } from '../src/config.js';

const D = JSON.parse(fs.readFileSync(config.seedFile, 'utf8'));
let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
const H = () => ({ authorization: `Bearer ${token}` });
const api = async (method: string, url: string, payload?: any) => {
  const r = await app.inject({ method: method as any, url, payload, headers: H() });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const one = async (sql: string, args: any[] = []) => (await pool.query(sql, args)).rows[0];

beforeAll(async () => {
  await migrate();
  await seedFromData(D, true);
  await pool.query('delete from app_user');
  await pool.query('insert into app_user(username,password_hash) values ($1,$2)', ['kiran', await bcrypt.hash('correct horse battery', 4)]);
  app = await buildApp();
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'kiran', password: 'correct horse battery' } });
  token = JSON.parse(r.body).token;
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('auth', () => {
  it('rejects requests without a token', async () => { const r = await app.inject({ method: 'GET', url: '/api/dashboard' }); expect(r.statusCode).toBe(401); });
  it('rejects a wrong password', async () => { const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'kiran', password: 'nope' } }); expect(r.statusCode).toBe(401); });
  it('health is open', async () => { expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200); });
});

describe('transactions update static data', () => {
  let franklin: { instrumentId: number; accountId: number; qty: number; cost: number };
  beforeAll(async () => {
    const r = await one(`select h.instrument_id, h.account_id, h.quantity, h.cost_inr from holding h join instrument i on i.id=h.instrument_id where i.amfi_code='103360' and h.account_id=(select id from account where label='Mutual funds' and owner_id=(select id from owner where code='Personal'))`);
    franklin = { instrumentId: r.instrument_id, accountId: r.account_id, qty: r.quantity, cost: r.cost_inr };
  });

  it('preview shows the new quantity, cost and realised gain without writing', async () => {
    const { body } = await api('POST', '/api/transactions/preview', { accountId: franklin.accountId, instrumentId: franklin.instrumentId, date: '2026-11-12', type: 'SELL', quantity: 100, price: 170 });
    expect(body.ok).toBe(true);
    expect(body.after[0].quantity).toBeCloseTo(franklin.qty - 100, 4);
    expect(body.realised[0].openingLot).toBe(true);
    expect((await one('select quantity from holding where account_id=$1 and instrument_id=$2', [franklin.accountId, franklin.instrumentId])).quantity).toBeCloseTo(franklin.qty, 4);
  });

  it('a sell reduces units and cost proportionally and records a realised gain', async () => {
    const before = (await api('GET', '/api/dashboard')).body.totals.value;
    const { status, body } = await api('POST', '/api/transactions', { accountId: franklin.accountId, instrumentId: franklin.instrumentId, date: '2026-11-12', type: 'SELL', quantity: 100, price: 170, charges: 5 });
    expect(status).toBe(201);
    const h = await one('select quantity, cost_inr from holding where account_id=$1 and instrument_id=$2', [franklin.accountId, franklin.instrumentId]);
    expect(h.quantity).toBeCloseTo(franklin.qty - 100, 4);
    expect(h.cost_inr).toBeCloseTo(franklin.cost * (1 - 100 / franklin.qty), 1);
    const g = await one('select proceeds_inr, opening_lot from realised_gain where sell_txn_id=$1', [body.id]);
    expect(g.proceeds_inr).toBeCloseTo(100 * 170 - 5, 2); expect(g.opening_lot).toBe(true);
    const after = (await api('GET', '/api/dashboard')).body.totals.value;
    expect(before - after).toBeGreaterThan(100 * 160); // value fell by roughly 100 units x NAV
    expect((await one(`select count(*)::int n from audit_log where entity='txn' and entity_id=$1`, [String(body.id)])).n).toBeGreaterThanOrEqual(1);
  });

  it('an oversell is refused and changes nothing', async () => {
    const before = await one('select quantity from holding where account_id=$1 and instrument_id=$2', [franklin.accountId, franklin.instrumentId]);
    const { status, body } = await api('POST', '/api/transactions', { accountId: franklin.accountId, instrumentId: franklin.instrumentId, date: '2026-11-13', type: 'SELL', quantity: 999999, price: 170 });
    expect(status).toBe(422); expect(body.error).toMatch(/only/);
    expect((await one('select quantity from holding where account_id=$1 and instrument_id=$2', [franklin.accountId, franklin.instrumentId])).quantity).toBe(before.quantity);
    expect((await one(`select count(*)::int n from txn where quantity=999999`)).n).toBe(0);
  });

  it('a buy raises units and the average cost moves to the weighted average', async () => {
    const b = await one('select quantity, cost_inr from holding where account_id=$1 and instrument_id=$2', [franklin.accountId, franklin.instrumentId]);
    await api('POST', '/api/transactions', { accountId: franklin.accountId, instrumentId: franklin.instrumentId, date: '2026-11-14', type: 'BUY', quantity: 50, amount: 8500 });
    const a = await one('select quantity, cost_inr from holding where account_id=$1 and instrument_id=$2', [franklin.accountId, franklin.instrumentId]);
    expect(a.quantity).toBeCloseTo(b.quantity + 50, 4); expect(a.cost_inr).toBeCloseTo(b.cost_inr + 8500, 2);
  });

  it('deleting the sell restores the holding (the ledger is the source of truth)', async () => {
    const sell = await one(`select id from txn where type='SELL' and account_id=$1 and deleted_at is null`, [franklin.accountId]);
    const { status } = await api('DELETE', `/api/transactions/${sell.id}`);
    expect(status).toBe(200);
    const h = await one('select quantity from holding where account_id=$1 and instrument_id=$2', [franklin.accountId, franklin.instrumentId]);
    expect(h.quantity).toBeCloseTo(franklin.qty + 50, 4);
    expect((await one('select count(*)::int n from realised_gain where sell_txn_id=$1', [sell.id])).n).toBe(0);
  });

  it('a foreign trade without an FX rate is refused instead of guessing one', async () => {
    const r = await one(`select h.account_id, h.instrument_id from holding h join instrument i on i.id=h.instrument_id where i.symbol='D05' limit 1`);
    const { status, body } = await api('POST', '/api/transactions', { accountId: r.account_id, instrumentId: r.instrument_id, date: '2026-11-12', type: 'BUY', quantity: 10, price: 70 });
    expect(status).toBe(400); expect(body.error).toMatch(/SGD\/INR rate/);
  });

  it('a foreign trade with an FX rate stores SGD and INR amounts', async () => {
    const r = await one(`select h.account_id, h.instrument_id from holding h join instrument i on i.id=h.instrument_id where i.symbol='D05' and h.bucket='AVAILABLE' limit 1`);
    const { body } = await api('POST', '/api/transactions', { accountId: r.account_id, instrumentId: r.instrument_id, date: '2026-11-12', type: 'BUY', quantity: 10, price: 70, fxRate: 73 });
    const t = await one('select amount, amount_inr, currency from txn where id=$1', [body.id]);
    expect(t.amount).toBeCloseTo(700); expect(t.amount_inr).toBeCloseTo(51100); expect(t.currency).toBe('SGD');
  });

  it('a split rewrites units but not total cost', async () => {
    const r = await one(`select h.account_id, h.instrument_id, h.quantity, h.cost_inr from holding h join instrument i on i.id=h.instrument_id where i.name='HDFC Bank' and h.account_id=(select id from account where kind='DEMAT')`);
    await api('POST', '/api/transactions', { accountId: r.account_id, instrumentId: r.instrument_id, date: '2026-11-15', type: 'SPLIT', ratioNum: 2, ratioDen: 1 });
    const a = await one('select quantity, cost_inr from holding where account_id=$1 and instrument_id=$2', [r.account_id, r.instrument_id]);
    expect(a.quantity).toBeCloseTo(r.quantity * 2, 4); expect(a.cost_inr).toBeCloseTo(r.cost_inr, 2);
  });
});

describe('manual overrides and as-given balances', () => {
  it('a manual price fills an unmapped stock and is labelled manual', async () => {
    const i = await one(`select id from instrument where name='MOCAPITAL'`);
    const { status } = await api('POST', '/api/overrides', { instrumentId: i.id, price: 60, asOfDate: '2026-11-12', reason: 'from broker app' });
    expect(status).toBe(200);
    const dash = (await api('GET', '/api/dashboard')).body;
    const row = dash.portfolios.find((p: any) => p.code === 'Personal').parts.find((p: any) => p.key === 'stocks').rows.find((r: any) => r.name === 'MOCAPITAL');
    expect(row.price).toBe(60); expect(row.kind).toBe('manual'); expect(row.overridden).toBe(true); expect(row.verify).toBe(true);
  });
  it('a newer live value wins over an older manual one', async () => {
    const i = await one(`select id from instrument where name='MOCAPITAL'`);
    await applyPrice(pool, i.id, { price: 61, asOfDate: '2026-11-13', asOfIso: '2026-11-13T10:00:00Z', kind: 'close', source: 'test' });
    const row = (await api('GET', '/api/dashboard')).body.portfolios.find((p: any) => p.code === 'Personal').parts.find((p: any) => p.key === 'stocks').rows.find((r: any) => r.name === 'MOCAPITAL');
    expect(row.price).toBe(61); expect(row.overridden).toBe(false);
  });
  it('updating a PF balance changes the total and is audited', async () => {
    const b = await one(`select id, value_inr from asset_balance where kind='PF' and label like '%Personal%'`);
    const before = (await api('GET', '/api/dashboard')).body.totals.value;
    const auditBefore = (await one(`select count(*)::int n from audit_log where entity='asset_balance'`)).n;
    expect((await api('PUT', `/api/balances/${b.id}`, { value: b.value_inr + 100000, asOf: '2026-11-10' })).status).toBe(200);
    const after = (await api('GET', '/api/dashboard')).body.totals.value;
    expect(after - before).toBeCloseTo(100000, 0);
    expect((await one(`select count(*)::int n from audit_log where entity='asset_balance'`)).n).toBe(auditBefore + 1);
  });
});

describe('pricing rules', () => {
  const mk = async (name: string) => (await pool.query(`insert into instrument(asset_class,name,symbol,exchange) values ('EQUITY_IN',$1,'T','NSE') returning id`, [name])).rows[0].id as number;
  it('first value is stored, an older value is ignored, a later one keeps the previous value', async () => {
    const id = await mk('RuleTest');
    expect((await applyPrice(pool, id, { price: 100, asOfDate: '2026-11-02', asOfIso: '2026-11-02T10:00:00Z', kind: 'close', source: 't' })).result).toBe('updated');
    expect((await applyPrice(pool, id, { price: 90, asOfDate: '2026-11-01', asOfIso: '2026-11-01T10:00:00Z', kind: 'close', source: 't' })).result).toBe('older');
    expect((await applyPrice(pool, id, { price: 104, asOfDate: '2026-11-03', asOfIso: '2026-11-03T10:00:00Z', kind: 'close', source: 't' })).result).toBe('updated');
    const p = await one('select price, prev_close from price_cache where instrument_id=$1', [id]);
    expect(p.price).toBe(104); expect(p.prev_close).toBe(100);
  });
  it('an implausible jump is rejected, not stored', async () => {
    const id = await mk('JumpTest');
    await applyPrice(pool, id, { price: 100, asOfDate: '2026-11-02', asOfIso: '2026-11-02T10:00:00Z', kind: 'close', source: 't' });
    const r = await applyPrice(pool, id, { price: 300, asOfDate: '2026-11-03', asOfIso: '2026-11-03T10:00:00Z', kind: 'close', source: 't' });
    expect(r.result).toBe('rejected'); expect((await one('select price from price_cache where instrument_id=$1', [id])).price).toBe(100);
  });
  it('a provider previous close that disagrees with the stored close sets verify', async () => {
    const id = await mk('PrevTest');
    await applyPrice(pool, id, { price: 100, asOfDate: '2026-11-02', asOfIso: '2026-11-02T10:00:00Z', kind: 'close', source: 't' });
    await applyPrice(pool, id, { price: 103, prevClose: 95, asOfDate: '2026-11-03', asOfIso: '2026-11-03T10:00:00Z', kind: 'close', source: 't' });
    expect((await one('select verify from price_cache where instrument_id=$1', [id])).verify).toBe(true);
  });
  it('stock refresh on a listed holiday changes nothing', async () => {
    const before = (await one('select count(*)::int n, max(fetched_at) f from price_cache')).f;
    const s = await refreshStocks(new Date('2026-11-10T06:00:00Z')); // 11:30 IST on the Diwali-Balipratipada holiday
    expect(s.skipped).toMatch(/not a trading day/);
    expect((await one('select max(fetched_at) f from price_cache')).f).toEqual(before);
  });
  it('stock refresh with no provider configured reports it and estimates nothing', async () => {
    const s = await refreshStocks(new Date('2026-11-11T11:00:00Z'));
    expect(s.sources).toEqual([]); expect(s.notes.join(' ')).toMatch(/No stock price provider/);
  });
});

describe('mutual fund refresh (AMFI mocked)', () => {
  const filler = Array.from({ length: 1200 }, (_, i) => `${200000 + i};INF0000${i};-;Filler ${i};Regular Plan;Growth Option;10.5;09-Nov-2026`).join('\n');
  const file = (franklinNav: string, date: string) => `Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date\n\nSome AMC\n${filler}\n103360;INF090I01569;-;Franklin India Small Cap Fund - Regular Plan - Growth;Regular Plan;Growth Option;${franklinNav};${date}\n153029;INF247L01AB1;-;MO MidSmall IT - Regular;Regular Plan;Growth Option;9.99;${date}\n`;
  it('updates the NAV, keeps the previous NAV, rejects a Regular/Direct mix-up, then is idempotent', async () => {
    const stub = vi.fn(async () => new Response(file('171.5', '10-Nov-2026'), { status: 200 }));
    vi.stubGlobal('fetch', stub);
    const prev = await one(`select p.price from price_cache p join instrument i on i.id=p.instrument_id where i.amfi_code='103360'`);
    const s = await refreshMutualFunds();
    expect(s.updated).toBeGreaterThanOrEqual(1);
    expect(s.rejected.join(' ')).toMatch(/Direct/);                              // 153029 is the Direct plan; AMFI row says Regular
    const p = await one(`select p.price, p.prev_close, p.source, p.kind, to_char(p.as_of_date,'YYYY-MM-DD') d from price_cache p join instrument i on i.id=p.instrument_id where i.amfi_code='103360'`);
    expect(p.price).toBe(171.5); expect(p.prev_close).toBe(prev.price); expect(p.source).toBe('AMFI NAVAll.txt'); expect(p.kind).toBe('nav'); expect(p.d).toBe('2026-11-10');
    const again = await refreshMutualFunds();
    expect(again.updated).toBe(0);
    vi.unstubAllGlobals();
  });
  it('an unreachable AMFI changes nothing and says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const before = await one(`select price from price_cache p join instrument i on i.id=p.instrument_id where i.amfi_code='103360'`);
    const s = await refreshMutualFunds();
    expect(s.notes.join(' ')).toMatch(/AMFI file unavailable/);
    expect((await one(`select price from price_cache p join instrument i on i.id=p.instrument_id where i.amfi_code='103360'`)).price).toBe(before.price);
    vi.unstubAllGlobals();
  }, 60000);
});

describe('snapshots', () => {
  it('saves one row per market date and replaces it on a re-run', async () => {
    const a = await saveSnapshot();
    expect(a.saved).toBe(true);
    const n1 = (await one('select count(*)::int n from snapshot')).n;
    await saveSnapshot();
    expect((await one('select count(*)::int n from snapshot')).n).toBe(n1);
    const s = await one('select data, total_inr from snapshot order by snap_date desc limit 1');
    expect(Object.keys(s.data).sort()).toEqual(['HUF', 'Personal', 'Sravanthi']);
  });
});

describe('csv import', () => {
  const header = 'date,account,instrument,type,quantity,price,amount,charges,notes\n';
  it('previews, flags bad rows, and refuses to commit while errors remain', async () => {
    const csv = header + '2026-11-16,Personal/Mutual funds,103360,BUY,10,,1700,,sip\n2026-11-16,Personal/Mutual funds,103360,SELL,99999999,170,,,too many\n2026-11-16,Nobody/Nothing,103360,BUY,1,1,,,\n';
    const { body } = await api('POST', '/api/import/preview', { csv, filename: 't.csv' });
    expect(body.errors).toBe(3); expect(body.ok).toBe(0);                         // bad account + oversell + the row blocked behind it
    expect(body.rows.find((r: any) => r.line === 3).error).toMatch(/line 3|invalid/); expect(body.rows.find((r: any) => r.line === 2).error).toMatch(/Blocked: line 3/);
    const c = await api('POST', '/api/import/commit', { batchId: body.batchId });
    expect(c.status).toBe(400);
  });
  it('commits a clean file once and detects duplicates the second time', async () => {
    const csv = header + '2026-11-17,Personal/Mutual funds,103360,BUY,10,,1700,,sip\n2026-11-18,Personal/Mutual funds,103360,BUY,5,,850,,sip\n';
    const p = await api('POST', '/api/import/preview', { csv, filename: 'ok.csv' });
    expect(p.body.ok).toBe(2); expect(p.body.changes[0].afterQty - p.body.changes[0].beforeQty).toBeCloseTo(15, 4);
    expect((await api('POST', '/api/import/commit', { batchId: p.body.batchId })).body.inserted).toBe(2);
    expect((await api('POST', '/api/import/commit', { batchId: p.body.batchId })).status).toBe(400);   // already committed
    const p2 = await api('POST', '/api/import/preview', { csv, filename: 'ok.csv' });
    expect(p2.body.duplicates).toBe(2);
  });
  it('reconcile lists differences against a statement', async () => {
    const h = await one(`select sum(h.quantity) q from holding h join instrument i on i.id=h.instrument_id join account a on a.id=h.account_id join owner o on o.id=a.owner_id where i.amfi_code='103360' and o.code='Personal'`);
    const r = await api('POST', '/api/reconcile', { owner: 'Personal', statement: [{ instrument: '103360', units: h.q + 2 }] });
    expect(r.body.differences.find((d: any) => d.instrument.includes('Franklin')).difference).toBeCloseTo(2, 4);
  });
});

describe('reports and admin', () => {
  it('capital gains report lists realised gains and warns about holding periods', async () => {
    await api('POST', '/api/transactions', { accountId: (await one(`select id from account where kind='DEMAT'`)).id, instrumentId: (await one(`select id from instrument where name='Ethos'`)).id, date: '2026-11-20', type: 'SELL', quantity: 1, price: 1000 });
    const r = (await api('GET', '/api/reports/gains')).body;
    expect(r.rows.length).toBeGreaterThan(0); expect(r.caution).toMatch(/Verify/); expect(r.rows[0].fy).toBe('FY 2026-27');
  });
  it('xirr report returns a row per owner and reports its coverage', async () => {
    const r = (await api('GET', '/api/reports/xirr')).body;
    expect(r.owners).toHaveLength(3); expect(r.owners[0]).toHaveProperty('coverage');
  });
  it('credentials are stored encrypted and never returned', async () => {
    await saveCredentials('upstox', { accessToken: 'SECRET-TOKEN-123' });
    const raw = await one(`select credential_cipher from provider_status where provider='upstox'`);
    expect(raw.credential_cipher).not.toContain('SECRET-TOKEN-123');
    const health = (await api('GET', '/api/providers/health')).body;
    expect(JSON.stringify(health)).not.toContain('SECRET-TOKEN-123'); expect(health.find((p: any) => p.provider === 'upstox').has_credentials).toBe(true);
  });
  it('yahoo stays off unless opted in', async () => {
    const y = (await api('GET', '/api/providers/health')).body.find((p: any) => p.provider === 'yahoo');
    expect(y.active).toBe(false);
  });
  it('transactions export is CSV', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/export/transactions.csv', headers: H() });
    expect(r.headers['content-type']).toMatch(/text\/csv/); expect(r.body.split('\n')[0]).toContain('amount_inr');
  });
});
