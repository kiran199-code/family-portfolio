const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
export const exact = (v: number) => (v < 0 ? '-' : '') + '₹' + inr.format(Math.abs(v));
export function money(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e7) return s + '₹' + (a / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(2) + ' L';
  return s + '₹' + inr.format(a);
}
export const signed = (v: number) => (v < 0 ? '-' : '+') + money(Math.abs(v));
export const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? 'n/a' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%');
export const cls = (v: number | null | undefined) => (v == null ? '' : v >= 0 ? 'pos' : 'neg');
export const num = (v: number, d = 4) => v.toLocaleString('en-IN', { maximumFractionDigits: d });
/** '2026-11-09' -> '9 Nov' */
export function shortDate(d: string | null | undefined): string {
  if (!d) return 'undated';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d); if (!m) return d;
  return `${Number(m[3])} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]}`;
}
