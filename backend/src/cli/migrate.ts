import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../db.js';

export async function migrate(dir = new URL('../../migrations', import.meta.url).pathname) {
  await pool.query('create table if not exists schema_migration(name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await pool.query('select name from schema_migration')).rows.map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query('insert into schema_migration(name) values ($1)', [f]);
      await c.query('commit');
      console.log('applied', f);
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }
}

if (process.argv[1]?.endsWith('migrate.ts')) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
