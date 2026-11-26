import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
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
  { key: "activeReservedPositions", cls: "sp-cache-seg--active" },
  { key: "retainedPrefixPositions", cls: "sp-cache-seg--prefix" },
  { key: "retainedGrowthPositions", cls: "sp-cache-seg--growth" },
  { key: "unclaimedPositions", cls: "sp-cache-seg--free" },
] as const satisfies ReadonlyArray<{ key: keyof LlmCachePool; cls: string }>;

function PoolBar({ pool }: { pool: LlmCachePool }) {
  const { t } = useTranslation("spark");
  const capacity = pool.capacityPositions;
  const labels = {
    activeReservedPositions: t("llmCache.active"),
    retainedPrefixPositions: t("llmCache.keptPrefixes"),
    retainedGrowthPositions: t("llmCache.reclaimableGrowth"),
    unclaimedPositions: t("llmCache.unclaimed"),
  };
  const summary = SEGMENTS.map(
    (s) => t("llmCache.segmentSummary", { label: labels[s.key], value: positions(pool[s.key]), capacity: positions(capacity) })
  ).join(", ");
  return (
    <>
      <div
        className="sp-cache-bar"
        role="img"
        aria-label={t("llmCache.poolSummary", { summary })}
        data-cache-pool
      >
        {SEGMENTS.map((s) => {
          const value = pool[s.key];
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
            <span>{labels[s.key]}</span>
            <b className="font-tabular">{positions(pool[s.key])}</b>
            <small>{share(pool[s.key], capacity)}</small>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The line the panel shows instead of numbers when the engine has none to give. */
function unavailableText(cache: LlmCacheMetrics, t: TFunction<"spark">): string {
  switch (cache.status) {
    case "unavailable":
      return t("llmCache.noTelemetry");
    case "inconsistent":
      return cache.reason
        ? t("llmCache.inconsistentReason", { reason: cache.reason })
        : t("llmCache.inconsistent");
    case "unsupported":
      return t("llmCache.unsupported", { version: cache.schemaVersion ?? t("llmCache.unknown") });
    default:
      return t("llmCache.unreadable");
  }
}

export function LlmCachePanel({ llm }: { llm: LlmMetrics }) {
  const { t } = useTranslation("spark");
  const cache = llm.cache ?? null;
  if (!cache) return null;

  if (cache.status === "unavailable" || cache.status === "inconsistent" || cache.status === "unsupported" || cache.status === "invalid") {
    return (
      <section className="sp-cache" aria-label={t("llmCache.title")} data-cache-status={cache.status}>
        <div className="sp-cache-head">
          <span className="eyebrow">{t("llmCache.title")}</span>
          <span className="sp-cache-badge">{t("llmCache.unavailable")}</span>
        </div>
        <p className="sp-cache-note">{unavailableText(cache, t)}</p>
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
    store?.failuresKeepTotal != null ? t("llmCache.keepFailures", { value: count(store.failuresKeepTotal) }) : null,
    store?.failuresRestoreTotal != null ? t("llmCache.restoreFailures", { value: count(store.failuresRestoreTotal) }) : null,
    store?.failuresPeerForgetTotal != null ? t("llmCache.forgetFailures", { value: count(store.failuresPeerForgetTotal) }) : null,
  ].filter(Boolean);

  return (
    <section className="sp-cache" aria-label={t("llmCache.title")} data-cache-status={cache.status}>
      <div className="sp-cache-head">
        <span className="eyebrow">{t("llmCache.title")}</span>
        <span className="sp-cache-headline font-tabular">
          {active != null && capacity != null ? t("llmCache.activeShare", { value: share(active, capacity) }) : t("llmCache.partial")}
        </span>
      </div>

      {pool ? (
        <>
          <PoolBar pool={pool} />
          <div className="sp-tiles sp-cache-tiles">
            <div className="sp-tile">
              <b>{positions(capacity ?? 0)}</b>
              <span className="sp-tile__label">{t("llmCache.poolPositions")}</span>
            </div>
            <div className="sp-tile">
              <b>{cache.contextLimitPositions != null ? positions(cache.contextLimitPositions) : "—"}</b>
              <span className="sp-tile__label">{t("llmCache.perRequest")}</span>
            </div>
            <div className="sp-tile">
              <b>{cache.streamCapacity != null ? String(cache.streamCapacity) : "—"}</b>
              <span className="sp-tile__label">{t("llmCache.streams")}</span>
            </div>
            <div className="sp-tile">
              <b>{reused != null ? `${Math.round(reused * 100)}%` : "—"}</b>
              <span className="sp-tile__label" title={t("llmCache.reusedHelp")}>
                {t("llmCache.reused")}
              </span>
            </div>
          </div>
        </>
      ) : (
        <p className="sp-cache-note">
          {cache.missing?.length
            ? t("llmCache.poolMissingFields", { fields: cache.missing.join(", ") })
            : t("llmCache.poolMissing")}
        </p>
      )}

      <details className="sp-cache-details">
        <summary>{t("llmCache.detail")}</summary>
        <dl className="sp-cache-grid">
          <dt>{t("llmCache.snapshotStore")}</dt>
          <dd>
            {store ? (
              store.enabled ? (
                t("llmCache.storeSummary", {
                  held: gib(store.heldBytes), budget: gib(store.budgetBytes), spare: gib(store.spareBytes), entries: count(store.entries),
                })
              ) : (
                t("llmCache.storeDisabled")
              )
            ) : (
              t("llmCache.notReported")
            )}
          </dd>
          <dt>{t("llmCache.validStates")}</dt>
          <dd>{count(pool?.validStates ?? null)}</dd>
          <dt>{t("llmCache.invalidated")}</dt>
          <dd title={t("llmCache.invalidatedHelp")}>
            {t("llmCache.invalidatedCount", { value: count(pool?.invalidationsTotal) })}
          </dd>
          <dt>{t("llmCache.placementsRefused")}</dt>
          <dd title={t("llmCache.placementsRefusedHelp")}>
            {count(pool?.placementBlocksTotal ?? null)}
          </dd>
          <dt>{t("llmCache.churn")}</dt>
          <dd>
            {t("llmCache.churnSummary", { evicted: count(store?.evictionsTotal), refused: count(store?.refusalsTotal) })}
          </dd>
          <dt>{t("llmCache.lookups")}</dt>
          <dd>
            {t("llmCache.lookupsSummary", { hits: count(store?.hitsTotal), misses: count(store?.missesTotal) })}
          </dd>
          <dt>{t("llmCache.failures")}</dt>
          <dd title={t("llmCache.failuresHelp")}>
            {count(failures)}
            {stages.length ? ` (${stages.join(", ")})` : null}
          </dd>
          <dt>{t("llmCache.epoch")}</dt>
          <dd className="font-tabular" title={t("llmCache.epochHelp")}>
            {cache.engineEpoch ? cache.engineEpoch.slice(-8) : "—"}
          </dd>
        </dl>
        <p className="sp-cache-note">
          <a href="#history">{t("llmCache.history")}</a>{" "}{t("llmCache.historyHelp")}
        </p>
      </details>
    </section>
  );
}
