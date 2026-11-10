import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { http, ProviderError, Quote } from './types.js';

// Per Upstox developer docs (read 10 Nov 2026):
//   GET https://api.upstox.com/v3/market-quote/ltp?instrument_key=NSE_EQ%7CINE848E01016   (comma separate several)
//   header  Authorization: Bearer <access_token>
//   response {"status":"success","data":{"NSE_EQ:NHPC":{"last_price":..,"instrument_token":"NSE_EQ|INE848E01016","ltq":..,"volume":..,"cp":<previous close>}}}
//   Instrument master: https://assets.upstox.com/market-quote/instruments/exchange/{NSE|BSE|complete}.json.gz
//   records have segment, isin, trading_symbol, name, instrument_key, instrument_type.
// NOT verified: token lifetime, per-request instrument limit for V3 LTP (chunk size 100 is conservative), live behaviour.
// Add real credentials in the Admin page, then run the Phase 0 spike.

export interface UpstoxMasterRow { segment: string; isin?: string; trading_symbol: string; name?: string; instrument_key: string; instrument_type?: string }

export function parseUpstoxLtp(json: any, now = new Date()): Map<string, Quote> {
  const out = new Map<string, Quote>();
  const data = json?.data;
  if (!data || typeof data !== 'object') return out;
  for (const v of Object.values<any>(data)) {
    if (typeof v?.last_price !== 'number' || !v.instrument_token) continue;
    out.set(v.instrument_token, {
      key: v.instrument_token, price: v.last_price, prevClose: typeof v.cp === 'number' ? v.cp : null,
      asOf: now.toISOString(), asOfDate: istDate(now), kind: 'intraday', source: 'upstox',
    });
  }
  return out;
}

export function istDate(d: Date): string {
  return new Date(d.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
}

export async function fetchUpstoxLtp(token: string, keys: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const url = `https://api.upstox.com/v3/market-quote/ltp?instrument_key=${chunk.map(encodeURIComponent).join(',')}`;
    const text = await http(url, { provider: 'upstox', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    for (const [k, q] of parseUpstoxLtp(JSON.parse(text))) out.set(k, q);
  }
  return out;
}

export async function fetchUpstoxMaster(exchange: 'NSE' | 'BSE' | 'complete' = 'NSE'): Promise<UpstoxMasterRow[]> {
  const res = await fetch(`https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.json.gz`, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, 'upstox');
  const buf = await promisify(zlib.gunzip)(Buffer.from(await res.arrayBuffer()));
  return JSON.parse(buf.toString('utf8'));
}

/** Find the Upstox instrument key for an equity by ISIN first, then by NSE trading symbol. */
export function resolveUpstoxKey(master: UpstoxMasterRow[], q: { isin?: string | null; symbol?: string | null; exchange?: string | null }): string | null {
  const seg = q.exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ';
  if (q.isin) { const r = master.find((m) => m.isin === q.isin && m.segment === seg); if (r) return r.instrument_key; }
  if (q.symbol) { const r = master.find((m) => m.trading_symbol?.toUpperCase() === q.symbol!.toUpperCase() && m.segment === seg); if (r) return r.instrument_key; }
  return null;
}

/** Index keys use the segment NSE_INDEX with the index trading symbol as printed in the master (e.g. 'Nifty 50'). */
export function resolveUpstoxIndex(master: UpstoxMasterRow[], name: string): string | null {
  const r = master.find((m) => m.segment === 'NSE_INDEX' && (m.name?.toLowerCase() === name.toLowerCase() || m.trading_symbol?.toLowerCase() === name.toLowerCase()));
  return r?.instrument_key ?? null;
}
