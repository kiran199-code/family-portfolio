import fs from 'node:fs';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fstatic from '@fastify/static';
import bcrypt from 'bcryptjs';
import { z, ZodError } from 'zod';
import { config, requireSecret } from './config.js';
import { pool } from './db.js';
import { LedgerError } from './domain/ledger.js';
import { UserError } from './errors.js';
import { buildDashboard } from './services/dashboard.js';
import { TxnInput, previewTxn, createTxn, updateTxn, deleteTxn, listTxns } from './services/txnService.js';
import { runJob, JobName } from './services/jobs.js';
import { providerHealth, saveCredentials, PROVIDERS } from './services/pricing.js';
import * as admin from './services/admin.js';
import { previewImport, commitImport, reconcile } from './services/importer.js';
import { gainsReport, incomeReport, xirrReport } from './services/reports.js';

export async function ensureAdminUser() {
  const n = (await pool.query('select count(*)::int n from app_user')).rows[0].n;
  if (n > 0) return;
  if (!config.adminUser || config.adminPassword.length < 10) {
    console.warn('No users exist. Set ADMIN_USER and ADMIN_PASSWORD (10+ characters) and restart to create the first login.');
    return;
  }
  await pool.query('insert into app_user(username,password_hash) values ($1,$2)', [config.adminUser, await bcrypt.hash(config.adminPassword, 12)]);
  console.log('Created first user', config.adminUser);
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] } });
  await app.register(cors, { origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : false });
  await app.register(jwt, { secret: requireSecret(), sign: { expiresIn: '12h' } });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid input', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err instanceof LedgerError) return reply.code(422).send({ error: err.message });
    if (err instanceof UserError) return reply.code(400).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong. See the server log.' });
  });

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/') || url === '/api/auth/login' || url === '/api/health') return;
    try { await req.jwtVerify(); } catch { return reply.code(401).send({ error: 'Sign in required' }); }
  });
  const user = (req: any): string => req.user?.sub ?? 'unknown';

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  // ---- auth (with a simple per-IP+user limiter)
  const attempts = new Map<string, { n: number; at: number }>();
  app.post('/api/auth/login', async (req, reply) => {
    const b = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    const k = `${req.ip}|${b.username}`; const a = attempts.get(k);
    if (a && Date.now() - a.at < 60000 && a.n >= 5) return reply.code(429).send({ error: 'Too many attempts. Wait a minute.' });
    const u = (await pool.query('select username, password_hash from app_user where username=$1', [b.username])).rows[0];
    if (!u || !(await bcrypt.compare(b.password, u.password_hash))) {
      attempts.set(k, { n: a && Date.now() - a.at < 60000 ? a.n + 1 : 1, at: Date.now() });
      return reply.code(401).send({ error: 'Wrong username or password' });
    }
    attempts.delete(k);
    return { token: app.jwt.sign({ sub: u.username }), username: u.username };
  });
  app.get('/api/auth/me', async (req) => ({ username: user(req) }));

  // ---- dashboard and data
  app.get('/api/dashboard', async () => buildDashboard(pool));
  app.get('/api/snapshots', async () => (await pool.query(`select to_char(snap_date,'YYYY-MM-DD') date, total_inr total, cost_inr cost, data, basis from snapshot order by snap_date`)).rows);
  app.get('/api/watchlist', async () => admin.watchlist());
  app.post('/api/watchlist', async (req) => ({ id: await admin.addWatch(admin.WatchInput.parse(req.body), user(req)) }));
  app.get('/api/flags', async () => admin.flags());
  app.get('/api/accounts', async () => admin.accounts());

  // ---- instruments
  app.get('/api/instruments', async (req) => { const q = z.object({ assetClass: z.string().optional(), q: z.string().optional() }).parse(req.query); return admin.listInstruments(q); });
  app.post('/api/instruments', async (req) => ({ id: await admin.createInstrument(admin.InstrumentInput.parse(req.body), user(req)) }));
  app.patch('/api/instruments/:id', async (req) => { const { id } = z.object({ id: z.coerce.number() }).parse(req.params); await admin.patchInstrument(id, admin.InstrumentPatch.parse(req.body), user(req)); return { ok: true }; });

  // ---- transactions (the buy/sell update path)
  app.get('/api/transactions', async (req) => { const q = z.object({ accountId: z.coerce.number().optional(), instrumentId: z.coerce.number().optional(), limit: z.coerce.number().optional() }).parse(req.query); return listTxns(q); });
  app.post('/api/transactions/preview', async (req) => previewTxn(TxnInput.parse(req.body)));
  app.post('/api/transactions', async (req, reply) => { const id = await createTxn(TxnInput.parse(req.body), user(req)); return reply.code(201).send({ id }); });
  app.put('/api/transactions/:id', async (req) => { const { id } = z.object({ id: z.coerce.number() }).parse(req.params); await updateTxn(id, TxnInput.parse(req.body), user(req)); return { ok: true }; });
  app.delete('/api/transactions/:id', async (req) => { const { id } = z.object({ id: z.coerce.number() }).parse(req.params); await deleteTxn(id, user(req)); return { ok: true }; });

  // ---- manual overrides and as-given balances
  app.get('/api/overrides', async () => admin.listOverrides());
  app.post('/api/overrides', async (req) => ({ id: await admin.createOverride(admin.OverrideInput.parse(req.body), user(req)) }));
  app.delete('/api/overrides/:id', async (req) => { const { id } = z.object({ id: z.coerce.number() }).parse(req.params); await admin.deactivateOverride(id, user(req)); return { ok: true }; });
  app.put('/api/balances/:id', async (req) => { const { id } = z.object({ id: z.coerce.number() }).parse(req.params); await admin.updateBalance(id, admin.BalanceInput.parse(req.body), user(req)); return { ok: true }; });

  // ---- imports and reconciliation
  app.post('/api/import/preview', async (req) => { const b = z.object({ filename: z.string().default('import.csv'), csv: z.string().min(5) }).parse(req.body); return previewImport(b.csv, b.filename); });
  app.post('/api/import/commit', async (req) => { const b = z.object({ batchId: z.number(), includeDuplicates: z.boolean().optional() }).parse(req.body); return commitImport(b.batchId, user(req), { includeDuplicates: b.includeDuplicates }); });
  app.post('/api/reconcile', async (req) => { const b = z.object({ owner: z.string(), statement: z.array(z.object({ instrument: z.string(), units: z.number() })) }).parse(req.body); return reconcile(b.owner, b.statement); });

  // ---- refresh and providers
  let running = false;
  app.post('/api/refresh', async (req, reply) => {
    const b = z.object({ job: z.enum(['nav', 'stocks', 'fx', 'ulip', 'snapshot', 'all']).default('all') }).parse(req.body ?? {});
    if (running) return reply.code(409).send({ error: 'A refresh is already running' });
    running = true;
    try { return { job: b.job, results: await runJob(b.job as JobName, { force: b.job === 'snapshot' }) }; } finally { running = false; }
  });
  app.get('/api/refresh/runs', async () => (await pool.query('select id, job, started_at, finished_at, ok, summary from refresh_run order by id desc limit 50')).rows);
  app.get('/api/providers/health', async () => providerHealth());
  app.put('/api/providers/:name/credentials', async (req) => {
    const { name } = z.object({ name: z.enum(PROVIDERS) }).parse(req.params);
    const b = z.record(z.string(), z.string().min(1)).parse(req.body);
    await saveCredentials(name, b); return { ok: true };
  });
  app.put('/api/providers/:name/enabled', async (req) => {
    const { name } = z.object({ name: z.enum(PROVIDERS) }).parse(req.params);
    const b = z.object({ enabled: z.boolean() }).parse(req.body);
    await pool.query('insert into provider_status(provider,enabled) values ($1,$2) on conflict (provider) do update set enabled=excluded.enabled', [name, b.enabled]);
    return { ok: true };
  });

  // ---- reports
  app.get('/api/reports/gains', async (req) => gainsReport(z.object({ fy: z.string().optional() }).parse(req.query).fy));
  app.get('/api/reports/income', async () => incomeReport());
  app.get('/api/reports/xirr', async () => xirrReport());
  app.get('/api/audit', async () => (await pool.query('select id, at, username, entity, entity_id, action, before, after from audit_log order by id desc limit 200')).rows);
  app.get('/api/export/transactions.csv', async (_req, reply) => {
    const rows = await listTxns({ limit: 100000 });
    const cols = ['date', 'owner', 'account', 'instrument', 'type', 'bucket', 'quantity', 'price', 'amount', 'currency', 'fx_rate', 'amount_inr', 'charges', 'notes'];
    const esc = (v: unknown) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    reply.header('content-type', 'text/csv').header('content-disposition', 'attachment; filename="transactions.csv"');
    return [cols.join(','), ...rows.map((r: any) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  });

  // ---- built frontend (if present)
  if (fs.existsSync(config.frontendDir)) {
    await app.register(fstatic, { root: config.frontendDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html')));
  }
  return app;
}
