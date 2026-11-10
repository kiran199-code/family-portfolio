import { http, toIsoDate } from './types.js';

export interface AmfiRow { code: string; isinGrowth: string | null; isinReinvest: string | null; name: string; plan: string; option: string; nav: number; date: string }

// Verified 10 Nov 2026 (first part of file): semicolon separated; header
// Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date
// Date format DD-Mon-YYYY. Blank lines and AMC / category heading lines are interleaved with data rows.
export function parseAmfi(text: string): Map<string, AmfiRow> {
  const out = new Map<string, AmfiRow>();
  for (const line of text.split(/\r?\n/)) {
    const p = line.split(';');
    if (p.length < 8 || !/^\d+$/.test(p[0].trim())) continue;
    const nav = parseFloat(p[6]);
    const date = toIsoDate(p[7]);
    if (!Number.isFinite(nav) || !date) continue; // e.g. "N.A."
    const clean = (s: string) => (s.trim() === '' || s.trim() === '-' ? null : s.trim());
    out.set(p[0].trim(), { code: p[0].trim(), isinGrowth: clean(p[1]), isinReinvest: clean(p[2]), name: p[3].trim(), plan: p[4].trim(), option: p[5].trim(), nav, date });
  }
  return out;
}

export async function fetchAmfi(): Promise<Map<string, AmfiRow>> {
  // https://www.amfiindia.com/spages/NAVAll.txt redirected to portal.amfiindia.com on 10 Nov 2026; fetch follows redirects.
  const text = await http('https://www.amfiindia.com/spages/NAVAll.txt', { provider: 'amfi', timeoutMs: 60000 });
  const m = parseAmfi(text);
  if (m.size < 1000) throw new Error(`AMFI file parsed to only ${m.size} rows; format may have changed`);
  return m;
}
