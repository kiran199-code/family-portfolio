import { describe, it, expect } from 'vitest';
import { parseAmfi } from '../src/providers/amfi.js';
import { parseMfapi } from '../src/providers/mfapi.js';
import { parseFrankfurter } from '../src/providers/frankfurter.js';
import { parseUpstoxLtp, resolveUpstoxKey } from '../src/providers/upstox.js';
import { parseDhanLtp } from '../src/providers/dhan.js';
import { parseYahooChart } from '../src/providers/yahoo.js';
import { extractUlipNav } from '../src/providers/ulip.js';
import { toIsoDate } from '../src/providers/types.js';
import { classifyLtp } from '../src/services/calendar.js';

// Fixtures: AMFI header and mfapi/Frankfurter bodies are REAL responses read on 10 Nov 2026.
// Upstox/Dhan fixtures are built from the example responses in their docs; Yahoo from memory (unverified).
const AMFI = `Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date

Open Ended Schemes(Equity Scheme - Small Cap Fund)

Franklin Templeton Mutual Fund
103360;INF090I01569;-;Franklin India Small Cap Fund - Regular Plan - Growth;Regular Plan;Growth Option;170.0801;09-Nov-2026
999999;INF000000000;-;Some Fund;Direct Plan;Growth Option;N.A.;09-Nov-2026
153029;INF247L01AB1;-;Motilal Oswal Nifty MidSmall IT & Telecom Index Fund - Direct Plan - Growth;Direct Plan;Growth Option;9.9427;09-Nov-2026
`;

describe('AMFI parser', () => {
  const m = parseAmfi(AMFI);
  it('parses data rows and skips headings, blanks and N.A.', () => { expect(m.size).toBe(2); expect(m.has('999999')).toBe(false); });
  it('converts the date format and NAV', () => { expect(m.get('103360')).toMatchObject({ nav: 170.0801, date: '2026-11-09', plan: 'Regular Plan' }); });
  it('keeps the plan so Direct/Regular mix-ups can be caught', () => { expect(m.get('153029')!.plan).toBe('Direct Plan'); });
});

describe('mfapi parser (real response shape)', () => {
  const body = { meta: { scheme_code: 103360 }, data: [{ date: '09-11-2026', nav: '170.08010' }, { date: '06-11-2026', nav: '168.31070' }], status: 'SUCCESS' };
  it('parses newest-first data with DD-MM-YYYY dates', () => { expect(parseMfapi('103360', body)).toEqual([{ code: '103360', date: '2026-11-09', nav: 170.0801 }, { code: '103360', date: '2026-11-06', nav: 168.3107 }]); });
  it('returns nothing on a failure status', () => { expect(parseMfapi('1', { status: 'ERROR', data: [] })).toEqual([]); });
});

describe('Frankfurter parser (real response shapes)', () => {
  it('array form', () => { expect(parseFrankfurter([{ date: '2026-11-10', base: 'SGD', quote: 'INR', rate: 73.345 }])).toEqual({ base: 'SGD', quote: 'INR', rate: 73.345, date: '2026-11-10' }); });
  it('object form', () => { expect(parseFrankfurter({ date: '2026-11-10', base: 'SGD', quote: 'INR', rate: 73.345 })?.rate).toBe(73.345); });
  it('garbage gives null', () => { expect(parseFrankfurter({ foo: 1 })).toBeNull(); });
});

describe('Upstox', () => {
  const body = { status: 'success', data: { 'NSE_EQ:NHPC': { last_price: 84.5, instrument_token: 'NSE_EQ|INE848E01016', ltq: 1, volume: 100, cp: 83.9 } } };
  it('parses v3 LTP with previous close (cp)', () => { const q = parseUpstoxLtp(body).get('NSE_EQ|INE848E01016')!; expect(q.price).toBe(84.5); expect(q.prevClose).toBe(83.9); });
  it('ignores rows without a price', () => { expect(parseUpstoxLtp({ data: { x: { instrument_token: 'a' } } }).size).toBe(0); });
  const master = [{ segment: 'NSE_EQ', isin: 'INE848E01016', trading_symbol: 'NHPC', instrument_key: 'NSE_EQ|INE848E01016' }, { segment: 'BSE_EQ', isin: 'INE848E01016', trading_symbol: 'NHPC', instrument_key: 'BSE_EQ|INE848E01016' }];
  it('resolves by ISIN then symbol in the right segment', () => {
    expect(resolveUpstoxKey(master, { isin: 'INE848E01016' })).toBe('NSE_EQ|INE848E01016');
    expect(resolveUpstoxKey(master, { symbol: 'nhpc', exchange: 'BSE' })).toBe('BSE_EQ|INE848E01016');
    expect(resolveUpstoxKey(master, { symbol: 'NOPE' })).toBeNull();
  });
});

describe('Dhan', () => {
  it('parses ltp response keyed by segment and security id and does not take a previous close', () => {
    const q = parseDhanLtp({ data: { NSE_EQ: { '11536': { last_price: 4520 } } }, status: 'success' }).get('NSE_EQ:11536')!;
    expect(q.price).toBe(4520); expect(q.prevClose).toBeNull();
  });
});

describe('Yahoo (unverified shape, off by default)', () => {
  it('parses meta', () => {
    const q = parseYahooChart('D05.SI', { chart: { result: [{ meta: { regularMarketPrice: 69.72, chartPreviousClose: 71.2, regularMarketTime: 1762420503, gmtoffset: 28800 } }] } })!;
    expect(q.price).toBe(69.72); expect(q.prevClose).toBe(71.2); expect(q.kind).toBe('delayed');
  });
  it('null on error payload', () => { expect(parseYahooChart('X', { chart: { result: null } })).toBeNull(); });
});

describe('ULIP page extraction', () => {
  it('uses your regex', () => { expect(extractUlipNav('<p>NAV as on 05 Nov 2026: 50.16</p>', 'NAV as on (\\d+ \\w+ \\d{4}): ([\\d.]+)')).toBeNull(); });
  it('captures nav then date', () => { expect(extractUlipNav('<b>50.16</b> as on 05-Nov-2026', '([\\d.]+)</b> as on ([\\w-]+)')).toEqual({ nav: 50.16, date: '2026-11-05' }); });
});

describe('dates and labels', () => {
  it('toIsoDate', () => { expect(toIsoDate('9-Nov-2026')).toBe('2026-11-09'); expect(toIsoDate('05-11-2026')).toBe('2026-11-05'); expect(toIsoDate('junk')).toBeNull(); });
  it('LTP is only a close after 15:45 IST on a trading day', () => {
    expect(classifyLtp(new Date('2026-11-09T10:00:00Z'), true)).toBe('intraday');   // 15:30 IST
    expect(classifyLtp(new Date('2026-11-09T10:30:00Z'), true)).toBe('close');      // 16:00 IST
    expect(classifyLtp(new Date('2026-11-09T10:30:00Z'), false)).toBe('intraday');  // not a trading day
  });
});
