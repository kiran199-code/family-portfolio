import { http, Quote } from './types.js';

// UNOFFICIAL. The yfinance README says Yahoo's API is "for personal use only"; a web-fetch tool reported that
// robots.txt disallows automated fetching of this endpoint. Disabled unless ENABLE_UNOFFICIAL_YAHOO=true.
// Response shape below is from general knowledge of the public chart endpoint and has NOT been verified here:
//   GET https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=5d
//   chart.result[0].meta.{regularMarketPrice, chartPreviousClose, regularMarketTime(unix s), currency, exchangeTimezoneName}
export function parseYahooChart(symbol: string, json: any): Quote | null {
  const m = json?.chart?.result?.[0]?.meta;
  if (!m || typeof m.regularMarketPrice !== 'number') return null;
  const t = typeof m.regularMarketTime === 'number' ? new Date(m.regularMarketTime * 1000) : new Date();
  const offset = typeof m.gmtoffset === 'number' ? m.gmtoffset : 0;
  return {
    key: symbol, price: m.regularMarketPrice, prevClose: typeof m.chartPreviousClose === 'number' ? m.chartPreviousClose : null,
    asOf: t.toISOString(), asOfDate: new Date(t.getTime() + offset * 1000).toISOString().slice(0, 10),
    kind: 'delayed', source: 'yahoo (unofficial)', note: 'unofficial endpoint, personal use only',
  };
}

export async function fetchYahoo(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  for (const s of symbols) {
    try {
      const text = await http(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=5d`, { provider: 'yahoo', retries: 0 });
      const q = parseYahooChart(s, JSON.parse(text));
      if (q) out.set(s, q);
    } catch { /* one symbol failing must not hide the others */ }
    await new Promise((r) => setTimeout(r, 400)); // be gentle
  }
  return out;
}
