export interface Row {
  key: string; accountId: number; accountLabel: string; instrumentId: number | null; assetClass: string; name: string; shortName: string; plan: string | null;
  symbol: string | null; symbolVerified: boolean; currency: string; bucket: string; qty: number; cost: number; income: number;
  price: number | null; prevPrice: number | null; priceDate: string | null; kind: string | null; source: string | null; verify: boolean; stale: boolean; ageDays: number | null; note: string | null; overridden: boolean;
  value: number | null; day: number | null; pvBase: number | null; retPct: number | null; dayPct: number | null; link?: string; undated?: boolean; balanceId?: number; meta?: any;
}
export interface Part { key: string; label: string; value: number; cost: number; day: number; pv: number; n: number; m: number; rows: Row[]; policies?: { accountId: number; policy: string; cost: number; value: number; funds: Row[] }[] }
export interface Portfolio { code: string; label: string; value: number; cost: number; gain: number; gainPct: number; day: number; pv: number; n: number; m: number; parts: Part[] }
export interface Dashboard {
  generatedAt: string; today: string; asOf: { latestPriceDate: string | null; oldestPriceDate: string | null; prototype: any };
  totals: { value: number; cost: number; day: number; pv: number; n: number; m: number; gain: number; gainPct: number; dayPct: number };
  portfolios: Portfolio[]; indices: any[]; warnings: string[];
  exposure: { top: any[]; count: number; directTotal: number; mfTotal: number; mfCoveredValue: number; mfCoveredPct: number; excluded: string[]; cover: any };
  allocation: { key: string; label: string; value: number }[];
}
