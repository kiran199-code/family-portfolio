import { describe, it, expect } from 'vitest';
import { replay, preview, LedgerError, LedgerTxn } from '../src/domain/ledger.js';
import { xirr } from '../src/domain/xirr.js';

let n = 0;
const t = (o: Partial<LedgerTxn> & Pick<LedgerTxn, 'type' | 'date'>): LedgerTxn => ({ id: ++n, instrumentId: 1, ...o });
const h = (txns: LedgerTxn[], inst = 1, bucket = 'AVAILABLE') => replay(txns).holdings.find((x) => x.instrumentId === inst && x.bucket === bucket);

describe('ledger engine', () => {
  it('buy creates a lot with cost incl. charges', () => {
    const r = h([t({ type: 'BUY', date: '2024-01-01', quantity: 10, amountInr: 1000, charges: 10 })])!;
    expect(r.quantity).toBe(10); expect(r.cost).toBeCloseTo(1010);
  });
  it('two buys give weighted average cost', () => {
    const r = h([t({ type: 'BUY', date: '2024-01-01', quantity: 10, amountInr: 1000 }), t({ type: 'BUY', date: '2024-02-01', quantity: 10, amountInr: 2000 })])!;
    expect(r.cost / r.quantity).toBeCloseTo(150);
  });
  it('FIFO sell consumes oldest lot and realises gain', () => {
    const res = replay([t({ type: 'BUY', date: '2024-01-01', quantity: 10, amountInr: 1000 }), t({ type: 'BUY', date: '2024-02-01', quantity: 10, amountInr: 2000 }), t({ type: 'SELL', date: '2024-06-01', quantity: 5, amountInr: 1000 })]);
    expect(res.realised).toHaveLength(1);
    expect(res.realised[0].cost).toBeCloseTo(500); expect(res.realised[0].gain).toBeCloseTo(500);
    expect(res.holdings[0].quantity).toBe(15); expect(res.holdings[0].cost).toBeCloseTo(2500);
  });
  it('sell spanning two lots splits proceeds pro rata', () => {
    const res = replay([t({ type: 'BUY', date: '2024-01-01', quantity: 10, amountInr: 1000 }), t({ type: 'BUY', date: '2024-02-01', quantity: 10, amountInr: 2000 }), t({ type: 'SELL', date: '2024-06-01', quantity: 15, amountInr: 3000 })]);
    expect(res.realised).toHaveLength(2);
    expect(res.realised[0].proceeds).toBeCloseTo(2000); expect(res.realised[1].proceeds).toBeCloseTo(1000);
    expect(res.holdings[0].quantity).toBe(5);
  });
  it('sell charges reduce proceeds', () => {
    const res = replay([t({ type: 'BUY', date: '2024-01-01', quantity: 10, amountInr: 1000 }), t({ type: 'SELL', date: '2024-02-01', quantity: 10, amountInr: 1500, charges: 20 })]);
    expect(res.realised[0].gain).toBeCloseTo(480);
  });
  it('oversell throws with the quantity held', () => {
    expect(() => replay([t({ type: 'BUY', date: '2024-01-01', quantity: 5, amountInr: 500 }), t({ type: 'SELL', date: '2024-02-01', quantity: 6, amountInr: 700 })])).toThrow(LedgerError);
  });
  it('back-dated buy is replayed in date order so the sell is valid', () => {
    const sell = t({ type: 'SELL', date: '2024-03-01', quantity: 5, amountInr: 700 });
    const buy = t({ type: 'BUY', date: '2024-01-01', quantity: 5, amountInr: 500 });
    expect(() => replay([sell, buy])).not.toThrow();
  });
  it('same-day order uses id', () => {
    expect(() => replay([t({ type: 'BUY', date: '2024-01-01', quantity: 5, amountInr: 500 }), t({ type: 'SELL', date: '2024-01-01', quantity: 5, amountInr: 600 })])).not.toThrow();
  });
  it('holding days computed', () => {
    const r = replay([t({ type: 'BUY', date: '2024-01-01', quantity: 1, amountInr: 100 }), t({ type: 'SELL', date: '2025-01-01', quantity: 1, amountInr: 150 })]).realised[0];
    expect(r.holdingDays).toBe(366);
  });
  it('opening lots are flagged so tax buckets are not guessed', () => {
    const r = replay([t({ type: 'OPENING', date: '2026-11-05', quantity: 10, amountInr: 1000 }), t({ type: 'SELL', date: '2026-11-20', quantity: 4, amountInr: 600 })]);
    expect(r.lots[0].opening).toBe(true); expect(r.realised[0].openingLot).toBe(true);
  });
  it('split 5:1 multiplies units and divides unit cost, total cost unchanged', () => {
    const r = h([t({ type: 'BUY', date: '2024-01-01', quantity: 10, amountInr: 5000 }), t({ type: 'SPLIT', date: '2024-06-01', ratioNum: 5, ratioDen: 1 })])!;
    expect(r.quantity).toBe(50); expect(r.cost).toBeCloseTo(5000);
  });
  it('reverse split 1:2 halves units', () => {
    const r = h([t({ type: 'BUY', date: '2024-01-01', quantity: 10, amountInr: 5000 }), t({ type: 'SPLIT', date: '2024-06-01', ratioNum: 1, ratioDen: 2 })])!;
    expect(r.quantity).toBe(5); expect(r.cost).toBeCloseTo(5000);
  });
  it('bonus adds units at zero cost and lowers average', () => {
    const r = h([t({ type: 'BUY', date: '2024-01-01', quantity: 10, amountInr: 1000 }), t({ type: 'BONUS', date: '2024-06-01', quantity: 10 })])!;
    expect(r.quantity).toBe(20); expect(r.cost).toBeCloseTo(1000);
  });
  it('demerger moves a share of cost to the new instrument and keeps acquisition date', () => {
    const res = replay([t({ type: 'BUY', date: '2023-01-01', quantity: 100, amountInr: 10000 }), t({ type: 'DEMERGER', date: '2026-05-01', ratioNum: 1, ratioDen: 1, costFraction: 0.25, refInstrumentId: 2 })]);
    const p = res.holdings.find((x) => x.instrumentId === 1)!, c = res.holdings.find((x) => x.instrumentId === 2)!;
    expect(p.cost).toBeCloseTo(7500); expect(c.cost).toBeCloseTo(2500); expect(c.quantity).toBe(100);
    expect(res.lots.find((l) => l.instrumentId === 2)!.acquired).toBe('2023-01-01');
  });
  it('demerger with 2 new units per old unit', () => {
    const c = h([t({ type: 'BUY', date: '2023-01-01', quantity: 10, amountInr: 1000 }), t({ type: 'DEMERGER', date: '2026-05-01', ratioNum: 2, ratioDen: 1, costFraction: 0.5, refInstrumentId: 2 })], 2)!;
    expect(c.quantity).toBe(20); expect(c.cost).toBeCloseTo(500);
  });
  it('dividend adds income without changing holdings', () => {
    const r = replay([t({ type: 'BUY', date: '2024-01-01', quantity: 10, amountInr: 1000 }), t({ type: 'DIVIDEND', date: '2024-05-01', amountInr: 50 })]);
    expect(r.holdings[0].income).toBe(50); expect(r.holdings[0].quantity).toBe(10); expect(r.income).toHaveLength(1);
  });
  it('unvested and available are separate holdings', () => {
    const r = replay([t({ type: 'OPENING', date: '2026-01-01', quantity: 10, amountInr: 1000 }), t({ type: 'OPENING', date: '2026-01-01', quantity: 4, amountInr: 400, bucket: 'UNVESTED' })]);
    expect(r.holdings).toHaveLength(2);
  });
  it('vest moves units from unvested to available keeping cost', () => {
    const r = replay([t({ type: 'OPENING', date: '2026-01-01', quantity: 4, amountInr: 400, bucket: 'UNVESTED' }), t({ type: 'VEST', date: '2026-06-01', quantity: 4 })]);
    expect(r.holdings.find((x) => x.bucket === 'UNVESTED')).toBeUndefined();
    expect(r.holdings.find((x) => x.bucket === 'AVAILABLE')!.cost).toBeCloseTo(400);
  });
  it('vest more than unvested throws', () => {
    expect(() => replay([t({ type: 'OPENING', date: '2026-01-01', quantity: 4, amountInr: 400, bucket: 'UNVESTED' }), t({ type: 'VEST', date: '2026-06-01', quantity: 5 })])).toThrow(LedgerError);
  });
  it('switch out realises, switch in opens a new lot', () => {
    const r = replay([t({ type: 'BUY', date: '2024-01-01', quantity: 100, amountInr: 1000 }), t({ type: 'SWITCH_OUT', date: '2025-01-01', quantity: 100, amountInr: 1500 }), t({ type: 'SWITCH_IN', instrumentId: 2, date: '2025-01-01', quantity: 50, amountInr: 1500 })]);
    expect(r.realised[0].gain).toBeCloseTo(500); expect(r.holdings.find((x) => x.instrumentId === 2)!.quantity).toBe(50);
  });
  it('transfer out does not realise a gain', () => {
    const r = replay([t({ type: 'BUY', date: '2024-01-01', quantity: 10, amountInr: 1000 }), t({ type: 'TRANSFER_OUT', date: '2024-02-01', quantity: 4 })]);
    expect(r.realised).toHaveLength(0); expect(r.holdings[0].quantity).toBe(6);
  });
  it('rebuilding is deterministic', () => {
    const txns = [t({ type: 'BUY', date: '2024-01-01', quantity: 10, amountInr: 1000 }), t({ type: 'SELL', date: '2024-03-01', quantity: 3, amountInr: 400 }), t({ type: 'SPLIT', date: '2024-04-01', ratioNum: 2, ratioDen: 1 })];
    expect(JSON.stringify(replay(txns))).toBe(JSON.stringify(replay([...txns].reverse())));
  });
  it('missing quantity is rejected', () => {
    expect(() => replay([t({ type: 'BUY', date: '2024-01-01', amountInr: 100 })])).toThrow(LedgerError);
  });
  it('preview reports the realised gain and the new holding', () => {
    const existing = [t({ type: 'BUY', date: '2024-01-01', quantity: 10, amountInr: 1000 })];
    const p = preview(existing, t({ type: 'SELL', date: '2024-06-01', quantity: 4, amountInr: 600 }));
    expect(p.realisedGain).toBeCloseTo(200); expect(p.after[0].quantity).toBe(6); expect(p.before[0].quantity).toBe(10);
  });
  it('preview of an oversell throws', () => {
    expect(() => preview([t({ type: 'BUY', date: '2024-01-01', quantity: 1, amountInr: 100 })], t({ type: 'SELL', date: '2024-06-01', quantity: 2, amountInr: 300 }))).toThrow(LedgerError);
  });
  it('back-dated trade that changes later realised gains is flagged in preview', () => {
    const existing = [t({ type: 'BUY', date: '2024-02-01', quantity: 10, amountInr: 2000 }), t({ type: 'SELL', date: '2024-06-01', quantity: 5, amountInr: 1000 })];
    const p = preview(existing, t({ type: 'BUY', date: '2024-01-01', quantity: 10, amountInr: 500 }));
    expect(p.laterRealisedChanged).toBe(true);
  });
});

describe('xirr', () => {
  it('10% over one year', () => {
    const r = xirr([{ date: '2024-01-01', amount: -100 }, { date: '2025-01-01', amount: 110 }])!;
    expect(r).toBeGreaterThan(0.0995); expect(r).toBeLessThan(0.1005);
  });
  it('negative return', () => {
    expect(xirr([{ date: '2024-01-01', amount: -100 }, { date: '2025-01-01', amount: 90 }])!).toBeLessThan(-0.09);
  });
  it('returns null without both signs', () => { expect(xirr([{ date: '2024-01-01', amount: -100 }])).toBeNull(); });
  it('multiple flows', () => {
    const r = xirr([{ date: '2024-01-01', amount: -100 }, { date: '2024-07-01', amount: -100 }, { date: '2025-01-01', amount: 230 }])!;
    expect(r).toBeGreaterThan(0.1); expect(r).toBeLessThan(0.3);
  });
});
