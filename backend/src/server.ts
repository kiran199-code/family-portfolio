import { buildApp, ensureAdminUser } from './app.js';
import { config } from './config.js';
import { migrate } from './cli/migrate.js';
import { startScheduler } from './scheduler.js';

await migrate();
await ensureAdminUser();
const app = await buildApp();
startScheduler((m) => app.log.info(m));
await app.listen({ port: config.port, host: '0.0.0.0' });
