import { runJob, JobName } from '../services/jobs.js';
import { pool } from '../db.js';

const job = (process.argv[2] ?? 'all') as JobName;
const res = await runJob(job, { force: job === 'snapshot' });
console.log(JSON.stringify(res, null, 2));
await pool.end();
