import cron from 'node-cron';
import { config } from './config.js';
import { runJob, JobName } from './services/jobs.js';

/**
 * Indian market hours: stocks settle ~15:30 IST, close reports by ~16:30, NAVs usually after 21:00 and sometimes later.
 * Every job is idempotent: if nothing newer is published it changes nothing and saves no snapshot.
 */
export function startScheduler(log: (m: string) => void = console.log) {
  if (!config.enableScheduler) return;
  const at = (expr: string, job: JobName, label: string) =>
    cron.schedule(expr, async () => {
      try { const r = await runJob(job); log(`[${label}] ${JSON.stringify(r.map((x) => ({ job: x.job, updated: x.updated, failed: x.failed.length, skipped: x.skipped })))}`); }
      catch (e) { log(`[${label}] failed: ${String((e as any).message)}`); }
    }, { timezone: config.tz });
  at('0 10 * * 1-5', 'fx', 'fx morning');
  at('45 16 * * 1-5', 'stocks', 'stock closes');           // after the close, once reports are out
  at('30 21 * * 1-5', 'nav', 'NAV evening');
  at('30 1 * * 2-6', 'nav', 'NAV late catch-up');         // for NAVs published after midnight
  at('45 22 * * 1-5', 'snapshot', 'daily snapshot');
}
