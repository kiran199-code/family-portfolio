import { UserError } from '../errors.js';
import { parse } from 'csv-parse/sync';
import { pool, tx, audit } from '../db.js';
import { replay, LedgerError } from '../domain/ledger.js';
import { loadLedger, rebuildAccount } from './ledgerStore.js';
import { TxnInput, TxnInputT, insertTxn, resolveAmounts, toLedger } from './txnService.js';

/**
 * Generic CSV import. Columns (header row required):
 *   date, account, instrument, type, quantity, price, amount, charges, bucket, fx_rate, notes
 *  - date: YYYY-MM-DD    - account: "Owner/Account label" (e.g. "Personal/Mutual funds") or the numeric account id
 *  - instrument: AMFI code, ISIN, symbol or exact name
 * CAMS/KFintech PDF statements and broker-specific tradebooks are NOT parsed here; convert them to this layout first.
 */
export interface ImportRow { line: number; raw: Record<string, string>; input?: TxnInputT; error?: string; duplicate?: boolean; accountLabel?: string; instrumentName?: string }

const numOrU = (s: string | undefined) => (s == null || s.trim() === '' ? undefined : Number(s.replace(/,/g, '')));

export async function previewImport(csvText: string, filename: string) {
  const recs: Record<string, string>[] = parse(csvText, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true });
  const accounts = (await pool.query(`select a.id, a.label, o.code owner from account a join owner o on o.id=a.owner_id`)).rows;
  const insts = (await pool.query(`select id, name, symbol, isin, amfi_code from instrument where active`)).rows;
  const rows: ImportRow[] = [];

  recs.forEach((raw, idx) => {
    const line = idx + 2;
    try {
      const acc = accounts.find((a) => String(a.id) === raw.account || `${a.owner}/${a.label}`.toLowerCase() === (raw.account ?? '').toLowerCase());
      if (!acc) throw new UserError(`Unknown account "${raw.account}". Use Owner/Account label, e.g. "Personal/Mutual funds"`);
      const key = (raw.instrument ?? '').toLowerCase();
      const matches = insts.filter((i) => i.amfi_code === raw.instrument || (i.isin ?? '').toLowerCase() === key || (i.symbol ?? '').toLowerCase() === key || i.name.toLowerCase() === key);
      if (matches.length !== 1) throw new UserError(matches.length === 0 ? `Unknown instrument "${raw.instrument}" (create it first)` : `Instrument "${raw.instrument}" is ambiguous`);
      const parsed = TxnInput.parse({
        accountId: acc.id, instrumentId: matches[0].id, date: raw.date, type: (raw.type ?? '').toUpperCase(),
        bucket: raw.bucket ? raw.bucket.toUpperCase() : undefined, quantity: numOrU(raw.quantity), price: numOrU(raw.price), amount: numOrU(raw.amount),
        charges: numOrU(raw.charges), fxRate: numOrU(raw.fx_rate), notes: raw.notes || undefined,
      });
      rows.push({ line, raw, input: parsed, accountLabel: `${acc.owner}/${acc.label}`, instrumentName: matches[0].name });
    } catch (e: any) {
      rows.push({ line, raw, error: e?.issues ? e.issues.map((x: any) => `${x.path.join('.')}: ${x.message}`).join('; ') : String(e.message) });
    }
  });

  // Duplicate detection against the existing ledger.
  for (const r of rows) {
    if (!r.input) continue;
    const d = await pool.query(
      `select 1 from txn where deleted_at is null and account_id=$1 and instrument_id=$2 and trade_date=$3 and type=$4 and coalesce(quantity,0)=$5 limit 1`,
      [r.input.accountId, r.input.instrumentId, r.input.date, r.input.type, r.input.quantity ?? 0]);
    if (d.rowCount) r.duplicate = true;
  }

  // Validate the combined ledger per account (catches oversells) and compute before/after holdings.
  const byAcc = new Map<number, ImportRow[]>();
  for (const r of rows) if (r.input && !r.duplicate) (byAcc.get(r.input.accountId) ?? byAcc.set(r.input.accountId, []).get(r.input.accountId)!).push(r);
  const changes: any[] = [];
  for (const [accountId, rs] of byAcc) {
    const existing = await loadLedger(pool, accountId);
    let nextId = -1000;
    try {
      const added = [];
      const lineOf = new Map<number, number>();
      for (const r of rs) { const { amountInr } = await resolveAmounts(pool, r.input!); lineOf.set(nextId, r.line); added.push(toLedger(nextId--, r.input!, amountInr)); }
      try { replay([...existing, ...added]); } catch (e) {
        if (e instanceof LedgerError && e.txnId != null && lineOf.has(e.txnId)) {
          const bad = lineOf.get(e.txnId)!;
          for (const r of rs) r.error = r.line === bad ? `Ledger would become invalid: ${e.message}` : `Blocked: line ${bad} of this account is invalid`;
          continue;
        }
        throw e;
      }
      const before = replay(existing), after = replay([...existing, ...added]);
      const names = new Map(rs.map((r) => [r.input!.instrumentId, r.instrumentName]));
      for (const [iid, name] of names) {
        const b = before.holdings.filter((h) => h.instrumentId === iid), a = after.holdings.filter((h) => h.instrumentId === iid);
        changes.push({ accountId, instrument: name, beforeQty: b.reduce((s, h) => s + h.quantity, 0), afterQty: a.reduce((s, h) => s + h.quantity, 0), beforeCost: b.reduce((s, h) => s + h.cost, 0), afterCost: a.reduce((s, h) => s + h.cost, 0) });
      }
    } catch (e: any) {
      for (const r of rs) r.error = e instanceof LedgerError ? `Ledger would become invalid: ${e.message}` : String(e.message);
    }
  }
  const batchId = (await pool.query(`insert into import_batch(filename,kind,rows) values ($1,'csv',$2) returning id`, [filename, JSON.stringify(rows)])).rows[0].id;
  return { batchId, total: rows.length, ok: rows.filter((r) => r.input && !r.error && !r.duplicate).length, duplicates: rows.filter((r) => r.duplicate).length, errors: rows.filter((r) => r.error).length, rows, changes };
}

export async function commitImport(batchId: number, user: string | null, opts: { includeDuplicates?: boolean } = {}) {
  return tx(async (c) => {
    const b = (await c.query('select * from import_batch where id=$1 for update', [batchId])).rows[0];
    if (!b) throw new UserError('Import batch not found');
    if (b.status === 'committed') throw new UserError('This import was already committed');
    const rows: ImportRow[] = b.rows;
    if (rows.some((r) => r.error)) throw new UserError('Fix or remove the rows with errors before committing');
    const good = rows.filter((r) => r.input && (opts.includeDuplicates || !r.duplicate));
    const accs = new Set<number>();
    for (const r of good) { await insertTxn(c, r.input!, user, 'csv-import', batchId); accs.add(r.input!.accountId); }
    for (const a of accs) await rebuildAccount(c, a);
    await c.query(`update import_batch set status='committed' where id=$1`, [batchId]);
    await audit(c, user, 'import_batch', batchId, 'commit', null, { rows: good.length });
    return { inserted: good.length, skippedDuplicates: rows.filter((r) => r.duplicate).length - (opts.includeDuplicates ? rows.filter((r) => r.duplicate).length : 0) };
  });
}

/** Compare ledger units with a statement: rows [{instrument, units}] for one owner. Returns differences only. */
export async function reconcile(owner: string, statement: { instrument: string; units: number }[]) {
  const led = (await pool.query(
    `select i.id, i.name, i.amfi_code, i.isin, i.symbol, sum(h.quantity) q from holding h join account a on a.id=h.account_id join owner o on o.id=a.owner_id join instrument i on i.id=h.instrument_id where o.code=$1 group by i.id, i.name, i.amfi_code, i.isin, i.symbol`, [owner])).rows;
  const seen = new Set<number>();
  const diffs: any[] = [];
  for (const s of statement) {
    const k = s.instrument.toLowerCase();
    const m = led.find((l) => l.amfi_code === s.instrument || (l.isin ?? '').toLowerCase() === k || (l.symbol ?? '').toLowerCase() === k || l.name.toLowerCase() === k);
    if (!m) { diffs.push({ instrument: s.instrument, statementUnits: s.units, ledgerUnits: 0, difference: s.units, note: 'not in the ledger' }); continue; }
    seen.add(m.id);
    if (Math.abs(m.q - s.units) > 0.001) diffs.push({ instrument: m.name, statementUnits: s.units, ledgerUnits: m.q, difference: s.units - m.q });
  }
  for (const l of led) if (!seen.has(l.id)) diffs.push({ instrument: l.name, statementUnits: null, ledgerUnits: l.q, difference: null, note: 'in the ledger, missing from the statement' });
  return { checked: statement.length, differences: diffs };
}
