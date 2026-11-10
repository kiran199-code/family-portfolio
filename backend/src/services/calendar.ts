import type pg from 'pg';

/** Current date in India (YYYY-MM-DD). */
export function istDate(d = new Date()): string {
  return new Date(d.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
}
export function istMinutes(d = new Date()): number {
  const t = new Date(d.getTime() + 5.5 * 3600000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}
export function isWeekend(day: string): boolean {
  const w = new Date(day + 'T00:00:00Z').getUTCDay();
  return w === 0 || w === 6;
}
/** A regular trading day: weekday and not in market_holiday (holiday list is maintained by hand and flagged unverified). */
export async function isTradingDay(c: pg.Pool | pg.PoolClient, day: string): Promise<boolean> {
  if (isWeekend(day)) return false;
  const r = await c.query('select 1 from market_holiday where day=$1', [day]);
  return r.rowCount === 0;
}
/**
 * Label a broker LTP honestly. It is only called a close when fetched after 15:45 IST on the trading day
 * the price belongs to. Anything else stays intraday and is never shown as a close.
 */
export function classifyLtp(now: Date, tradingDay: boolean): 'close' | 'intraday' {
  return tradingDay && istMinutes(now) >= 15 * 60 + 45 ? 'close' : 'intraday';
}
