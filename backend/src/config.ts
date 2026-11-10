import crypto from 'node:crypto';

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/portfolio',
  port: Number(process.env.PORT ?? 8080),
  appSecret: process.env.APP_SECRET ?? '',
  adminUser: process.env.ADMIN_USER ?? '',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  seedFile: process.env.SEED_FILE ?? new URL('../../seed/prototype-data.json', import.meta.url).pathname,
  frontendDir: process.env.FRONTEND_DIR ?? new URL('../../frontend/dist', import.meta.url).pathname,
  enableScheduler: (process.env.ENABLE_SCHEDULER ?? 'true') === 'true',
  // Unofficial Yahoo endpoint is OFF unless you opt in. See docs/providers.md.
  enableYahoo: (process.env.ENABLE_UNOFFICIAL_YAHOO ?? 'false') === 'true',
  tz: 'Asia/Kolkata',
};

/** Fails fast on missing secrets so tokens are never encrypted with an empty key. */
export function requireSecret(): string {
  if (config.appSecret.length < 16) throw new Error('APP_SECRET must be set (16+ characters)');
  return config.appSecret;
}

const key = () => crypto.scryptSync(requireSecret(), 'family-portfolio-v1', 32);

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
