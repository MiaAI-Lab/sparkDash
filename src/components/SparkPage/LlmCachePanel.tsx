import type { LlmCacheMetrics, LlmMetrics, LlmCachePool } from "../../api/types";

/**
 * TensorFold's shared cache, as the engine reports it (`/health.live.cache`).
 *
 * The four pool categories are disjoint allocator spans that sum to the capacity, and the
 * prompt-state store is a separate byte budget — so they are drawn as they are reported, never
 * derived from `kv_cache_usage_ratio`, which is one stream's share of its own window. When the
 * engine reports no group (an older build) or its accounting does not add up, nothing is filled in:
 * an absent measurement is not a healthy zero.
 */

const positions = (n: number): string => {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
};

const gib = (bytes: number | null | undefined): string =>
  bytes == null || !Number.isFinite(bytes) ? "—" : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

const share = (n: number, total: number): string =>
  total > 0 ? `${Math.round((n / total) * 1000) / 10}%` : "—";

const count = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString();

/** Segment order and colours: active reservations, kept prefixes, reclaimable growth, unclaimed. */
const SEGMENTS = [
  { key: "activeReservedPositions", label: "Active", cls: "sp-cache-seg--active" },
  { key: "retainedPrefixPositions", label: "Kept prefixes", cls: "sp-cache-seg--prefix" },
  { key: "retainedGrowthPositions", label: "Reclaimable growth", cls: "sp-cache-seg--growth" },
  { key: "unclaimedPositions", label: "Unclaimed", cls: "sp-cache-seg--free" },
] as const satisfies ReadonlyArray<{ key: keyof LlmCachePool; label: string; cls: string }>;

function PoolBar({ pool }: { pool: LlmCachePool }) {
  const capacity = pool.capacityPositions;
  const summary = SEGMENTS.map(
    (s) => `${s.label} ${positions(pool[s.key] as number)} of ${positions(capacity)}`
  ).join(", ");
  return (
    <>
      <div
        className="sp-cache-bar"
        role="img"
        aria-label={`Shared pool in positions: ${summary}`}
        data-cache-pool
      >
        {SEGMENTS.map((s) => {
          const value = pool[s.key] as number;
          return (
            <span
              key={s.key}
              className={`sp-cache-seg ${s.cls}`}
              style={{ width: capacity > 0 ? `${Math.min(100, (value / capacity) * 100)}%` : 0 }}
            />
          );
        })}
      </div>
      <ul className="sp-cache-legend">
        {SEGMENTS.map((s) => (
          <li key={s.key}>
            <span aria-hidden className={`sp-cache-swatch ${s.cls}`} />
            <span>{s.label}</span>
            <b className="font-tabular">{positions(pool[s.key] as number)}</b>
            <small>{share(pool[s.key] as number, capacity)}</small>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The line the panel shows instead of numbers when the engine has none to give. */
function unavailableText(cache: LlmCacheMetrics): string {
  switch (cache.status) {
    case "unavailable":
      return "This engine build reports no cache telemetry. Pool and snapshot figures stay unavailable; the per-stream KV ratio is not used as a substitute.";
    case "inconsistent":
      return `The engine reports inconsistent cache accounting${cache.reason ? ` (${cache.reason})` : ""}; no values are shown for this observation.`;
    case "unsupported":
      return `Cache telemetry schema ${cache.schemaVersion ?? "unknown"} is newer than this dashboard reads; no values are shown.`;
    default:
      return "The cache group could not be read this poll.";
  }
}

export function LlmCachePanel({ llm }: { llm: LlmMetrics }) {
  const cache = llm.cache ?? null;
  if (!cache) return null;

  if (cache.status === "unavailable" || cache.status === "inconsistent" || cache.status === "unsupported" || cache.status === "invalid") {
    return (
      <section className="sp-cache" aria-label="Shared cache pool" data-cache-status={cache.status}>
        <div className="sp-cache-head">
          <span className="eyebrow">Shared cache pool</span>
          <span className="sp-cache-badge">Unavailable</span>
        </div>
        <p className="sp-cache-note">{unavailableText(cache)}</p>
      </section>
    );
  }

  const pool = cache.pool ?? null;
  const store = cache.promptState ?? null;
  const capacity = pool?.capacityPositions ?? null;
  const active = pool?.activeReservedPositions ?? null;
  const reused =
    llm.totalCachedTokens != null && llm.totalPromptTokens != null && llm.totalPromptTokens > 0
      ? llm.totalCachedTokens / llm.totalPromptTokens
      : null;
  const failures = store?.failuresTotal ?? null;
  const stages = [
    store?.failuresKeepTotal != null ? `keep ${count(store.failuresKeepTotal)}` : null,
    store?.failuresRestoreTotal != null ? `restore ${count(store.failuresRestoreTotal)}` : null,
    store?.failuresPeerForgetTotal != null ? `peer forget ${count(store.failuresPeerForgetTotal)}` : null,
  ].filter(Boolean);

  return (
    <section className="sp-cache" aria-label="Shared cache pool" data-cache-status={cache.status}>
      <div className="sp-cache-head">
        <span className="eyebrow">Shared cache pool</span>
        <span className="sp-cache-headline font-tabular">
          {active != null && capacity != null ? `${share(active, capacity)} active` : "partial report"}
        </span>
      </div>

      {pool ? (
        <>
          <PoolBar pool={pool} />
          <div className="sp-tiles sp-cache-tiles">
            <div className="sp-tile">
              <b>{positions(capacity ?? 0)}</b>
              <span className="sp-tile__label">Pool positions</span>
            </div>
            <div className="sp-tile">
              <b>{cache.contextLimitPositions != null ? positions(cache.contextLimitPositions) : "—"}</b>
              <span className="sp-tile__label">Per request</span>
            </div>
            <div className="sp-tile">
              <b>{cache.streamCapacity != null ? String(cache.streamCapacity) : "—"}</b>
              <span className="sp-tile__label">Streams</span>
            </div>
            <div className="sp-tile">
              <b>{reused != null ? `${Math.round(reused * 100)}%` : "—"}</b>
              <span className="sp-tile__label" title="Prompt tokens restored from the prefix cache over all prompt tokens, since the engine started. The recent window is in the history charts.">
                Reused (lifetime)
              </span>
            </div>
          </div>
        </>
      ) : (
        <p className="sp-cache-note">
          The engine did not report the shared pool in this observation{cache.missing?.length ? ` (missing: ${cache.missing.join(", ")})` : ""}.
        </p>
      )}

      <details className="sp-cache-details">
        <summary>Cache detail</summary>
        <dl className="sp-cache-grid">
          <dt>Snapshot store</dt>
          <dd>
            {store ? (
              store.enabled ? (
                <>
                  {gib(store.heldBytes)} / {gib(store.budgetBytes)} charged · {gib(store.spareBytes)} spare ·{" "}
                  {count(store.entries)} states
                </>
              ) : (
                "disabled in this launch"
              )
            ) : (
              "not reported"
            )}
          </dd>
          <dt>Valid kept states</dt>
          <dd>{count(pool?.validStates ?? null)}</dd>
          <dt>Pool invalidated</dt>
          <dd title="Kept prefixes whose rows a later placement reused, since the engine started. A later resume of such a prefix must reprocess it; this is not a failed request.">
            {count(pool?.invalidationsTotal ?? null)} prefixes
          </dd>
          <dt>Placements refused</dt>
          <dd title="Reservations that could not be placed for lack of room — distinct from invalidating a kept prefix.">
            {count(pool?.placementBlocksTotal ?? null)}
          </dd>
          <dt>Snapshot churn</dt>
          <dd>
            {count(store?.evictionsTotal ?? null)} evicted · {count(store?.refusalsTotal ?? null)} refused (too large)
          </dd>
          <dt>Snapshot lookups</dt>
          <dd>
            {count(store?.hitsTotal ?? null)} hits · {count(store?.missesTotal ?? null)} misses
          </dd>
          <dt>Snapshot failures</dt>
          <dd title="Keep/restore/peer-forget stages partition the legacy total when the build classifies them.">
            {count(failures)}
            {stages.length ? ` (${stages.join(", ")})` : null}
          </dd>
          <dt>Engine epoch</dt>
          <dd className="font-tabular" title="Process identity of the engine that produced this observation; a change resets the counters.">
            {cache.engineEpoch ? cache.engineEpoch.slice(-8) : "—"}
          </dd>
        </dl>
        <p className="sp-cache-note">
          <a href="#history">Cache history</a> shows the recent reuse window, pool categories, churn and latency over time.
        </p>
      </details>
    </section>
  );
}
