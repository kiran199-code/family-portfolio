import { http, Quote } from './types.js';
import { istDate } from './upstox.js';

// Per Dhan docs (read 10 Nov 2026): POST https://api.dhan.co/v2/marketfeed/ltp
//   headers  access-token: <JWT>, client-id: <id>, Content-Type: application/json
//   body     {"NSE_EQ":[11536],"BSE_EQ":[500325]}   (segment -> security ids; 1 request/second, max 1000 ids)
//   response {"data":{"NSE_EQ":{"11536":{"last_price":4520}}},"status":"success"}
// Segment names include NSE_EQ and BSE_EQ (annexure). Data APIs may carry extra charges (amount not stated).
// NOT verified: which column of the scrip master holds the security id, previous-close semantics.
// So previous close is NOT taken from this provider (prevClose = null) and prices are flagged "verify".
export function parseDhanLtp(json: any, now = new Date()): Map<string, Quote> {
  const out = new Map<string, Quote>();
  const data = json?.data;
  if (!data || typeof data !== 'object') return out;
  for (const [segment, rows] of Object.entries<any>(data)) {
    for (const [id, v] of Object.entries<any>(rows ?? {})) {
      if (typeof v?.last_price !== 'number') continue;
      const key = `${segment}:${id}`;
      out.set(key, { key, price: v.last_price, prevClose: null, asOf: now.toISOString(), asOfDate: istDate(now), kind: 'intraday', source: 'dhan', note: 'previous close not taken from Dhan' });
    }
  }
  return out;
}

export async function fetchDhanLtp(creds: { accessToken: string; clientId: string }, keys: { segment: string; securityId: number }[]): Promise<Map<string, Quote>> {
  const body: Record<string, number[]> = {};
  for (const k of keys) (body[k.segment] ??= []).push(k.securityId);
  const text = await http('https://api.dhan.co/v2/marketfeed/ltp', {
    provider: 'dhan', method: 'POST', body: JSON.stringify(body),
    headers: { 'access-token': creds.accessToken, 'client-id': creds.clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  return parseDhanLtp(JSON.parse(text));
}
