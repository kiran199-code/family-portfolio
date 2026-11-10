import { http, toIsoDate } from './types.js';

// No verified API for ULIP fund NAVs exists (see docs/providers.md). This adapter can read a public fund page
// when you give a regular expression with two capture groups (NAV, date) in instrument.meta.navRegex.
// It is OFF unless an instrument has both meta.link and meta.navRegex, and every value it returns is flagged "verify".
export function extractUlipNav(html: string, navRegex: string): { nav: number; date: string } | null {
  const m = new RegExp(navRegex, 'i').exec(html);
  if (!m) return null;
  const nav = parseFloat(m[1].replace(/,/g, ''));
  const date = toIsoDate(m[2]) ?? null;
  if (!Number.isFinite(nav) || !date) return null;
  return { nav, date };
}

export async function fetchUlipNav(link: string, navRegex: string) {
  return extractUlipNav(await http(link, { provider: 'ulip-page', retries: 1 }), navRegex);
}
