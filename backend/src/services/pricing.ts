import type pg from 'pg';
import { pool } from '../db.js';
import { config, decrypt, encrypt } from '../config.js';
import { fetchAmfi, AmfiRow } from '../providers/amfi.js';
import { fetchMfapi } from '../providers/mfapi.js';
import { fetchFx } from '../providers/frankfurter.js';
import { fetchUpstoxLtp, fetchUpstoxMaster, resolveUpstoxKey, resolveUpstoxIndex } from '../providers/upstox.js';
import { fetchDhanLtp } from '../providers/dhan.js';
import { fetchYahoo } from '../providers/yahoo.js';
import { fetchUlipNav } from '../providers/ulip.js';
import { Quote } from '../providers/types.js';
import { classifyLtp, isTradingDay, istDate } from './calendar.js';

type C = pg.Pool | pg.PoolClient;

export const PROVIDERS = ['amfi', 'mfapi', 'frankfurter', 'upstox', 'dhan', 'yahoo', 'ulip-page'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

// ---------------------------------------------------------------- provider status / credentials
async function ensureStatus(c: C, p: string) { await c.query('insert into provider_status(provider) values ($1) on conflict do nothing', [p]); }

export async function recordOk(p: string, calls = 1) {
  await ensureStatus(pool, p);
  await pool.query(
    `update provider_status set last_success=now(), last_error=null,
       calls_today = case when calls_day = current_date then calls_today + $2 else $2 end, calls_day=current_date where provider=$1`, [p, calls]);
}
export async function recordFail(p: string, err: unknown) {
  await ensureStatus(pool, p);
  await pool.query('update provider_status set last_error=$2, last_error_at=now() where provider=$1', [p, String((err as any)?.message ?? err).slice(0, 300)]);
}

export async function saveCredentials(p: string, creds: Record<string, string>) {
  await ensureStatus(pool, p);
  await pool.query('update provider_status set credential_cipher=$2, last_error=null where provider=$1', [p, encrypt(JSON.stringify(creds))]);
}
export async function getCredentials(p: string): Promise<Record<string, string> | null> {
  const r = await pool.query('select credential_cipher from provider_status where provider=$1', [p]);
  const blob = r.rows[0]?.credential_cipher;
  return blob ? JSON.parse(decrypt(blob)) : null;
}
export async function providerEnabled(p: string): Promise<boolean> {
  const r = await pool.query('select enabled from provider_status where provider=$1', [p]);
  return r.rows[0]?.enabled ?? true;
}

export async function providerHealth() {
  for (const p of PROVIDERS) await ensureStatus(pool, p);
  const rows = (await pool.query(`select provider, enabled, last_success, last_error, last_error_at, calls_today, calls_day, credential_cipher is not null as has_credentials from provider_status order by provider`)).rows;
  const meta: Record<string, { needsCredentials: boolean; note: string }> = {
    amfi: { needsCredentials: false, note: 'Official AMFI NAV file. Primary for mutual funds.' },
    mfapi: { needsCredentials: false, note: 'Free mirror of AMFI data. Fallback for mutual funds. Numeric rate limit not published.' },
    frankfurter: { needsCredentials: false, note: 'FX reference rates (not live quotes).' },
    upstox: { needsCredentials: true, note: 'Broker API. Needs an access token. Check how often it expires.' },
    dhan: { needsCredentials: true, note: 'Broker API. Needs access token and client id; token valid 24h per docs. Data API may carry extra charges.' },
    yahoo: { needsCredentials: false, note: `Unofficial, personal use only. ${config.enableYahoo ? 'ENABLED by ENABLE_UNOFFICIAL_YAHOO.' : 'Disabled (set ENABLE_UNOFFICIAL_YAHOO=true to opt in).'}` },
    'ulip-page': { needsCredentials: false, note: 'Reads a fund page you configure with a regular expression. No verified API exists for ULIP NAVs.' },
  };
  return rows.map((r) => ({ ...r, ...meta[r.provider], active: r.provider === 'yahoo' ? config.enableYahoo && r.enabled : r.enabled }));
}

// ---------------------------------------------------------------- applying a quote
export interface Apply { price: number; prevClose?: number | null; asOfDate: string; asOfIso: string; kind: string; source: string; verify?: boolean; note?: string | null }
export type ApplyResult = 'updated' | 'unchanged' | 'older' | 'rejected';

/**
 * Writes a live value into price_cache following the standing rules: only move forward in time, keep the previous
 * value for the day change, and refuse implausible jumps instead of storing them.
 */
export async function applyPrice(c: C, instrumentId: number, a: Apply, maxJump = 0.35): Promise<{ result: ApplyResult; reason?: string }> {
  if (!(a.price > 0) || !Number.isFinite(a.price)) return { result: 'rejected', reason: 'non-positive price' };
  const cur = (await c.query(`select price, prev_close, to_char(as_of_date,'YYYY-MM-DD') d, kind, verify, source from price_cache where instrument_id=$1`, [instrumentId])).rows[0];
  let verify = a.verify ?? false;
  let note = a.note ?? null;
  if (cur) {
    if (a.asOfDate < cur.d) return { result: 'older', reason: `source date ${a.asOfDate} is older than stored ${cur.d}` };
    if (a.asOfDate === cur.d && cur.price === a.price && cur.kind === a.kind) return { result: 'unchanged' };
    const jump = Math.abs(a.price / cur.price - 1);
    if (jump > maxJump && cur.kind !== 'seed') return { result: 'rejected', reason: `change of ${(jump * 100).toFixed(1)}% against ${cur.price} on ${cur.d}; needs a manual check (split, bonus or bad data)` };
    if (a.asOfDate > cur.d && a.prevClose != null && Math.abs(a.prevClose / cur.price - 1) > 0.005) {
      verify = true; note = (note ? note + '; ' : '') + `provider previous close ${a.prevClose} differs from stored close ${cur.price} (${cur.d})`;
    }
  }
  const advancing = !cur || a.asOfDate > cur.d;
  const prev = advancing ? (cur ? cur.price : a.prevClose ?? null) : cur.prev_close;
  const prevDate = advancing ? (cur ? cur.d : null) : (await c.query(`select to_char(prev_as_of,'YYYY-MM-DD') d from price_cache where instrument_id=$1`, [instrumentId])).rows[0]?.d ?? null;
  await c.query(
    `insert into price_cache(instrument_id,price,prev_close,prev_as_of,as_of,as_of_date,kind,source,fetched_at,stale,verify,note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,now(),false,$9,$10)
     on conflict (instrument_id) do update set price=excluded.price, prev_close=excluded.prev_close, prev_as_of=excluded.prev_as_of, as_of=excluded.as_of,
       as_of_date=excluded.as_of_date, kind=excluded.kind, source=excluded.source, fetched_at=now(), stale=false, verify=excluded.verify, note=excluded.note`,
    [instrumentId, a.price, prev, prevDate, a.asOfIso, a.asOfDate, a.kind, a.source, verify, note]);
  if (a.kind === 'close' || a.kind === 'nav') {
    await c.query(`insert into price_history(instrument_id,as_of_date,price,kind,source) values ($1,$2,$3,$4,$5)
                   on conflict (instrument_id,as_of_date) do update set price=excluded.price, kind=excluded.kind, source=excluded.source`, [instrumentId, a.asOfDate, a.price, a.kind, a.source]);
  }
  return { result: 'updated' };
}

export interface JobSummary { job: string; skipped?: string; updated: number; unchanged: number; failed: string[]; rejected: string[]; notes: string[]; sources: string[] }
const empty = (job: string): JobSummary => ({ job, updated: 0, unchanged: 0, failed: [], rejected: [], notes: [], sources: [] });

// ---------------------------------------------------------------- mutual funds (AMFI primary, mfapi fallback)
export async function refreshMutualFunds(): Promise<JobSummary> {
  const s = empty('nav');
  const funds = (await pool.query(`select id, name, amfi_code, plan from instrument where asset_class='MF' and active and amfi_code is not null and exists (select 1 from holding h where h.instrument_id=instrument.id)`)).rows;
  let amfi: Map<string, AmfiRow> | null = null;
  try { amfi = await fetchAmfi(); await recordOk('amfi'); s.sources.push('amfi'); } catch (e) { await recordFail('amfi', e); s.notes.push('AMFI file unavailable: ' + String((e as any).message)); }

  let consecutiveFallbackFailures = 0;
  for (const f of funds) {
    const row = amfi?.get(f.amfi_code);
    if (row) {
      const planText = row.plan.toLowerCase();
      if (f.plan && planText && !planText.includes(f.plan.toLowerCase())) { s.rejected.push(`${f.name}: AMFI lists code ${f.amfi_code} as "${row.plan}" but this fund is ${f.plan}. Check the scheme code.`); continue; }
      const r = await applyPrice(pool, f.id, { price: row.nav, asOfDate: row.date, asOfIso: row.date + 'T00:00:00Z', kind: 'nav', source: 'AMFI NAVAll.txt', verify: false });
      if (r.result === 'updated') s.updated++; else if (r.result === 'unchanged') s.unchanged++; else if (r.result === 'rejected') s.rejected.push(`${f.name}: ${r.reason}`);
      continue;
    }
    // fallback: mfapi.in (give up after 3 failures in a row so an outage does not take minutes)
    if (consecutiveFallbackFailures >= 3) { s.failed.push(`${f.name}: skipped, mfapi.in is failing`); continue; }
    try {
      const rows = await fetchMfapi(f.amfi_code);
      consecutiveFallbackFailures = 0;
      if (!rows.length) { s.failed.push(`${f.name}: not found at mfapi.in`); continue; }
      const r = await applyPrice(pool, f.id, { price: rows[0].nav, asOfDate: rows[0].date, asOfIso: rows[0].date + 'T00:00:00Z', kind: 'nav', source: 'mfapi.in', verify: true, note: 'single source (mfapi.in mirror)' });
      await recordOk('mfapi');
      if (!s.sources.includes('mfapi')) s.sources.push('mfapi');
      if (r.result === 'updated') s.updated++; else if (r.result === 'unchanged') s.unchanged++; else if (r.result === 'rejected') s.rejected.push(`${f.name}: ${r.reason}`);
    } catch (e) { consecutiveFallbackFailures++; await recordFail('mfapi', e); s.failed.push(`${f.name}: ${String((e as any).message)}`); }
  }
  return s;
}

// ---------------------------------------------------------------- FX
export async function refreshFx(): Promise<JobSummary> {
  const s = empty('fx');
  const ccys = (await pool.query(`select distinct currency from instrument where currency <> 'INR' and active`)).rows.map((r) => r.currency as string);
  for (const ccy of ccys) {
    try {
      const q = await fetchFx(ccy, 'INR');
      const cur = (await pool.query(`select rate, to_char(as_of_date,'YYYY-MM-DD') d from fx_rate where pair=$1`, [ccy + 'INR'])).rows[0];
      if (cur && cur.d > q.date) { s.unchanged++; continue; }
      await pool.query(
        `insert into fx_rate(pair,rate,prev_rate,as_of_date,kind,source,fetched_at,verify) values ($1,$2,$3,$4,'reference','Frankfurter (reference rate)',now(),false)
         on conflict (pair) do update set prev_rate = case when fx_rate.as_of_date < excluded.as_of_date then fx_rate.rate else fx_rate.prev_rate end, rate=excluded.rate,
           as_of_date=excluded.as_of_date, kind=excluded.kind, source=excluded.source, fetched_at=now(), verify=false`,
        [ccy + 'INR', q.rate, cur ? cur.rate : null, q.date]);
      await recordOk('frankfurter'); s.updated++; s.sources.push('frankfurter');
    } catch (e) { await recordFail('frankfurter', e); s.failed.push(`${ccy}/INR: ${String((e as any).message)}`); }
  }
  return s;
}

// ---------------------------------------------------------------- stocks and indices
interface Target { id: number; name: string; assetClass: string; symbol: string | null; isin: string | null; exchange: string | null; verified: boolean; providerSymbols: Record<string, any>; currency: string }

async function stockTargets(): Promise<Target[]> {
  const r = await pool.query(`
    select i.id, i.name, i.asset_class, i.symbol, i.isin, i.exchange, i.symbol_verified, i.provider_symbols, i.currency
      from instrument i where i.active and ( (i.asset_class in ('EQUITY_IN','EQUITY_SG') and exists (select 1 from holding h where h.instrument_id=i.id)) or i.asset_class='INDEX')`);
  return r.rows.map((x) => ({ id: x.id, name: x.name, assetClass: x.asset_class, symbol: x.symbol, isin: x.isin, exchange: x.exchange, verified: x.symbol_verified, providerSymbols: x.provider_symbols ?? {}, currency: x.currency }));
}

export async function refreshStocks(now = new Date()): Promise<JobSummary> {
  const s = empty('stocks');
  const day = istDate(now);
  if (!(await isTradingDay(pool, day))) { s.skipped = `${day} is not a trading day (weekend or listed holiday); no prices or previous closes changed`; return s; }
  const kind = classifyLtp(now, true);
  const targets = await stockTargets();
  const quotes = new Map<number, { q: Quote; providers: string[]; verify: boolean; note?: string }>();
  const add = (t: Target, q: Quote, provider: string) => {
    const ex = quotes.get(t.id);
    if (!ex) { quotes.set(t.id, { q, providers: [provider], verify: true }); return; }
    ex.providers.push(provider);
    if (Math.abs(ex.q.price / q.price - 1) <= 0.005) ex.verify = false;      // two providers agree within 0.5%
    else { ex.verify = true; ex.note = `providers disagree: ${ex.providers[0]} ${ex.q.price} vs ${provider} ${q.price}`; }
  };

  // Upstox
  const up = (await providerEnabled('upstox')) ? await getCredentials('upstox') : null;
  if (up?.accessToken) {
    try {
      const nse = await fetchUpstoxMaster('NSE');
      const keyToTarget = new Map<string, Target>();
      for (const t of targets.filter((x) => x.currency === 'INR')) {
        let key: string | null = t.providerSymbols.upstox?.key ?? null;
        if (!key && t.assetClass === 'INDEX') key = resolveUpstoxIndex(nse, t.name);
        if (!key && t.assetClass === 'EQUITY_IN' && t.symbol) key = resolveUpstoxKey(nse, { isin: t.isin, symbol: t.symbol, exchange: t.exchange });
        if (!key) { s.failed.push(`${t.name}: no Upstox instrument key (map the symbol)`); continue; }
        if (t.assetClass === 'EQUITY_IN' && !t.verified) s.notes.push(`${t.name}: symbol ${t.symbol} is not verified, price marked verify`);
        keyToTarget.set(key, t);
        await pool.query(`update instrument set provider_symbols = provider_symbols || $2::jsonb where id=$1`, [t.id, JSON.stringify({ upstox: { key } })]);
      }
      const got = await fetchUpstoxLtp(up.accessToken, [...keyToTarget.keys()]);
      for (const [k, q] of got) { const t = keyToTarget.get(k); if (t) add(t, { ...q, kind }, 'upstox'); }
      await recordOk('upstox'); s.sources.push('upstox');
    } catch (e) { await recordFail('upstox', e); s.failed.push('Upstox: ' + String((e as any).message) + ((e as any).status === 401 ? ' (token expired: re-authenticate in Admin)' : '')); }
  }

  // Dhan (needs security ids mapped by hand: provider_symbols.dhan = {segment, securityId})
  const dh = (await providerEnabled('dhan')) ? await getCredentials('dhan') : null;
  if (dh?.accessToken && dh?.clientId) {
    const mapped = targets.filter((t) => t.providerSymbols.dhan?.securityId);
    if (mapped.length) {
      try {
        const got = await fetchDhanLtp({ accessToken: dh.accessToken, clientId: dh.clientId }, mapped.map((t) => ({ segment: t.providerSymbols.dhan.segment ?? 'NSE_EQ', securityId: Number(t.providerSymbols.dhan.securityId) })));
        for (const t of mapped) { const q = got.get(`${t.providerSymbols.dhan.segment ?? 'NSE_EQ'}:${t.providerSymbols.dhan.securityId}`); if (q) add(t, { ...q, kind }, 'dhan'); }
        await recordOk('dhan'); s.sources.push('dhan');
      } catch (e) { await recordFail('dhan', e); s.failed.push('Dhan: ' + String((e as any).message)); }
    }
  }

  // Yahoo (opt-in, unofficial)
  if (config.enableYahoo && (await providerEnabled('yahoo'))) {
    const syms = new Map<string, Target>();
    for (const t of targets) {
      const y = t.providerSymbols.yahoo ?? (t.assetClass === 'EQUITY_IN' && t.symbol ? t.symbol + '.NS' : t.assetClass === 'EQUITY_SG' && t.symbol ? t.symbol + '.SI' : null);
      if (y && !quotes.has(t.id)) syms.set(y, t);
    }
    try {
      const got = await fetchYahoo([...syms.keys()]);
      for (const [k, q] of got) { const t = syms.get(k); if (t) add(t, q, 'yahoo'); }
      if (got.size) { await recordOk('yahoo'); s.sources.push('yahoo'); } else if (syms.size) await recordFail('yahoo', 'no symbols returned');
    } catch (e) { await recordFail('yahoo', e); s.failed.push('Yahoo: ' + String((e as any).message)); }
  }

  for (const [id, v] of quotes) {
    const t = targets.find((x) => x.id === id)!;
    const verify = v.verify || (t.assetClass === 'EQUITY_IN' && !t.verified);
    const r = await applyPrice(pool, id, {
      price: v.q.price, prevClose: v.q.prevClose, asOfDate: v.q.asOfDate, asOfIso: v.q.asOf, kind: v.q.kind,
      source: v.providers.join('+'), verify, note: [v.q.note, v.note, v.providers.length === 1 ? 'single source' : null].filter(Boolean).join('; ') || null,
    });
    if (r.result === 'updated') s.updated++; else if (r.result === 'unchanged') s.unchanged++; else if (r.result === 'rejected') s.rejected.push(`${t.name}: ${r.reason}`);
  }
  const missing = targets.filter((t) => !quotes.has(t.id));
  if (missing.length) s.notes.push(`${missing.length} instruments had no quote from any configured provider; they keep their last value with its date (nothing is estimated)`);
  if (!s.sources.length) s.notes.push('No stock price provider is configured or reachable. Add a broker token in Admin, or enter manual prices.');
  return s;
}

// ---------------------------------------------------------------- ULIP pages (only for instruments you configured)
export async function refreshUlips(): Promise<JobSummary> {
  const s = empty('ulip');
  const rows = (await pool.query(`select id, name, meta from instrument where asset_class='ULIP_FUND' and active and meta ? 'navRegex' and meta ? 'link'`)).rows;
  if (!rows.length) { s.notes.push('No ULIP fund has a navRegex configured; enter NAVs manually (Overrides) or configure a page.'); return s; }
  for (const r of rows) {
    try {
      const x = await fetchUlipNav(r.meta.link, r.meta.navRegex);
      if (!x) { s.failed.push(`${r.name}: NAV not found on the page (layout changed?)`); continue; }
      const a = await applyPrice(pool, r.id, { price: x.nav, asOfDate: x.date, asOfIso: x.date + 'T00:00:00Z', kind: 'nav', source: 'fund page ' + new URL(r.meta.link).host, verify: true, note: 'scraped from a public page' });
      await recordOk('ulip-page');
      if (a.result === 'updated') s.updated++; else if (a.result === 'unchanged') s.unchanged++; else if (a.result === 'rejected') s.rejected.push(`${r.name}: ${a.reason}`);
    } catch (e) { await recordFail('ulip-page', e); s.failed.push(`${r.name}: ${String((e as any).message)}`); }
  }
  return s;
}

/** Marks prices as stale when their date is far behind the newest date of the same kind. */
export async function markStale(): Promise<void> {
  await pool.query(`update price_cache p set stale = (p.as_of_date < current_date - 5) where p.kind <> 'manual'`);
}
