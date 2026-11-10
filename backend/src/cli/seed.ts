import { seedFromFile } from '../services/seed.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { migrate } from './migrate.js';

await migrate();
const rep = await seedFromFile(config.seedFile, process.argv.includes('--force'));
console.log(JSON.stringify(rep, null, 2));
await pool.end();
