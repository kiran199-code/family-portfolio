import type pg from 'pg';
import { istDate } from './calendar.js';

type C = pg.Pool | pg.PoolClient;

export interface PriceInfo { price: number | null; prev: number | null; asOfDate: string | null; kind: string | null; source: string | null; verify: boolean; stale: boolean; note: string | null; overridden: boolean }

export interface Row {
  key: string; accountId: number; accountLabel: string; instrumentId: number | null; assetClass: string;
  name: string; shortName: string; plan: string | null; symbol: string | null; symbolVerified: boolean; currency: string; bucket: string;
  qty: number; cost: number; income: number;
  price: number | null; prevPrice: number | null; priceDate: string | null; kind: string | null; source: string | null; verify: boolean; stale: boolean; ageDays: number | null; note: string | null; overridden: boolean;
  value: number | null; day: number | null; pvBase: number | null; retPct: number | null; dayPct: number | null; link?: string;
  undated?: boolean;
}

export interface Part { key: string; label: string; value: number; cost: number; day: number; pv: number; n: number; m: number; rows: Row[]; policies?: any[] }
export interface PortfolioOut { code: string; label: string; value: number; cost: number; gain: number; gainPct: number; day: number; pv: number; n: number; m: number; parts: Part[] }

const PART_LABEL: Record<string, string> = {
  mf: 'Mutual funds', stocks: 'Stocks', pms: 'PMS stocks', ulip: 'ULIP', foreign: 'Foreign share, available', unvested: 'Foreign share, unvested',
  pf: 'Provident fund', nps: 'NPS Tier I', bank: 'Bank accounts', cash: 'Cash',
};

function partKey(accountKind: string, bucket: string): string {
  if (accountKind === 'MF_FOLIO') return 'mf';
  if (accountKind === 'DEMAT') return 'stocks';
  if (accountKind === 'PMS') return 'pms';
  if (accountKind === 'ULIP_POLICY') return 'ulip';
  if (accountKind === 'FOREIGN_BROKER') return bucket === 'UNVESTED' ? 'unvested' : 'foreign';
  return 'other';
}
const BAL_PART: Record<string, string> = { PF: 'pf', NPS: 'nps', BANK: 'bank', PMS_CASH: 'cash' };
const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

export async function effectivePrices(c: C): Promise<Map<number, PriceInfo>> {
  const base = await c.query(`select instrument_id, price, prev_close, to_char(as_of_date,'YYYY-MM-DD') d, kind, source, verify, stale, note from price_cache`);
  const out = new Map<number, PriceInfo>();
  for (const r of base.rows) out.set(r.instrument_id, { price: r.price, prev: r.prev_close, asOfDate: r.d, kind: r.kind, source: r.source, verify: r.verify, stale: r.stale, note: r.note, overridden: false });
  const ov = await c.query(`select distinct on (instrument_id) instrument_id, price, to_char(as_of_date,'YYYY-MM-DD') d, reason from manual_override where active order by instrument_id, as_of_date desc, id desc`);
  for (const o of ov.rows) {
    const cur = out.get(o.instrument_id);
    if (cur && cur.asOfDate && cur.asOfDate > o.d) continue; // a newer live value wins over an older manual one
    out.set(o.instrument_id, {
      price: o.price, prev: cur && cur.asOfDate && cur.asOfDate < o.d ? cur.price : cur?.prev ?? null, asOfDate: o.d, kind: 'manual', source: 'manual override',
      verify: true, stale: false, note: o.reason, overridden: true,
    });
  }
  return out;
}

export async function fxRates(c: C): Promise<Map<string, { rate: number; asOfDate: string; verify: boolean; source: string; kind: string }>> {
  const r = await c.query(`select pair, rate, to_char(as_of_date,'YYYY-MM-DD') d, verify, source, kind from fx_rate`);
  return new Map(r.rows.map((x) => [x.pair, { rate: x.rate, asOfDate: x.d, verify: x.verify, source: x.source, kind: x.kind }]));
}

export async function buildDashboard(c: C, today = istDate()) {
  const prices = await effectivePrices(c);
  const fx = await fxRates(c);
  const warnings: string[] = [];

  const hr = await c.query(`
    select h.account_id, a.kind akind, a.label alabel, a.meta ameta, o.code owner, i.id iid, i.asset_class, i.name, i.short_name, i.plan, i.currency, i.symbol, i.symbol_verified, i.meta imeta,
           h.bucket, h.quantity, h.cost_inr, h.income_inr
      from holding h join account a on a.id=h.account_id join owner o on o.id=a.owner_id join instrument i on i.id=h.instrument_id
     order by o.id, a.id, i.name`);

  const owners = (await c.query('select id, code from owner order by id')).rows as { id: number; code: string }[];
  const parts = new Map<string, Map<string, Part>>(); // owner -> partKey -> Part
  const getPart = (owner: string, key: string): Part => {
    let m = parts.get(owner); if (!m) { m = new Map(); parts.set(owner, m); }
    let p = m.get(key); if (!p) { p = { key, label: PART_LABEL[key] ?? key, value: 0, cost: 0, day: 0, pv: 0, n: 0, m: 0, rows: [] }; m.set(key, p); }
    return p;
  };
  const policyCost = new Map<number, number>();

  for (const r of hr.rows) {
    const pi = prices.get(r.iid);
    let factor = 1;
    if (r.currency !== 'INR') {
      const f = fx.get(r.currency + 'INR');
      if (!f) { warnings.push(`No ${r.currency}/INR rate: ${r.name} is not valued`); factor = NaN; } else factor = f.rate;
    }
    const price = pi?.price ?? null;
    const value = price != null && Number.isFinite(factor) ? r.quantity * price * factor : null;
    const hasPrev = pi?.prev != null && price != null && Number.isFinite(factor);
    const day = hasPrev ? r.quantity * (price! - pi!.prev!) * factor : null;
    const pvBase = hasPrev ? r.quantity * pi!.prev! * factor : null;
    const age = pi?.asOfDate ? Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(pi.asOfDate + 'T00:00:00Z')) / 86400000) : null;
    const key = partKey(r.akind, r.bucket);
    const isUlip = key === 'ulip';
    if (value == null) warnings.push(`No price for ${r.name}: left out of totals rather than estimated`);
    const cost = isUlip ? 0 : r.cost_inr;
    const row: Row = {
      key: `${r.account_id}-${r.iid}-${r.bucket}`, accountId: r.account_id, accountLabel: r.alabel, instrumentId: r.iid, assetClass: r.asset_class,
      name: r.name, shortName: r.short_name ?? r.name, plan: r.plan, symbol: r.symbol, symbolVerified: r.symbol_verified, currency: r.currency, bucket: r.bucket,
      qty: r.quantity, cost, income: r.income_inr, price, prevPrice: pi?.prev ?? null, priceDate: pi?.asOfDate ?? null, kind: pi?.kind ?? null, source: pi?.source ?? null,
      verify: pi?.verify ?? true, stale: pi?.stale ?? false, ageDays: age, note: pi?.note ?? null, overridden: pi?.overridden ?? false,
      value, day, pvBase, retPct: value != null && cost > 0 ? value / cost - 1 : null, dayPct: day != null && pvBase ? day / pvBase : null, link: r.imeta?.link,
    };
    const p = getPart(r.owner, key);
    p.rows.push(row);
    p.m++;
    if (value != null) p.value += value;
    p.cost += cost;
    if (day != null) { p.day += day; p.pv += pvBase!; p.n++; }
    if (isUlip && !policyCost.has(r.account_id)) { policyCost.set(r.account_id, r.ameta?.cost ?? 0); p.cost += r.ameta?.cost ?? 0; }
  }

  // ULIP rows are grouped by policy for display.
  for (const [, m] of parts) {
    const u = m.get('ulip');
    if (!u) continue;
    const byPol = new Map<number, any>();
    for (const row of u.rows) {
      const o = byPol.get(row.accountId) ?? { accountId: row.accountId, policy: row.accountLabel, cost: policyCost.get(row.accountId) ?? 0, value: 0, funds: [] };
      o.value += row.value ?? 0; o.funds.push(row); byPol.set(row.accountId, o);
    }
    u.policies = [...byPol.values()];
  }

  const bal = await c.query(`select b.id, o.code owner, b.kind, b.label, b.value_inr, b.cost_inr, to_char(b.as_of,'YYYY-MM-DD') as_of, b.meta from asset_balance b join owner o on o.id=b.owner_id order by b.id`);
  for (const b of bal.rows) {
    const key = BAL_PART[b.kind] ?? 'other';
    const p = getPart(b.owner, key);
    const row: Row = {
      key: 'bal-' + b.id, accountId: 0, accountLabel: b.label, instrumentId: null, assetClass: b.kind, name: b.label, shortName: b.label, plan: null, symbol: null, symbolVerified: true, currency: 'INR', bucket: 'AVAILABLE',
      qty: 1, cost: b.cost_inr ?? 0, income: 0, price: b.value_inr, prevPrice: null, priceDate: b.as_of, kind: b.as_of ? 'as given' : 'undated', source: 'entered by you', verify: !b.as_of, stale: false,
      ageDays: b.as_of ? Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(b.as_of + 'T00:00:00Z')) / 86400000) : null, note: null, overridden: false,
      value: b.value_inr, day: null, pvBase: null, retPct: b.cost_inr ? b.value_inr / b.cost_inr - 1 : null, dayPct: null, undated: !b.as_of,
    };
    (row as any).balanceId = b.id; (row as any).meta = b.meta;
    p.rows.push(row); p.m++; p.value += b.value_inr; p.cost += b.cost_inr ?? b.value_inr;
  }

  const orderParts: Record<string, string[]> = {
    Personal: ['mf', 'stocks', 'ulip', 'foreign', 'unvested', 'pf', 'nps'],
    HUF: ['mf', 'pms', 'cash'],
    Sravanthi: ['mf', 'pf', 'bank', 'foreign', 'unvested'],
  };
  const portfolios: PortfolioOut[] = owners.map((o) => {
    const m = parts.get(o.code) ?? new Map<string, Part>();
    const order = [...(orderParts[o.code] ?? []), ...[...m.keys()].filter((k) => !(orderParts[o.code] ?? []).includes(k))];
    const ps = order.map((k) => m.get(k)).filter((x): x is Part => !!x);
    // Day change excludes foreign shares, PF, NPS and cash (not repriced daily), as in the prototype.
    const dayParts = ps.filter((p) => !['foreign', 'unvested', 'pf', 'nps', 'bank', 'cash'].includes(p.key));
    const value = ps.reduce((s, p) => s + p.value, 0), cost = ps.reduce((s, p) => s + p.cost, 0);
    return {
      code: o.code, label: o.code === 'Personal' ? 'Personal' : o.code, value, cost, gain: value - cost, gainPct: cost ? value / cost - 1 : 0,
      day: dayParts.reduce((s, p) => s + p.day, 0), pv: dayParts.reduce((s, p) => s + p.pv, 0), n: dayParts.reduce((s, p) => s + p.n, 0), m: ps.reduce((s, p) => s + p.m, 0), parts: ps,
    };
  });
  const totals = {
    value: portfolios.reduce((s, p) => s + p.value, 0), cost: portfolios.reduce((s, p) => s + p.cost, 0),
    day: portfolios.reduce((s, p) => s + p.day, 0), pv: portfolios.reduce((s, p) => s + p.pv, 0),
    n: portfolios.reduce((s, p) => s + p.n, 0), m: portfolios.reduce((s, p) => s + p.m, 0),
  };

  // Indices
  const ir = await c.query(`select i.id, i.name, i.meta, p.price, p.prev_close, to_char(p.as_of_date,'YYYY-MM-DD') d, p.kind, p.source, p.note, p.verify from instrument i left join price_cache p on p.instrument_id=i.id where i.asset_class='INDEX' and i.active order by i.id`);
  const indices = ir.rows.map((x) => ({
    id: x.id, name: x.name, level: x.price, asOfDate: x.d, kind: x.kind, source: x.source, note: x.note, verify: x.verify,
    dayPct: x.price != null && x.prev_close ? x.price / x.prev_close - 1 : null, dayPctText: x.meta?.dayPctText ?? null, status: x.meta?.status ?? null,
  }));

  const exposure = await buildExposure(c, parts);
  const allocation = await buildAllocation(c, portfolios);
  const kv = Object.fromEntries((await c.query('select key, value from meta_kv')).rows.map((r) => [r.key, r.value]));
  const dates = [...prices.values()].map((p) => p.asOfDate).filter((x): x is string => !!x).sort();

  return {
    generatedAt: new Date().toISOString(), today,
    asOf: { latestPriceDate: dates[dates.length - 1] ?? null, oldestPriceDate: dates[0] ?? null, prototype: kv.prototype ?? null },
    totals: { ...totals, gain: totals.value - totals.cost, gainPct: totals.cost ? totals.value / totals.cost - 1 : 0, dayPct: totals.pv ? totals.day / totals.pv : 0 },
    portfolios, indices, exposure, allocation, warnings: [...new Set(warnings)],
  };
}

async function buildExposure(c: C, parts: Map<string, Map<string, Part>>) {
  const alias = (await c.query(`select value from meta_kv where key='exposure_alias'`)).rows[0]?.value ?? {};
  const aliasN: Record<string, string> = {};
  for (const [k, v] of Object.entries<string>(alias)) aliasN[norm(k)] = norm(v);
  const canon = (s: string) => aliasN[norm(s)] ?? norm(s);

  const fundVal = new Map<number, { name: string; value: number }>();
  for (const [, m] of parts) for (const r of m.get('mf')?.rows ?? []) {
    if (r.value == null || r.instrumentId == null) continue;
    const f = fundVal.get(r.instrumentId) ?? { name: r.shortName, value: 0 };
    f.value += r.value; fundVal.set(r.instrumentId, f);
  }
  const lt = (await c.query('select fund_instrument_id fid, stock_name, weight from fund_lookthrough')).rows as { fid: number; stock_name: string; weight: number }[];
  type Agg = { name: string; direct: number; via: { fund: string; value: number }[]; total: number };
  const agg = new Map<string, Agg>();
  const get = (name: string) => { const k = canon(name); let a = agg.get(k); if (!a) { a = { name, direct: 0, via: [], total: 0 }; agg.set(k, a); } return a; };
  const covered = new Set<number>();
  for (const l of lt) {
    const f = fundVal.get(l.fid); if (!f) continue;
    covered.add(l.fid);
    const v = (f.value * l.weight) / 100;
    const a = get(l.stock_name); a.via.push({ fund: f.name, value: v }); a.total += v;
  }
  let directTotal = 0;
  for (const [, m] of parts) for (const key of ['stocks', 'pms']) for (const r of m.get(key)?.rows ?? []) {
    if (r.value == null) continue;
    const a = get(r.name); a.direct += r.value; a.total += r.value; directTotal += r.value;
  }
  const rows = [...agg.values()].sort((a, b) => b.total - a.total);
  const mfTotal = [...fundVal.values()].reduce((s, f) => s + f.value, 0);
  const coveredTotal = [...covered].reduce((s, id) => s + (fundVal.get(id)?.value ?? 0), 0);
  const excluded = (await c.query(`select value from meta_kv where key='exposure_excluded'`)).rows[0]?.value ?? [];
  const cover = (await c.query(`select value from meta_kv where key='exposure_cover'`)).rows[0]?.value ?? {};
  return {
    top: rows.slice(0, 20).map((r, i) => ({ rank: i + 1, ...r, via: r.via.sort((a, b) => b.value - a.value), viaTotal: r.total - r.direct })),
    count: rows.length, directTotal, mfTotal, mfCoveredValue: coveredTotal, mfCoveredPct: mfTotal ? coveredTotal / mfTotal : 0, excluded, cover,
  };
}

async function buildAllocation(c: C, portfolios: PortfolioOut[]) {
  const al = (await c.query('select fund_instrument_id fid, debt, other, extra from fund_allocation')).rows as { fid: number; debt: number; other: number; extra: number }[];
  const am = new Map(al.map((a) => [a.fid, a]));
  let equity = 0, debt = 0, other = 0, extra = 0, unsplit = 0, direct = 0, ulip = 0, foreign = 0, pfnps = 0, bank = 0, cash = 0;
  for (const p of portfolios) for (const part of p.parts) {
    if (part.key === 'mf') for (const r of part.rows) {
      if (r.value == null) continue;
      const a = r.instrumentId != null ? am.get(r.instrumentId) : undefined;
      if (!a) { unsplit += r.value; continue; }
      const d = (r.value * a.debt) / 100, o = (r.value * a.other) / 100, e = (r.value * a.extra) / 100;
      debt += d; other += o; extra += e; equity += r.value - d - o - e;
    } else if (part.key === 'stocks' || part.key === 'pms') direct += part.value;
    else if (part.key === 'ulip') ulip += part.value;
    else if (part.key === 'foreign' || part.key === 'unvested') foreign += part.value;
    else if (part.key === 'pf' || part.key === 'nps') pfnps += part.value;
    else if (part.key === 'bank') bank += part.value;
    else if (part.key === 'cash') cash += part.value;
  }
  return [
    { key: 'fund-equity', label: 'Equity inside funds', value: equity },
    { key: 'direct', label: 'Direct stocks and PMS', value: direct },
    { key: 'fund-debt', label: 'Debt inside funds', value: debt },
    { key: 'fund-other', label: 'Cash/other inside funds', value: other + extra },
    { key: 'unsplit', label: 'Funds without an allocation split', value: unsplit },
    { key: 'ulip', label: 'ULIP (not split)', value: ulip },
    { key: 'foreign', label: 'Foreign shares (DBS)', value: foreign },
    { key: 'pfnps', label: 'PF and NPS', value: pfnps },
    { key: 'bank-cash', label: 'Bank and PMS cash', value: bank + cash },
  ].filter((x) => x.value > 0.5);
}
