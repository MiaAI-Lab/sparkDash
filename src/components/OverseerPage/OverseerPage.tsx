import { useCallback, useEffect, useMemo, useState } from 'react';
import { authHeaders, reportAuthRequired } from '../../api/authToken';
import '../../styles/overseer.css';

type Event = { id: string; timestamp: number; sparkId: string; model: string; kind: string; stage: string; severity: string; signals: string[]; destinations: string[]; fingerprint: string | null; exitCode: number | null };
type Source = { sparkId: string; state: string; count: number | null; invalid?: number; truncated?: boolean; pending?: boolean; capacityWarning?: boolean };
type Report = { enabled: boolean; state: string; checkedAt: number | null; pollMs: number; events: Event[]; units: { id: string; name: string; models: string[] }[]; sources: Source[]; signals: Record<string, string>; summary: { actions: number; flagged: number; high: number } | null; error: string | null };
const PAGE_SIZE = 15;
const number = (value: number | undefined) => value == null ? 'Unavailable' : value.toLocaleString();

export function OverseerPage() {
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [unit, setUnit] = useState('');
  const [severity, setSeverity] = useState('');
  const [model, setModel] = useState('');
  const [page, setPage] = useState(0);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch('/api/overseer', { headers: authHeaders(), signal });
      if (response.status === 401) reportAuthRequired();
      if (!response.ok) throw Error('Unavailable');
      const report = await response.json();
      if (!Array.isArray(report.events) || !Array.isArray(report.units) || !Array.isArray(report.sources)) throw Error('Invalid response');
      setData(report); setError(''); setNow(Date.now());
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError('Observation feed unavailable. Previous records are not a current safety assessment.');
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => { setNow(Date.now()); if (!document.hidden) void load(controller.signal); }, 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [load]);
  const visible = useMemo(() => (data?.events ?? []).filter(event =>
    (!unit || event.sparkId === unit) && (!model || event.model === model) &&
    (!severity || (severity === 'flagged' ? event.signals.length > 0 : event.severity === severity)) &&
    `${event.model} ${event.kind} ${event.stage} ${event.signals.map(code => data?.signals[code] ?? code).join(' ')} ${event.destinations.join(' ')}`.toLowerCase().includes(query.toLowerCase())), [data, unit, model, severity, query]);
  useEffect(() => setPage(0), [unit, model, severity, query]);
  useEffect(() => setPage(current => Math.min(current, Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1))), [visible.length]);
  const models = [...new Set(data?.events.map(event => event.model) ?? [])].sort();
  const stale = Boolean(data?.checkedAt && now - data.checkedAt > Math.max(15000, data.pollMs * 3));
  const unitName = (id: string) => data?.units.find(entry => entry.id === id)?.name ?? id;
  return <div className="ovr-page">
    <header className="ovr-heading">
      <div><div className="ovr-eyebrow">MODEL WORKLOAD OVERSIGHT</div><h1>Spark Overseer</h1><p>Local security signals for instrumented DGX Spark workloads.</p></div>
      <button type="button" className="ovr-button" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh observations'}</button>
    </header>
    <div className="ovr-status"><span className="ovr-badge">{data?.state ?? 'Connecting'}</span><span>Observe only · no blocking</span><span>No AI reviewer · 0 model tokens</span></div>
    <section className="ovr-notice" aria-label="Protection limits"><strong>Signals, not security verdicts.</strong> Only instrumented activity is visible. A model tool proposal is not execution; process exit is not proof of a successful transfer. This is not a firewall, packet capture or authorization system. Same-user or root tampering remains possible.</section>
    {error && <div className="ovr-error" role="alert">{error}</div>}
    {data?.error && <div className="ovr-error" role="alert">{data.error}. No safety conclusion can be drawn.</div>}
    <div className="ovr-freshness" role="status">{data?.checkedAt ? `Collector checked: ${new Date(data.checkedAt).toLocaleString()}${stale ? ' · STALE' : ''}` : 'Collector has not completed an enabled source read.'}</div>
    <section className="ovr-metrics" aria-label="Observed events, bounded to 24 hours">
      <article><span>Instrumented events</span><strong>{number(data?.summary?.actions)}</strong><small>Bounded journal window · up to 2,000 retained</small></article>
      <article><span>Events with review signals</span><strong>{number(data?.summary?.flagged)}</strong><small>Heuristics, not confirmed violations</small></article>
      <article><span>High-priority signals</span><strong>{number(data?.summary?.high)}</strong><small>Credential, metadata or control-change indicators</small></article>
    </section>
    <section className="ovr-panel">
      <div className="ovr-panel-head"><div><h2>Instrumentation coverage</h2><p>Polling continues without an open dashboard. Readable journals do not prove complete workload coverage.</p></div></div>
      {!data?.enabled && <p className="ovr-empty">Disabled by default. Configure local source journals and opt in with SPARK_OVERSEER_ENABLED=1. No workloads are automatically intercepted.</p>}
      {data?.enabled && data.state === 'unconfigured' && <p className="ovr-empty">No sources configured. Add a journal for each instrumented registry unit; uninstrumented units are not monitored.</p>}
      <div className="ovr-coverage">{data?.units.map(entry => {
        const source = data.sources.find(item => item.sparkId === entry.id);
        return <article key={entry.id}><strong>{entry.name}</strong><span className="ovr-badge">{source?.state ?? 'not instrumented'}</span><p>Resident model telemetry: {entry.models.length ? entry.models.join(', ') : 'unavailable'}</p><p>Journal events in source tail: {source?.count == null ? 'unavailable' : source.count.toLocaleString()}{source?.invalid ? ` · ${source.invalid} invalid records` : ''}{source?.truncated ? ' · source tail truncated' : ''}{source?.pending ? ' · incomplete final line pending' : ''}{source?.capacityWarning ? ' · journal capacity warning' : ''}</p></article>;
      })}</div>
      {data?.sources.filter(source => !data.units.some(entry => entry.id === source.sparkId)).map(source => <p className="ovr-error" key={source.sparkId}>Source {source.sparkId}: {source.state}. Not attributed to a configured unit.</p>)}
      <p className="ovr-caption">Source paths never enter this API. Model names on events are producer labels, not verified process attribution. Up to 1,000 tail records per source are read; older records may be omitted. Journals remain on your machine.</p>
    </section>
    <section className="ovr-panel">
      <div className="ovr-panel-head"><div><h2>Security observations</h2><p>No raw commands, prompts, response text, reasoning or file payloads are stored by the supplied observers.</p></div></div>
      <div className="ovr-filters">
        <label>Unit<select aria-label="Unit" value={unit} onChange={event => setUnit(event.target.value)}><option value="">All units</option>{data?.units.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
        <label>Model label<select aria-label="Model label" value={model} onChange={event => setModel(event.target.value)}><option value="">All models</option>{models.map(name => <option key={name}>{name}</option>)}</select></label>
        <label>Show<select aria-label="Show" value={severity} onChange={event => setSeverity(event.target.value)}><option value="">All events</option><option value="flagged">Review signals</option><option value="high">High priority</option><option value="recorded">Recorded only</option></select></label>
        <label>Find an event<input aria-label="Find an event" type="search" value={query} placeholder="Destination or signal" onChange={event => setQuery(event.target.value)} /></label>
      </div>
      <p className="ovr-caption">{visible.length.toLocaleString()} matching events · last 24 hours within bounded source tails. Empty results are not proof of inactivity.</p>
      {visible.length === 0 ? <p className="ovr-empty">{loading ? 'Loading observations…' : query || unit || model || severity ? 'No records match these filters.' : 'No instrumented events in this window. Check source coverage before drawing conclusions.'}</p> : <div className="ovr-events">{visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(event => <details className={`ovr-event ${event.signals.length ? 'ovr-event--review' : ''}`} key={event.id}>
        <summary><time dateTime={new Date(event.timestamp).toISOString()}>{new Date(event.timestamp).toLocaleString()}</time><span className="ovr-event-main"><strong>{event.kind.replaceAll('-', ' ')} · {event.model}</strong><span>{unitName(event.sparkId)} · {event.stage}</span><small>{event.destinations.join(', ') || 'No destination extracted'}</small></span><span className="ovr-badge">{event.severity}</span><span className="ovr-disclosure">Details</span></summary>
        <div className="ovr-event-detail"><div><strong>Signals</strong><p>{event.signals.map(code => data?.signals[code] ?? code).join(' · ') || 'No heuristic matched. This is not a safety approval.'}</p></div><div><strong>Outcome and evidence</strong><p>{event.stage}{event.exitCode != null ? ` · exit code ${event.exitCode}` : ''}. Full-host allowlist matching happens before hostname hints are minimized. Hints are not geolocation or a complete destination record.</p><small className="ovr-mono">Event {event.id} · argument fingerprint {event.fingerprint ?? 'unavailable'}</small></div></div>
      </details>)}</div>}
      {visible.length > PAGE_SIZE && <div className="ovr-pagination"><button className="ovr-button" disabled={page === 0} onClick={() => setPage(current => current - 1)}>Previous</button><span>Page {page + 1} of {Math.ceil(visible.length / PAGE_SIZE)}</span><button className="ovr-button" disabled={(page + 1) * PAGE_SIZE >= visible.length} onClick={() => setPage(current => current + 1)}>Next</button></div>}
    </section>
  </div>;
}
