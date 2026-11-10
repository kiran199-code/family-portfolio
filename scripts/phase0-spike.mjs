// Phase 0 provider spike. Makes REAL calls and records what each provider returns.
// Run:  node scripts/phase0-spike.mjs            (writes docs/provider-report.md and docs/provider-report.json)
// Nothing here is cached or estimated: a provider that fails is reported as failed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seed = JSON.parse(fs.readFileSync(path.join(root, 'seed/prototype-data.json'), 'utf8'));
const UA = 'Mozilla/5.0 (family-portfolio-spike; personal use)';
const results = [];

async function call(name, url, opts = {}, parse = 'json') {
  const t0 = Date.now();
  const rec = { name, url, ok: false };
  try {
    const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(25000) });
    rec.status = res.status;
    rec.ms = Date.now() - t0;
    rec.rateLimitHeaders = Object.fromEntries([...res.headers].filter(([k]) => /ratelimit|retry-after|x-rate/i.test(k)));
    const text = await res.text();
    rec.bytes = text.length;
    if (res.ok) {
      rec.body = parse === 'json' ? JSON.parse(text) : text;
      rec.ok = true;
    } else {
      rec.error = text.slice(0, 160);
    }
  } catch (e) {
    rec.error = String(e.cause?.code || e.message || e);
    rec.ms = Date.now() - t0;
  }
  return rec;
}
const add = (r, summary, extra = {}) => {
  const { body, ...rest } = r;
  results.push({ ...rest, summary, ...extra });
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}  ${summary || r.error || ''}`);
};

// ---- 1. AMFI NAVAll.txt -----------------------------------------------------
const amfi = await call('AMFI NAVAll.txt', 'https://www.amfiindia.com/spages/NAVAll.txt', {}, 'text');
const amfiMap = new Map();
if (amfi.ok) {
  for (const line of amfi.body.split(/\r?\n/)) {
    const p = line.split(';');
    if (p.length >= 8 && /^\d+$/.test(p[0])) amfiMap.set(p[0], { name: p[3], nav: p[4 + 2], date: p[7].trim(), isin: p[1] });
  }
}
add(amfi, amfi.ok ? `${amfiMap.size} scheme rows parsed; bytes=${amfi.bytes}` : '');

// ---- 2. mfapi.in cross-check against AMFI -----------------------------------
const codes = [...new Set(Object.values(seed.schemeCodes))].slice(0, 6);
for (const code of codes) {
  const r = await call(`mfapi.in /mf/${code}/latest`, `https://api.mfapi.in/mf/${code}/latest`);
  const a = amfiMap.get(code);
  const d = r.ok ? r.body?.data?.[0] : null;
  add(r, r.ok ? `mfapi nav=${d?.nav} date=${d?.date}; AMFI nav=${a?.nav} date=${a?.date}` : '', {
    crossCheck: a && d ? { amfiNav: a.nav, mfapiNav: d.nav, amfiDate: a.date, mfapiDate: d.date } : null,
  });
}

// ---- 3. FX: Frankfurter v2 ---------------------------------------------------
for (const [b, q] of [['usd', 'inr'], ['sgd', 'inr']]) {
  const r = await call(`Frankfurter ${b}->${q}`, `https://api.frankfurter.dev/v2/rates?base=${b}&quotes=${q}`);
  add(r, r.ok ? JSON.stringify(r.body).slice(0, 200) : '');
}

// ---- 4. NPS: npsnav.in ---------------------------------------------------------
const nps = await call('npsnav.in /api/latest-min', 'https://npsnav.in/api/latest-min');
add(nps, nps.ok ? JSON.stringify(nps.body).slice(0, 160) : '');

// ---- 5. Yahoo chart endpoint (unofficial, personal use only) --------------------
const yahoo = ['HDFCBANK.NS', 'RELIANCE.NS', 'HDFCBANK.BO', 'D05.SI', '^NSEI', '^BSESN', '^CNXMIDCAP', '^CNXSC', 'SGDINR=X'];
for (const sym of yahoo) {
  const r = await call(`Yahoo chart ${sym}`, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`);
  let s = '';
  if (r.ok) {
    const m = r.body?.chart?.result?.[0]?.meta;
    s = m ? `price=${m.regularMarketPrice} prevClose=${m.chartPreviousClose} ccy=${m.currency} name=${m.longName || m.shortName} t=${new Date((m.regularMarketTime || 0) * 1000).toISOString()}` : 'no meta';
  }
  add(r, s);
}

// ---- 6. ULIP page (PolicyBazaar link used by the prototype) ---------------------
const ul = seed.ulips[0].funds[0];
const ulr = await call('ULIP page ' + ul[0], ul[7], {}, 'text');
let ulSummary = '';
if (ulr.ok) {
  const m = ulr.body.match(/NAV[^0-9]{0,80}([0-9]{1,4}\.[0-9]{2,4})/i);
  ulSummary = `html bytes=${ulr.bytes}; first NAV-like number=${m ? m[1] : 'none found'}`;
}
add(ulr, ulSummary);

// ---- 7. Broker APIs: need credentials, cannot be tested here ------------------------
for (const b of ['Upstox', 'Dhan', 'Fyers', 'Zerodha Kite Connect', 'Angel One SmartAPI']) {
  results.push({ name: b, ok: null, summary: 'requires account credentials; not tested in Phase 0' });
}

// ---- report -------------------------------------------------------------------
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/provider-report.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
let md = `# Provider report (Phase 0)\n\nRun at ${new Date().toISOString()} from the build environment. A provider marked FAIL here may still work from your own network; re-run \`node scripts/phase0-spike.mjs\` on your machine.\n\n| Provider call | Result | HTTP | ms | Detail |\n|---|---|---|---|---|\n`;
for (const r of results) {
  md += `| ${r.name} | ${r.ok === null ? 'NOT TESTED' : r.ok ? 'OK' : 'FAIL'} | ${r.status ?? ''} | ${r.ms ?? ''} | ${String(r.summary || r.error || '').replace(/\|/g, '/').slice(0, 220)} |\n`;
}
fs.writeFileSync(path.join(root, 'docs/provider-report.md'), md);
console.log('\nreport written to docs/provider-report.md');
