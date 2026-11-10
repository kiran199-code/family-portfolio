import { buildApp, ensureAdminUser } from './app.js';
import { config } from './config.js';
import { migrate } from './cli/migrate.js';
import { startScheduler } from './scheduler.js';
import { pool } from './db.js';
import { seedFromFile } from './services/seed.js';

await migrate();
await ensureAdminUser();
// One-time first-deploy convenience: load the seed file only when the ledger is completely empty.
if (process.env.SEED_ON_EMPTY === 'true') {
  const n = (await pool.query('select count(*)::int n from txn')).rows[0].n;
  if (n === 0) console.log('Empty ledger: seeding from', config.seedFile, JSON.stringify(await seedFromFile(config.seedFile, false)).slice(0, 300));
}
const app = await buildApp();
startScheduler((m) => app.log.info(m));
await app.listen({ port: config.port, host: '0.0.0.0' });
