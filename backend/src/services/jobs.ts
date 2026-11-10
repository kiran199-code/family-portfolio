import { pool } from '../db.js';
import { buildDashboard } from './dashboard.js';
import { isTradingDay, istDate } from './calendar.js';
import { refreshMutualFunds, refreshFx, refreshStocks, refreshUlips, markStale, JobSummary } from './pricing.js';

export type JobName = 'nav' | 'stocks' | 'fx' | 'ulip' | 'snapshot' | 'all';

/** Saves one snapshot per market date. Idempotent: running twice for the same date replaces that day's row. */
export async function saveSnapshot(): Promise<{ saved: boolean; date?: string; reason?: string }> {
  const dash = await buildDashboard(pool);
  if (dash.warnings.length) return { saved: false, reason: 'Some holdings have no price; no snapshot saved: ' + dash.warnings.slice(0, 3).join('; ') };
  const r = await pool.query(`select max(as_of_date) d from price_cache where kind in ('close','nav') and as_of_date <= $1`, [istDate()]);
  const date: string | null = r.rows[0]?.d ?? null;
  if (!date) return { saved: false, reason: 'No live close or NAV has been fetched yet (only seed values); no snapshot saved' };
  const last = (await pool.query(`select max(fetched_at) f from price_cache where kind in ('close','nav')`)).rows[0]?.f;
  if (!last) return { saved: false, reason: 'No live values' };
  const per: Record<string, { v: number; c: number }> = {};
  for (const p of dash.portfolios) per[p.code] = { v: Math.round(p.value * 100) / 100, c: Math.round(p.cost * 100) / 100 };
  const dates = (await pool.query(`select a.asset_class, min(p.as_of_date) lo, max(p.as_of_date) hi from price_cache p join instrument a on a.id=p.instrument_id group by a.asset_class`)).rows;
  const basis = dates.map((x) => `${x.asset_class}: ${x.lo === x.hi ? x.lo : x.lo + ' to ' + x.hi}`).join('; ') + '. PF, NPS, bank and PMS cash are carried as given.';
  await pool.query(
    `insert into snapshot(snap_date,total_inr,cost_inr,data,basis) values ($1,$2,$3,$4,$5)
     on conflict (snap_date) do update set total_inr=excluded.total_inr, cost_inr=excluded.cost_inr, data=excluded.data, basis=excluded.basis, created_at=now()`,
    [date, Math.round(dash.totals.value * 100) / 100, Math.round(dash.totals.cost * 100) / 100, JSON.stringify(per), basis]);
  return { saved: true, date };
}

export async function runJob(job: JobName, opts: { force?: boolean } = {}): Promise<JobSummary[]> {
  const run = (await pool.query(`insert into refresh_run(job) values ($1) returning id`, [job])).rows[0].id;
  const out: JobSummary[] = [];
  let ok = true;
  try {
    const todo: JobName[] = job === 'all' ? ['fx', 'stocks', 'nav', 'ulip', 'snapshot'] : [job];
    for (const j of todo) {
      if (j === 'nav') out.push(await refreshMutualFunds());
      else if (j === 'fx') out.push(await refreshFx());
      else if (j === 'stocks') out.push(await refreshStocks());
      else if (j === 'ulip') out.push(await refreshUlips());
      else if (j === 'snapshot') {
        const anyUpdate = out.some((x) => x.updated > 0);
        if (job === 'all' && !anyUpdate && !opts.force) out.push({ job: 'snapshot', skipped: 'no new price or NAV arrived in this run, so no snapshot was saved', updated: 0, unchanged: 0, failed: [], rejected: [], notes: [], sources: [] });
        else { const r = await saveSnapshot(); out.push({ job: 'snapshot', skipped: r.saved ? undefined : r.reason, updated: r.saved ? 1 : 0, unchanged: 0, failed: [], rejected: [], notes: r.saved ? ['saved for ' + r.date] : [], sources: [] }); }
      }
    }
    await markStale();
    ok = out.every((x) => x.failed.length === 0);
  } catch (e) {
    ok = false;
    out.push({ job: 'error', updated: 0, unchanged: 0, failed: [String((e as any).message)], rejected: [], notes: [], sources: [] });
  }
  await pool.query('update refresh_run set finished_at=now(), ok=$2, summary=$3 where id=$1', [run, ok, JSON.stringify(out)]);
  return out;
}

export async function tradingDayToday() { return isTradingDay(pool, istDate()); }
