// Acceptance test 1: after seeding, the app's totals match the prototype's own formulas for the same prices.
import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../src/db.js';
import { migrate } from '../src/cli/migrate.js';
import { seedFromData } from '../src/services/seed.js';
import { buildDashboard } from '../src/services/dashboard.js';
import { config } from '../src/config.js';

const D = JSON.parse(fs.readFileSync(config.seedFile, 'utf8'));

// The prototype renderer's formulas, copied from its JS (value = units x nav, stocks = qty x price, etc.).
function prototypeTotals(D: any) {
  const P: Record<string, { c: number; v: number }> = {};
  const mf: Record<string, { c: number; v: number; d: number }> = {};
  for (const k of ['Personal', 'HUF', 'Sravanthi']) {
    let c = 0, v = 0, d = 0;
    for (const r of D.portfolios[k]) { c += r[4]; v += r[1] * r[2]; if (r[5]) d += r[1] * (r[2] - r[5]); }
    mf[k] = { c, v, d };
  }
  let uv = 0, uc = 0;
  for (const U of D.ulips) { uc += U.cost; for (const f of U.funds) uv += f[4]; }
  let sv = 0, sc = 0;
  for (const r of D.stocks) { sv += r[1] * r[4]; sc += r[3]; }
  const F = D.foreign, fv = F.availVal + F.unvVal, fc = F.availCost + F.unvCost;
  P.Personal = { c: mf.Personal.c + sc + uc + fc + D.pfP.value + D.nps.cost, v: mf.Personal.v + sv + uv + fv + D.pfP.value + D.nps.value };
  let hs = 0, hc = 0;
  for (const r of D.hufStocks) { const X = D.hufPx[r[0]]; hs += X ? r[1] * X[0] : r[4]; hc += r[2]; }
  P.HUF = { c: mf.HUF.c + hc + D.hufCash.value, v: mf.HUF.v + hs + D.hufCash.value };
  const S = D.foreignS;
  P.Sravanthi = { c: mf.Sravanthi.c + D.pf.value + D.bankS.value + D.bankS2.value + S.availCost + S.unvCost, v: mf.Sravanthi.v + D.pf.value + D.bankS.value + D.bankS2.value + S.availVal + S.unvVal };
  return P;
}

describe('seed reconciliation against the prototype', () => {
  let dash: any;
  beforeAll(async () => {
    await migrate();
    await seedFromData(D, true);
    dash = await buildDashboard(pool, '2026-11-10');
  });
  afterAll(async () => { await pool.end(); });

  it('per-portfolio value and cost match the prototype formulas', () => {
    const exp = prototypeTotals(D);
    const report: string[] = [];
    for (const p of dash.portfolios) {
      const e = exp[p.code];
      report.push(`${p.code}: value app=${p.value.toFixed(2)} proto=${e.v.toFixed(2)} (diff ${(p.value - e.v).toFixed(2)}); cost app=${p.cost.toFixed(2)} proto=${e.c.toFixed(2)} (diff ${(p.cost - e.c).toFixed(2)})`);
    }
    console.log(report.join('\n'));
    for (const p of dash.portfolios) {
      const e = exp[p.code];
      expect(Math.abs(p.cost - e.c)).toBeLessThan(5);
      expect(Math.abs(p.value - e.v) / e.v).toBeLessThan(0.0005); // within 0.05%: rounding in the prototype's stored values
    }
  });

  it('family total matches', () => {
    const exp = prototypeTotals(D);
    const ev = Object.values(exp).reduce((s, x) => s + x.v, 0), ec = Object.values(exp).reduce((s, x) => s + x.c, 0);
    console.log(`TOTAL value app=${dash.totals.value.toFixed(2)} proto=${ev.toFixed(2)}; cost app=${dash.totals.cost.toFixed(2)} proto=${ec.toFixed(2)}`);
    expect(Math.abs(dash.totals.value - ev) / ev).toBeLessThan(0.0005);
    expect(Math.abs(dash.totals.cost - ec)).toBeLessThan(10);
  });

  it('nothing is silently dropped: no holding is left unpriced', () => {
    expect(dash.warnings).toEqual([]);
  });

  it('PMS stocks keep their income', () => {
    const hufStocks = dash.portfolios.find((p: any) => p.code === 'HUF').parts.find((x: any) => x.key === 'pms');
    const income = hufStocks.rows.reduce((s: number, r: any) => s + r.income, 0);
    expect(income).toBeCloseTo(D.hufStocks.reduce((s: number, r: any) => s + r[5], 0), 1);
  });
});
