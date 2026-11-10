import fs from 'node:fs';
import type pg from 'pg';
import { pool, tx } from '../db.js';
import { rebuildAccount } from './ledgerStore.js';

// NSE symbols below are my best knowledge and are NOT verified. They are stored with symbol_verified=false;
// the pricing job refuses to treat a quote as trustworthy until the symbol is verified (Admin > Instruments).
// null = I do not know the symbol; a price must come from a manual override until you map it.
const SYMBOLS: Record<string, string | null> = {
  MOCAPITAL: null, 'HDFC Bank': 'HDFCBANK', 'ICICI Bank': 'ICICIBANK', 'Neogen Chemicals': 'NEOGEN', 'Sambhv Steel Tubes': 'SAMBHV',
  'Shivalik Bimetal': 'SBCL', 'Sansera Engineering': 'SANSERA', 'Sterlite Tech.': 'STLTECH', 'Timex Group': 'TIMEX', 'Aarti Pharmalabs': 'AARTIPHARM',
  'Centum Electronics': 'CENTUM', 'E2E Networks': 'E2E', 'Shilpa Medicare': 'SHILPAMED', 'Quality Power Elect.': 'QPOWER', 'Shadowfax Tech.': null,
  'Syrma SGS Technology': 'SYRMA', 'Acutaas Chemicals': 'ACUTAAS', Ethos: 'ETHOSLTD', 'Sai Life Sciences': 'SAILIFE', 'Avalon Technologies': 'AVALON',
  'Man Industries': 'MANINDS', 'Aeroflex Industries': 'AEROFLEX', 'Inox India': 'INOXINDIA', 'Jyoti CNC Automation': 'JYOTICNC', 'TD Power Systems': 'TDPOWERSYS',
  'SMS Pharmaceuticals': 'SMSPHARMA', 'Astra Micro Wave': 'ASTRAMICRO', 'HLE Glascoat': 'HLEGLAS',
  'Aarti Industries': 'AARTIIND', 'Adani Enterprises': 'ADANIENT', 'Aditya Birla Capital': 'ABCAPITAL', 'Aditya Birla Real Estate': 'ABREL',
  'Alkem Laboratories': 'ALKEM', 'Axis Bank': 'AXISBANK', 'Bharti Airtel': 'BHARTIARTL', Crizac: 'CRIZAC', 'Cummins India': 'CUMMINSIND',
  'DCM Shriram': 'DCMSHRIRAM', 'Deepak Fertilisers and Petrochemicals Corporation': 'DEEPAKFERT', 'Grasim Industries': 'GRASIM', 'IIFL Finance': 'IIFL',
  'Indus Towers': 'INDUSTOWER', 'Jindal Stainless': 'JSL', 'Larsen and Toubro': 'LT', 'Max Financial Services': 'MFSL', NTPC: 'NTPC',
  'One 97 Communications': 'PAYTM', 'Polycab India': 'POLYCAB', 'State Bank of India': 'SBIN', 'Sun Pharmaceutical Industries': 'SUNPHARMA',
  'Vedanta Aluminium Metal': null, 'ZF Commercial Vehicle Control Systems India': 'ZFCVINDIA',
};

const YEAR = 2026;
const MON: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
/** '9-Nov' -> '2026-11-09' (the prototype prints day-month only; the year is assumed to be 2026). */
function shortDate(s: string | null | undefined): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})$/.exec(String(s ?? '').trim());
  return m ? `${YEAR}-${MON[m[2]]}-${m[1].padStart(2, '0')}` : null;
}
const num = (s: string) => parseFloat(String(s).replace(/,/g, ''));
const shortName = (n: string) => n.replace(/ - (Regular|Direct) Growth.*$/, '').replace(/ \((Direct|bought.*)\)$/, '').replace(/ - Growth( \(Regular Plan\))?$/, '');

export interface SeedReport { owners: number; accounts: number; instruments: number; txns: number; unmappedSymbols: string[]; unmatchedFunds: string[]; notes: string[] }

export async function seedFromFile(file: string, force = false): Promise<SeedReport> {
  return seedFromData(JSON.parse(fs.readFileSync(file, 'utf8')), force);
}

export async function seedFromData(D: any, force = false): Promise<SeedReport> {
  const existing = (await pool.query('select count(*)::int n from owner')).rows[0].n;
  if (existing > 0 && !force) throw new Error('Database already has data. Re-run with --force to wipe and reseed.');
  const report: SeedReport = { owners: 0, accounts: 0, instruments: 0, txns: 0, unmappedSymbols: [], unmatchedFunds: [], notes: [] };

  await tx(async (c) => {
    if (force) {
      await c.query(`truncate txn, tax_lot, holding, realised_gain, income, price_cache, price_history, fx_rate, manual_override, asset_balance,
        snapshot, audit_log, refresh_run, fund_lookthrough, fund_allocation, watchlist, note_flag, market_holiday, import_batch, meta_kv, account, instrument, owner restart identity cascade`);
    }
    const snapDate: string = D.snapDate ?? '2026-11-09';
    const ownerId: Record<string, number> = {};
    for (const code of ['Personal', 'HUF', 'Sravanthi']) {
      ownerId[code] = (await c.query('insert into owner(code,label) values ($1,$1) returning id', [code])).rows[0].id;
      report.owners++;
    }
    const accId: Record<string, number> = {};
    const mkAcc = async (key: string, owner: string, kind: string, label: string, meta: object = {}) => {
      accId[key] = (await c.query('insert into account(owner_id,kind,label,meta) values ($1,$2,$3,$4) returning id', [ownerId[owner], kind, label, meta])).rows[0].id;
      report.accounts++;
    };
    await mkAcc('P-MF', 'Personal', 'MF_FOLIO', 'Mutual funds');
    await mkAcc('P-STK', 'Personal', 'DEMAT', 'Direct stocks (broker)');
    await mkAcc('P-FOR', 'Personal', 'FOREIGN_BROKER', 'DBS shares');
    await mkAcc('H-MF', 'HUF', 'MF_FOLIO', 'Mutual funds');
    await mkAcc('H-PMS', 'HUF', 'PMS', 'Abakkus All Cap Approach (PMS)');
    await mkAcc('S-MF', 'Sravanthi', 'MF_FOLIO', 'Mutual funds');
    await mkAcc('S-FOR', 'Sravanthi', 'FOREIGN_BROKER', 'DBS shares');

    const instByKey = new Map<string, number>();
    const mkInst = async (cls: string, name: string, o: { short?: string; symbol?: string | null; exchange?: string; amfi?: string; ccy?: string; plan?: string | null; meta?: object; verified?: boolean }) => {
      const key = cls + '|' + name;
      if (instByKey.has(key)) return instByKey.get(key)!;
      const id = (await c.query(
        `insert into instrument(asset_class,name,short_name,symbol,exchange,amfi_code,currency,plan,meta,symbol_verified) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [cls, name, o.short ?? name, o.symbol ?? null, o.exchange ?? null, o.amfi ?? null, o.ccy ?? 'INR', o.plan ?? null, o.meta ?? {}, o.verified ?? false])).rows[0].id;
      instByKey.set(key, id); report.instruments++;
      return id;
    };
    const opening = async (acc: string, inst: number, date: string, qty: number, amountInr: number | null, extra: { bucket?: string; notes?: string; ccy?: string } = {}) => {
      await c.query(`insert into txn(account_id,instrument_id,trade_date,type,bucket,quantity,amount_inr,currency,notes,source) values ($1,$2,$3,'OPENING',$4,$5,$6,$7,$8,'seed')`,
        [accId[acc], inst, date, extra.bucket ?? 'AVAILABLE', qty, amountInr, extra.ccy ?? 'INR', extra.notes ?? 'Opening balance imported from the prototype; acquisition dates unknown']);
      report.txns++;
    };
    const setPrice = async (inst: number, price: number, prev: number | null, asOfDate: string, prevDate: string | null, kind: string, source: string, o: { verify?: boolean; note?: string } = {}) => {
      await c.query(
        `insert into price_cache(instrument_id,price,prev_close,prev_as_of,as_of,as_of_date,kind,source,verify,note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (instrument_id) do update set price=excluded.price, prev_close=excluded.prev_close, prev_as_of=excluded.prev_as_of, as_of=excluded.as_of, as_of_date=excluded.as_of_date, kind=excluded.kind, source=excluded.source, verify=excluded.verify, note=excluded.note
         where price_cache.as_of_date <= excluded.as_of_date`,
        [inst, price, prev, prevDate, asOfDate + 'T12:00:00Z', asOfDate, kind, source, o.verify ?? false, o.note ?? null]);
    };

    // ---- Mutual funds ----
    const codeToInst = new Map<string, number>();
    const mfOwner: Record<string, [string, string]> = { Personal: ['P-MF', 'Personal'], HUF: ['H-MF', 'HUF'], Sravanthi: ['S-MF', 'Sravanthi'] };
    for (const [owner, rows] of Object.entries<any[]>(D.portfolios)) {
      for (const r of rows) {
        const [name, units, nav, navDate, cost, prevNav, prevDate] = r;
        const code = D.schemeCodes[`${owner}|${name}`];
        if (!code) { report.unmatchedFunds.push(`${owner}|${name}`); continue; }
        const plan = /Direct/.test(name) ? 'Direct' : 'Regular';
        let inst: number = codeToInst.get(code) ?? 0;
        if (!inst) { inst = await mkInst('MF', name, { short: shortName(name), amfi: code, plan, meta: { schemeCodeNote: D.schemeCodeNotes?.[code] ?? null } }); codeToInst.set(code, inst); }
        await opening(mfOwner[owner][0], inst, snapDate, units, cost);
        await setPrice(inst, nav, prevNav ?? null, shortDate(navDate) ?? snapDate, shortDate(prevDate), 'seed', 'prototype seed (NAV)', { note: 'seeded from prototype; replaced on first NAV refresh' });
      }
    }

    // ---- Direct stocks (Personal) ----
    const stockInst = new Map<string, number>();
    const stock = async (name: string) => {
      if (stockInst.has(name)) return stockInst.get(name)!;
      const sym = SYMBOLS[name] ?? null;
      if (!sym) report.unmappedSymbols.push(name);
      const id = await mkInst('EQUITY_IN', name, { symbol: sym, exchange: 'NSE', meta: { symbolNote: sym ? 'unverified' : 'unknown, map it in Admin' } });
      stockInst.set(name, id);
      return id;
    };
    for (const r of D.stocks) {
      const [name, qty, , invested, price, dc] = r;
      const id = await stock(name);
      await opening('P-STK', id, snapDate, qty, invested, { notes: 'Opening balance from broker app screenshots; invested value used as cost' });
      await setPrice(id, price, price - dc, '2026-11-06', null, 'seed', 'prototype seed (broker app, date not shown)', { verify: true });
    }

    // ---- PMS stocks (HUF) ----
    for (const r of D.hufStocks) {
      const [name, qty, totalCost, price5, , income] = r;
      const id = await stock(name);
      await opening('H-PMS', id, '2026-11-05', qty, totalCost, { notes: 'Opening balance from the PMS report (5 Nov 2026)' });
      if (income > 0) {
        await c.query(`insert into txn(account_id,instrument_id,trade_date,type,amount_inr,quantity,notes,source) values ($1,$2,'2026-11-05','DIVIDEND',$3,null,'Income received per PMS report (cumulative)','seed')`, [accId['H-PMS'], id, income]);
        report.txns++;
      }
      const X = D.hufPx?.[name];
      await setPrice(id, X ? X[0] : price5, price5, X ? '2026-11-06' : '2026-11-05', '2026-11-05', 'seed', X ? `prototype seed (${X[1]})` : 'prototype seed (PMS report price, 5 Nov)', { verify: X ? !!X[2] : false });
    }

    // ---- ULIPs ----
    for (const U of D.ulips) {
      const insurer = U.meta?.insurer ?? 'insurer';
      const short = /SBI/.test(insurer) ? 'SBI Life' : /ICICI/.test(insurer) ? 'ICICI Pru Life' : insurer;
      const key = 'U-' + U.policy;
      await mkAcc(key, 'Personal', 'ULIP_POLICY', U.policy, { cost: U.cost, ...U.meta });
      for (const f of U.funds) {
        const [fname, units, nav, navDate, , prevNav, prevDate, link] = f;
        const id = await mkInst('ULIP_FUND', `${short} | ${fname}`, { short: fname, meta: { link, insurer: short } });
        await opening(key, id, snapDate, units, null, { notes: 'ULIP fund units; cost is held at policy level (premiums as given), not split by fund' });
        const d = shortDate(navDate) ?? (U.meta?.navDate ? isoFromLong(U.meta.navDate) : '2026-11-05') ?? '2026-11-05';
        await setPrice(id, nav, prevNav ?? null, d, shortDate(prevDate), 'seed', 'prototype seed (PolicyBazaar fund page)', { verify: !shortDate(navDate), note: shortDate(navDate) ? undefined : 'NAV date not shown on the source page' });
      }
    }

    // ---- DBS on SGX ----
    const dbs = await mkInst('EQUITY_SG', 'DBS Group Holdings (SGX: D05)', { short: 'DBS Group Holdings', symbol: 'D05', exchange: 'SGX', ccy: 'SGD', meta: { link: D.foreign.link } });
    const R = D.foreign.ref;
    await setPrice(dbs, R.px, R.prev, '2026-11-06', null, 'seed', 'prototype seed (Yahoo delayed quote from a screenshot)', { verify: true });
    await c.query(`insert into fx_rate(pair,rate,as_of_date,kind,source,verify) values ('SGDINR',$1,'2026-11-06','reference','prototype seed (x-rates, single source)',true)`, [R.fx]);
    for (const [acc, F] of [['P-FOR', D.foreign], ['S-FOR', D.foreignS]] as const) {
      await opening(acc, dbs, snapDate, F.avail, F.availCost ?? F.availVal, { notes: 'Available shares; cost as you gave it', ccy: 'SGD' });
      await opening(acc, dbs, snapDate, F.unv, F.unvCost ?? F.unvVal, { bucket: 'UNVESTED', notes: 'Unvested shares; cost as you gave it', ccy: 'SGD' });
    }

    // ---- Indices ----
    for (const ix of D.indices) {
      const id = await mkInst('INDEX', ix.n, { meta: { dayPctText: ix.day, status: ix.st, src: ix.src } });
      const lvl = num(ix.lvl);
      if (Number.isFinite(lvl)) await setPrice(id, lvl, null, '2026-11-09', null, 'seed', 'prototype seed (' + String(ix.src).slice(0, 80) + ')', { verify: false, note: ix.day ? 'day change as printed: ' + ix.day : undefined });
    }

    // ---- Balances valued as given ----
    const bal = async (owner: string, kind: string, label: string, value: number, cost: number | null, meta: object = {}) => {
      await c.query('insert into asset_balance(owner_id,kind,label,value_inr,cost_inr,as_of,meta) values ($1,$2,$3,$4,$5,null,$6)', [ownerId[owner], kind, label, value, cost, meta]);
    };
    await bal('Personal', 'PF', D.pfP.label, D.pfP.value, D.pfP.value);
    await bal('Personal', 'NPS', D.nps.label, D.nps.value, D.nps.cost, { withdrawn: D.nps.withdrawn, xirr: D.nps.xirr, alloc: D.nps.alloc });
    await bal('Sravanthi', 'PF', D.pf.label, D.pf.value, D.pf.value);
    await bal('Sravanthi', 'BANK', D.bankS.label, D.bankS.value, D.bankS.value);
    await bal('Sravanthi', 'BANK', D.bankS2.label, D.bankS2.value, D.bankS2.value);
    await bal('HUF', 'PMS_CASH', D.hufCash.label, D.hufCash.value, D.hufCash.value);

    // ---- Look-through and allocation ----
    const mfNames = (await c.query(`select id, name from instrument where asset_class='MF'`)).rows as { id: number; name: string }[];
    const findFund = (prefix: string) => mfNames.find((m) => m.name.toLowerCase().startsWith(prefix.toLowerCase()))?.id ?? null;
    for (const f of D.exposure?.funds ?? []) {
      const id = findFund(f.prefix);
      if (!id) { report.unmatchedFunds.push('lookthrough:' + f.prefix); continue; }
      for (const [stockName, w] of f.rows) await c.query('insert into fund_lookthrough(fund_instrument_id,stock_name,weight,as_of,source) values ($1,$2,$3,$4,$5) on conflict do nothing', [id, stockName, w, f.asOf, f.src]);
      await c.query(`update instrument set meta = meta || $2::jsonb where id=$1`, [id, JSON.stringify({ lookthroughCover: f.cover })]);
    }
    for (const a of D.alloc?.funds ?? []) {
      const id = findFund(a.p);
      if (!id) { report.unmatchedFunds.push('alloc:' + a.p); continue; }
      await c.query('insert into fund_allocation(fund_instrument_id,debt,other,extra,as_of,source,tag) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing', [id, a.debt, a.oth, a.extra ?? 0, D.alloc.asOf, a.src, a.tag]);
    }

    // ---- Watchlist, flags, holidays, meta ----
    for (const w of D.watch ?? []) await c.query('insert into watchlist(when_label,category,title,detail) values ($1,$2,$3,$4)', [w[0], w[1], w[2], w[3]]);
    for (const f of D.flags ?? []) await c.query('insert into note_flag(text) values ($1)', [f]);
    for (const [day, label] of [['2026-11-10', 'Diwali-Balipratipada'], ['2026-11-24', 'Guru Nanak Jayanti']]) {
      await c.query(`insert into market_holiday(day,label,source) values ($1,$2,'Upstox holiday table read 10 Nov 2026 (secondary source). Check the NSE circular.')`, [day, label]);
    }
    const kv = async (k: string, v: unknown) => { await c.query('insert into meta_kv(key,value) values ($1,$2)', [k, JSON.stringify(v ?? null)]); };
    await kv('prototype', { runDate: D.runDate, window: D.window, weeklyNote: D.weeklyNote, snapDate: D.snapDate, snapBasis: D.snapBasis, file: D.file });
    await kv('exposure_alias', D.exposure?.alias ?? {});
    await kv('exposure_excluded', D.exposure?.excluded ?? []);
    await kv('exposure_cover', Object.fromEntries((D.exposure?.funds ?? []).map((f: any) => [f.prefix, { asOf: f.asOf, src: f.src, cover: f.cover }])));
    await kv('alloc_asof', D.alloc?.asOf ?? null);

    for (const id of Object.values(accId)) await rebuildAccount(c, id);
  });
  return report;
}

function isoFromLong(s: string): string | null {
  const m = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${MON[m[2]]}-${m[1].padStart(2, '0')}` : null;
}
