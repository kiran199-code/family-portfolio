import { useState } from 'react';
import { get, post, api } from '../api';
import { useAsync, Chip } from '../components/Common';
import { shortDate } from '../format';

const CRED_FIELDS: Record<string, string[]> = { upstox: ['accessToken'], dhan: ['accessToken', 'clientId'] };

export default function Admin() {
  const health = useAsync<any[]>(() => get('/api/providers/health'));
  const insts = useAsync<any[]>(() => get('/api/instruments?assetClass=EQUITY_IN'));
  const runs = useAsync<any[]>(() => get('/api/refresh/runs'));
  const audit = useAsync<any[]>(() => get('/api/audit'));
  const [msg, setMsg] = useState<string | null>(null);
  const [creds, setCreds] = useState<Record<string, Record<string, string>>>({});
  const [edit, setEdit] = useState<Record<number, string>>({});

  const saveCreds = async (p: string) => { try { await api('PUT', `/api/providers/${p}/credentials`, creds[p]); setCreds({ ...creds, [p]: {} }); setMsg(`Saved ${p} credentials (stored encrypted, never shown again).`); health.reload(); } catch (e: any) { setMsg(e.message); } };
  const toggle = async (p: string, enabled: boolean) => { await api('PUT', `/api/providers/${p}/enabled`, { enabled }); health.reload(); };
  const saveSym = async (i: any, verified: boolean) => { await api('PATCH', `/api/instruments/${i.id}`, { symbol: (edit[i.id] ?? i.symbol) || null, symbolVerified: verified }); setEdit({ ...edit, [i.id]: undefined as any }); insts.reload(); };
  const runJob = async (job: string) => { setMsg(`Running ${job}…`); try { const r = await post('/api/refresh', { job }); setMsg(`${job}: ` + r.results.map((x: any) => `${x.updated} updated${x.failed.length ? `, ${x.failed.length} failed` : ''}${x.skipped ? ` (${x.skipped})` : ''}`).join(' | ')); runs.reload(); health.reload(); } catch (e: any) { setMsg(e.message); } };

  return (
    <div className="wrap">
      {msg && <div className="card" role="status">{msg}</div>}
      <section className="card">
        <div className="sec-head"><h2>Data providers</h2><div className="hold-meta">{['nav', 'stocks', 'fx', 'ulip', 'all'].map((j) => <button key={j} className="btn small" onClick={() => runJob(j)}>Run {j}</button>)}</div></div>
        <div className="scroll2"><table><thead><tr><th>Provider</th><th>Status</th><th>Last success</th><th>Last error</th><th>Calls today</th><th /></tr></thead><tbody>
          {health.data?.map((p) => (
            <tr key={p.provider}><td><b>{p.provider}</b><div className="xnote">{p.note}</div></td>
              <td>{p.needsCredentials && !p.has_credentials ? <Chip tone="warn">needs credentials</Chip> : p.active ? <Chip tone={p.last_error ? 'bad' : 'good'}>{p.last_error ? 'failing' : 'ok'}</Chip> : <Chip>off</Chip>}</td>
              <td>{p.last_success ? new Date(p.last_success).toLocaleString() : 'never'}</td><td className="xnote">{p.last_error ?? ''}</td><td className="num">{p.calls_today}</td>
              <td>{CRED_FIELDS[p.provider] && (<div className="credbox">{CRED_FIELDS[p.provider].map((f) => <input key={f} type="password" placeholder={f} autoComplete="off" value={creds[p.provider]?.[f] ?? ''} onChange={(e) => setCreds({ ...creds, [p.provider]: { ...creds[p.provider], [f]: e.target.value } })} />)}<button className="btn small" onClick={() => saveCreds(p.provider)} disabled={!CRED_FIELDS[p.provider].every((f) => creds[p.provider]?.[f])}>Save</button></div>)}
                <button className="lnk" onClick={() => toggle(p.provider, !p.enabled)}>{p.enabled ? 'Turn off' : 'Turn on'}</button></td></tr>))}</tbody></table></div>
        <p className="xnote">Broker tokens usually expire daily. When a token has expired the stock job reports it here and keeps the last known prices; paste a new token to continue.</p>
      </section>

      <section className="card">
        <div className="sec-head"><h2>Stock symbols</h2><small>Symbols from the seed are my best guesses and are marked unverified. Check each against your broker app, then tick verified.</small></div>
        <div className="scroll2"><table><thead><tr><th>Stock</th><th>NSE symbol</th><th>Price</th><th>Verified</th><th /></tr></thead><tbody>
          {insts.data?.map((i) => (
            <tr key={i.id}><td>{i.name}</td><td><input value={edit[i.id] ?? i.symbol ?? ''} placeholder="unknown: enter symbol" onChange={(e) => setEdit({ ...edit, [i.id]: e.target.value })} /></td>
              <td className="num">{i.price ?? 'none'} <span className="xnote">{i.kind} {shortDate(i.price_date)}</span></td><td>{i.symbol_verified ? <Chip tone="good">verified</Chip> : <Chip tone="warn">unverified</Chip>}</td>
              <td><button className="btn small" onClick={() => saveSym(i, true)}>Save as verified</button></td></tr>))}</tbody></table></div>
      </section>

      <section className="card"><div className="sec-head"><h2>Recent refresh runs</h2></div>
        <div className="scroll2"><table><thead><tr><th>When</th><th>Job</th><th>Result</th><th>Details</th></tr></thead><tbody>{runs.data?.slice(0, 15).map((r) => <tr key={r.id}><td>{new Date(r.started_at).toLocaleString()}</td><td>{r.job}</td><td>{r.ok == null ? 'running' : r.ok ? 'ok' : 'had failures'}</td><td className="xnote">{(r.summary ?? []).map((s: any) => `${s.job}: ${s.updated} upd${s.skipped ? ' (' + s.skipped + ')' : ''}${s.failed?.length ? ', ' + s.failed.length + ' failed' : ''}`).join(' | ')}</td></tr>)}</tbody></table></div></section>

      <section className="card"><div className="sec-head"><h2>Audit log</h2><small>Every change to static data</small></div>
        <div className="scroll2"><table><thead><tr><th>When</th><th>User</th><th>What</th><th>Action</th></tr></thead><tbody>{audit.data?.slice(0, 50).map((a) => <tr key={a.id}><td>{new Date(a.at).toLocaleString()}</td><td>{a.username}</td><td>{a.entity} #{a.entity_id}</td><td>{a.action}</td></tr>)}</tbody></table></div></section>
    </div>
  );
}
