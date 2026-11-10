export type QuoteKind = 'close' | 'intraday' | 'delayed' | 'nav' | 'reference';

export interface Quote {
  key: string;              // provider-specific key the caller asked for
  price: number;
  prevClose: number | null;
  asOf: string;             // ISO timestamp as reported (or fetch time when the provider gives none)
  asOfDate: string;         // YYYY-MM-DD in the market's local date
  kind: QuoteKind;
  source: string;
  note?: string;
}

export class ProviderError extends Error {
  constructor(message: string, public provider: string, public status?: number) { super(message); }
}

/** Fetch JSON/text with timeout and polite back-off on 429/5xx. */
export async function http(url: string, opts: { headers?: Record<string, string>; method?: string; body?: string; retries?: number; timeoutMs?: number; provider: string }): Promise<string> {
  const retries = opts.retries ?? 2;
  let last: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { method: opts.method ?? 'GET', headers: { 'User-Agent': 'family-portfolio/0.1 (personal use)', ...opts.headers }, body: opts.body, signal: AbortSignal.timeout(opts.timeoutMs ?? 30000) });
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        last = new ProviderError(`HTTP ${res.status}`, opts.provider, res.status);
        if (i < retries) { await new Promise((r) => setTimeout(r, (Number.isFinite(ra) && ra > 0 ? ra : 2 ** i) * 1000)); continue; }
        throw last;
      }
      if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`, opts.provider, res.status);
      return await res.text();
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      last = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 2 ** i * 1000));
    }
  }
  throw new ProviderError(`network error: ${String((last as any)?.cause?.code ?? (last as any)?.message ?? last)}`, opts.provider);
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** '09-Nov-2026' -> '2026-11-09'; '09-11-2026' -> '2026-11-09'; ISO passes through. Returns null if unrecognised. */
export function toIsoDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return null;
}
