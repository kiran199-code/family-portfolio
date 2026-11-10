import { http } from './types.js';

export interface FxQuote { base: string; quote: string; rate: number; date: string }

// Verified 10 Nov 2026:
//   GET https://api.frankfurter.dev/v2/rates?base=sgd&quotes=inr -> [{"date":"2026-11-10","base":"SGD","quote":"INR","rate":73.345}]
//   GET https://api.frankfurter.dev/v2/rate/sgd/inr              -> {"date":"2026-11-10","base":"SGD","quote":"INR","rate":73.345}
// These are reference rates published a few times a day, not live quotes.
export function parseFrankfurter(json: any): FxQuote | null {
  const o = Array.isArray(json) ? json[0] : json;
  if (!o || typeof o.rate !== 'number' || !o.date || !o.base || !o.quote) return null;
  return { base: String(o.base), quote: String(o.quote), rate: o.rate, date: String(o.date) };
}

export async function fetchFx(base: string, quote: string): Promise<FxQuote> {
  const j = JSON.parse(await http(`https://api.frankfurter.dev/v2/rates?base=${base.toLowerCase()}&quotes=${quote.toLowerCase()}`, { provider: 'frankfurter' }));
  const q = parseFrankfurter(j);
  if (!q) throw new Error('Unexpected Frankfurter response');
  return q;
}
