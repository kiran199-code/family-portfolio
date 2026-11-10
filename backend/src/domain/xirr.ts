export interface Flow { date: string; amount: number }

const yearsFrom = (d0: string, d: string) => (Date.parse(d + 'T00:00:00Z') - Date.parse(d0 + 'T00:00:00Z')) / (365 * 86400000);

/** Annualised internal rate of return for dated cash flows. Returns null when it cannot be computed. */
export function xirr(flows: Flow[]): number | null {
  const fs = flows.filter((f) => Number.isFinite(f.amount) && f.amount !== 0);
  if (fs.length < 2 || !fs.some((f) => f.amount < 0) || !fs.some((f) => f.amount > 0)) return null;
  const d0 = fs.reduce((m, f) => (f.date < m ? f.date : m), fs[0].date);
  const npv = (r: number) => fs.reduce((s, f) => s + f.amount / Math.pow(1 + r, yearsFrom(d0, f.date)), 0);
  let lo = -0.9999, hi = 10;
  let fl = npv(lo), fh = npv(hi);
  if (!Number.isFinite(fl) || !Number.isFinite(fh) || fl * fh > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-7) return mid;
    if (fl * fm < 0) { hi = mid; fh = fm; } else { lo = mid; fl = fm; }
  }
  return (lo + hi) / 2;
}
