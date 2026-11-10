import pg from 'pg';
import { config } from './config.js';

// Return NUMERIC as JS numbers. Values here stay far inside double precision for INR amounts.
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)) as any);
// Return DATE as 'YYYY-MM-DD' strings (no timezone shifts).
pg.types.setTypeParser(1082, (v) => v as any);
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)) as any);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export type Q = { query: pg.Pool['query'] };

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

export async function audit(c: Q, username: string | null, entity: string, entityId: string | number | null, action: string, before: unknown, after: unknown) {
  await c.query('insert into audit_log(username, entity, entity_id, action, before, after) values ($1,$2,$3,$4,$5,$6)', [
    username, entity, entityId == null ? null : String(entityId), action,
    before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
  ]);
}
