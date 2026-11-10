import { ReactNode, useEffect, useState } from 'react';
import { shortDate } from '../format';
import type { Row } from '../types';

export function Chip({ children, tone, title }: { children: ReactNode; tone?: 'warn' | 'good' | 'bad'; title?: string }) {
  return <span className={'chip' + (tone ? ' ' + tone : '')} title={title}>{children}</span>;
}

/** Shows where a live value came from, how old it is, and whether it needs checking. Nothing is hidden. */
export function PriceBadges({ r }: { r: Row }) {
  const tip = [r.source && `Source: ${r.source}`, r.priceDate && `As of: ${r.priceDate}`, r.kind && `Type: ${r.kind}`, r.note].filter(Boolean).join('\n');
  return (
    <>
      <Chip title={tip}>{r.kind === 'seed' ? 'seed value' : r.kind ?? 'no price'} · {shortDate(r.priceDate)}</Chip>
      {r.kind === 'seed' && <Chip tone="warn" title="Imported from the prototype. Replaced by a live value on the next successful refresh.">not live yet</Chip>}
      {r.overridden && <Chip tone="warn" title="You entered this value by hand">manual</Chip>}
      {r.verify && r.kind !== 'seed' && !r.overridden && <Chip tone="warn" title={r.note ?? 'Single source or unconfirmed. Verify.'}>verify</Chip>}
      {(r.stale || (r.ageDays != null && r.ageDays > 5 && r.assetClass !== 'PF')) && <Chip tone="bad" title={`Value is ${r.ageDays} days old`}>stale</Chip>}
      {r.assetClass.startsWith('EQUITY_IN') && !r.symbolVerified && <Chip tone="warn" title="Ticker symbol not verified. Check it in Admin before trusting live prices.">symbol?</Chip>}
    </>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f); }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sec-head"><h2>{title}</h2><button className="btn ghost" onClick={onClose}>Close</button></div>
        {children}
      </div>
    </div>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true; setLoading(true);
    fn().then((d) => live && (setData(d), setError(null))).catch((e) => live && setError(e.message ?? String(e))).finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}
