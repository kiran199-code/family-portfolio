import { http, toIsoDate } from './types.js';

export interface MfapiNav { code: string; date: string; nav: number }

// Verified 10 Nov 2026: GET https://api.mfapi.in/mf/{code}/latest
// -> {"meta":{...,"scheme_code":103360,...},"data":[{"date":"09-11-2026","nav":"170.08010"}],"status":"SUCCESS"}
// GET /mf/{code}?startDate=YYYY-MM-DD -> same shape, `data` newest first.
export function parseMfapi(code: string, json: any): MfapiNav[] {
  if (!json || json.status !== 'SUCCESS' || !Array.isArray(json.data)) return [];
  const out: MfapiNav[] = [];
  for (const d of json.data) {
    const date = toIsoDate(String(d.date)); const nav = parseFloat(d.nav);
    if (date && Number.isFinite(nav)) out.push({ code, date, nav });
  }
  return out;
}

export async function fetchMfapi(code: string, startDate?: string): Promise<MfapiNav[]> {
  const url = startDate ? `https://api.mfapi.in/mf/${code}?startDate=${startDate}` : `https://api.mfapi.in/mf/${code}/latest`;
  return parseMfapi(code, JSON.parse(await http(url, { provider: 'mfapi' })));
}
