import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchTokenHistory } from "../../api/client";
import { fetchLlmTokenTotals } from "../../api/llmTokenClient";
import { fetchModelPrices } from "../../api/costClient";
import type { ModelPrice } from "../../api/costTypes";
import type { TokenHistory, TokenHistoryRow } from "../../api/types";
import { formatTokensCompact } from "../../shared/tokenFormat";
import { StackedBarChart, type BarBucket, type BarSeries } from "../ui/StackedBarChart";
import {
  RANGES,
  bucketLabel,
  bucketTitle,
  entriesFromTotals,
  rowsIn,
  tallyOf,
  trackedBuckets,
  windowFor,
  type Entry,
  type RangeKey,
  type Tally,
} from "../TokensPage/tokenStats";
import { blendedPerMillion, costBuckets, costOf, filterModels, fmtMoney, priceLabel } from "./costStats";
import "../../styles/tokens.css";
import "../../styles/cost.css";

const POLL_MS = 30_000;
const fmt = formatTokensCompact;
const MODEL_KEY = "sparkdash.cost.model";

interface Usage {
  history: TokenHistory;
  /** Lifetime totals per model; null when that endpoint failed (All time then falls back to retained days). */
  lifetime: Entry[] | null;
}

interface Prices {
  models: ModelPrice[];
  at: number | null;
  stale: boolean;
}

export function CostPage() {
  const [range, setRange] = useState<RangeKey>("7d");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [prices, setPrices] = useState<Prices | null>(null);
  const [pricesError, setPricesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [modelId, setModelId] = useState<string>(() => {
    try {
      return localStorage.getItem(MODEL_KEY) || "";
    } catch {
      return "";
    }
  });

  // Usage polls; prices load once (and on retry) so a slow or dead price source
  // never holds the usage view hostage.
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      Promise.all([
        fetchTokenHistory(),
        fetchLlmTokenTotals("all")
          .then((r) => r.series || [])
          .catch(() => null),
      ])
        .then(([history, lifetimeSeries]) => {
          if (cancelled) return;
          setUsage({ history, lifetime: lifetimeSeries ? entriesFromTotals(lifetimeSeries) : null });
          setError(null);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : "Could not load usage history");
        });
    };
    run();
    const id = setInterval(() => {
      if (!document.hidden) run();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tick]);

  useEffect(() => {
    let cancelled = false;
    fetchModelPrices()
      .then((res) => {
        if (cancelled) return;
        setPrices({ models: res.models ?? [], at: res.fetchedAt ?? null, stale: res.stale ?? false });
        setPricesError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setPricesError(e instanceof Error ? e.message : "Could not load the price catalog");
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const selectModel = useCallback((id: string) => {
    setModelId(id);
    try {
      localStorage.setItem(MODEL_KEY, id);
    } catch {
      /* private mode: the pick just does not survive a reload */
    }
  }, []);

  const price = useMemo(() => prices?.models.find((m) => m.id === modelId) ?? null, [prices, modelId]);

  const view = useMemo(() => {
    if (!usage || !price) return null;
    const { history, lifetime } = usage;
    const at = Date.now();
    const w = windowFor(range, history, at);
    const inRange: TokenHistoryRow[] = rowsIn(w.spec.unit === "hour" ? history.hour : history.day, w.keys);
    const useLifetime = range === "all" && lifetime != null;
    const priced: readonly Entry[] = useLifetime ? lifetime : inRange;
    // Days the average is spread over: the range length, or — All time — every
    // day tracking has recorded (the Token totals rule), not a fixed 30.
    const days =
      w.spec.count ?? (useLifetime ? trackedBuckets(w.firstKey, "day", at) ?? w.keys.length : w.keys.length);
    return {
      w,
      inRange,
      days,
      cost: costOf(priced, price),
      tally: tallyOf(priced),
      buckets: costBuckets(inRange, w.keys, price),
      useLifetime,
    };
  }, [usage, range, price]);

  const spec = RANGES.find((r) => r.key === range) ?? RANGES[1];
  const unitWord = spec.unit === "hour" ? "hour" : "day";

  const series: BarSeries[] = [
    { id: "input", label: "Input (prompt)", color: "var(--color-accent)" },
    { id: "output", label: "Output (generated)", color: "var(--color-violet)" },
  ];
  const chartBuckets: BarBucket[] = (view?.buckets ?? []).map((b) => ({
    key: b.key,
    label: bucketLabel(b.key, spec.unit),
    title: bucketTitle(b.key, spec.unit),
    values: { input: b.input, output: b.output },
  }));

  return (
    <div className="tk cp">
      <header className="page-head">
        <div>
          <h1>Cost compare</h1>
          <p className="page-head__sub">
            What your fleet&rsquo;s token usage would have cost on a hosted API, priced from the
            community price list.
          </p>
        </div>
      </header>

      {error ? (
        <div className="panel tk-note tk-note--err" role="alert">
          <span>
            {usage
              ? `Showing the last loaded data. Refresh failed: ${error}`
              : `Could not load usage history: ${error}`}
          </span>
          <button type="button" className="btn btn--sm" onClick={() => setTick((t) => t + 1)}>
            Retry
          </button>
        </div>
      ) : null}

      <section className="panel tk-card" aria-labelledby="cp-pick-title">
        <div className="tk-card__head">
          <div>
            <h2 id="cp-pick-title" className="tk-card__title">
              Priced as
            </h2>
            {price ? <PriceLine price={price} /> : <p className="tk-card__sub">Choose a hosted model to price your usage against.</p>}
          </div>
          <ModelPicker models={prices?.models ?? []} selectedId={price?.id ?? null} onSelect={selectModel} />
        </div>
      </section>

      {view && price ? (
        <>
          <CostTiles cost={view.cost} tally={view.tally} range={spec} days={view.days} />

          <section className="panel tk-card" aria-labelledby="cp-chart-title">
            <div className="tk-card__head">
              <div>
                <h2 id="cp-chart-title" className="tk-card__title">
                  Cost per {unitWord}
                </h2>
                <p className="tk-card__sub">
                  {spec.phrase} at {price.id} list prices
                  {view.useLifetime ? "; the chart shows the retained daily buckets" : ""}
                </p>
              </div>
              <div className="tk-card__tools">
                <div className="seg" role="group" aria-label="Time range">
                  {RANGES.map((r) => (
                    <button
                      key={r.key}
                      type="button"
                      className={r.key === range ? "is-on" : undefined}
                      aria-pressed={r.key === range}
                      onClick={() => setRange(r.key)}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <StackedBarChart
              buckets={chartBuckets}
              series={series}
              height={240}
              format={fmtMoney}
              unit="spent"
              empty="No token traffic in this range yet, so there is nothing to price."
              ariaLabel={`Stacked bar chart of the cost of tokens per ${unitWord} as ${price.id}`}
            />
            <ul className="legend tk-legend">
              {series.map((s) => (
                <li key={s.id} style={{ "--c": s.color } as React.CSSProperties}>
                  <span>{s.label}</span>
                  <em className="mono">{fmtMoney(s.id === "input" ? view.cost.inputCost : view.cost.outputCost)}</em>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel tk-card tk-about" aria-labelledby="cp-about-title">
            <h2 id="cp-about-title" className="tk-card__title">
              How this is priced
            </h2>
            <ul>
              <li>
                Computed prefill is charged the input rate ({fmtMoney(price.inputCostPerToken * 1_000_000)} / 1M); generated
                tokens the output rate ({fmtMoney(price.outputCostPerToken * 1_000_000)} / 1M).
              </li>
              <li>
                {price.cacheReadCostPerToken != null
                  ? `Cached prefill is charged the provider's cache-read rate (${fmtMoney(price.cacheReadCostPerToken * 1_000_000)} / 1M) — your prefix cache saves ${fmtMoney(view.cost.cacheSavings)} in ${spec.phrase}.`
                  : "The provider publishes no cache-read rate, so cached prefill is charged the full input rate."}
              </li>
              <li>
                Prices come from the community-maintained{" "}
                <a
                  href="https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json"
                  target="_blank"
                  rel="noreferrer"
                >
                  litellm catalog
                </a>
                , refreshed daily
                {prices?.at ? ` (last fetched ${new Date(prices.at).toLocaleString()})` : ""}
                {prices?.stale ? " — the refresh failed, so these may be out of date" : ""}.
              </li>
              <li>Tokens are the same counters as the Token totals page: fleet-wide, every port and model.</li>
            </ul>
          </section>
        </>
      ) : usage ? (
        pricesError ? (
          <div className="panel tk-note tk-note--err" role="status">
            <b>The price catalog could not be loaded.</b> {pricesError}
            <button type="button" className="btn btn--sm" onClick={() => setTick((t) => t + 1)}>
              Retry
            </button>
          </div>
        ) : prices && prices.models.length === 0 ? (
          <div className="panel tk-note" role="status">
            <b>No price data yet.</b> Enable MODEL_PRICES_FETCH or supply a catalog at MODEL_PRICES_JSON_PATH, then retry.
            <button type="button" className="btn btn--sm" onClick={() => setTick((t) => t + 1)}>Retry</button>
          </div>
        ) : prices ? (
          <div className="panel tk-note" role="status">Choose a hosted model to compare costs.</div>
        ) : (
          <div className="panel tk-note" role="status">
            Loading prices…
          </div>
        )
      ) : (
        <div className="panel tk-note" role="status">
          Loading…
        </div>
      )}
    </div>
  );
}

function PriceLine({ price }: { price: ModelPrice }) {
  const ctx = [price.provider, price.maxInputTokens ? `${Math.round(price.maxInputTokens / 1000).toLocaleString("en-US")}k context` : null].filter(
    Boolean
  );
  return (
    <p className="tk-card__sub">
      <span className="mono">{price.id}</span>
      {ctx.length ? ` · ${ctx.join(" · ")}` : ""} · {priceLabel(price)}
    </p>
  );
}

function CostTiles({
  cost,
  tally,
  range,
  days,
}: {
  cost: { inputCost: number; outputCost: number; cacheSavings: number; totalCost: number };
  tally: Tally;
  range: (typeof RANGES)[number];
  /** Buckets the per-day average is spread over (All time: every tracked day). */
  days: number;
}) {
  const per = range.unit === "hour" ? "hour" : "day";
  const blended = blendedPerMillion(cost.totalCost, tally.total);
  const outputShare = cost.totalCost > 0 ? cost.outputCost / cost.totalCost : 0;
  // The engine published no cached-prompt counter: the cached share is unknown, not
  // zero. Saying "0 of them cached" would read as a measured cache miss and hide that
  // every prompt token is priced at the full input rate, which overstates the bill.
  const cacheUnknown = tally.cacheReported === false;
  return (
    <section className="tk-tiles" aria-label={`Cost summary for ${range.phrase}`}>
      <Tile label="Total cost" value={fmtMoney(cost.totalCost)} sub={`for ${range.phrase}`} title={cost.totalCost.toFixed(6)} />
      <Tile
        label="Input (prompt)"
        value={fmtMoney(cost.inputCost)}
        sub={
          cacheUnknown
            ? `${fmt(tally.prompt)} prompt tokens, all priced as computed — this engine reports no cached share`
            : `${fmt(tally.prompt)} prompt tokens, ${fmt(tally.cached)} of them cached`
        }
        title={cost.inputCost.toFixed(6)}
      />
      <Tile
        label="Output (generated)"
        value={fmtMoney(cost.outputCost)}
        sub={`${fmt(tally.generated)} tokens · ${(outputShare * 100).toFixed(0)}% of the bill`}
        title={cost.outputCost.toFixed(6)}
      />
      <Tile
        label="Cache savings"
        value={cost.cacheSavings > 0 ? fmtMoney(cost.cacheSavings) : "—"}
        sub={
          cost.cacheSavings > 0
            ? "vs the full input price for cached prefill"
            : cacheUnknown
              ? "this engine does not report cached prompt tokens"
              : "no cache discount published"
        }
      />
      <Tile
        label={`Average per ${per}`}
        value={fmtMoney(cost.totalCost / Math.max(1, days))}
        unit={`/ ${per}`}
        sub={`Across ${days} ${per}${days === 1 ? "" : "s"}${range.count == null ? " tracked" : ""}`}
      />
      <Tile
        label="Blended rate"
        value={blended == null ? "—" : `$${blended.toFixed(2)}`}
        unit="/ 1M tok"
        sub={`${fmt(tally.total)} tokens priced`}
      />
    </section>
  );
}

function Tile({ label, value, unit, sub, title }: { label: string; value: string; unit?: string; sub?: string; title?: string }) {
  return (
    <div className="tk-tile" title={title}>
      <span className="eyebrow">{label}</span>
      <div className="big-num">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {sub ? <p className="tk-tile__sub">{sub}</p> : null}
    </div>
  );
}

/** Searchable dropdown over the whole catalog (thousands of chat models). */
function ModelPicker({
  models,
  selectedId,
  onSelect,
}: {
  models: ModelPrice[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selected = models.find((m) => m.id === selectedId) ?? null;
  const results = useMemo(() => filterModels(models, query), [models, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setActive(0);
  }, [open]);

  const pick = (m: ModelPrice) => {
    onSelect(m.id);
    setOpen(false);
  };

  return (
    <div className="cp-picker" ref={rootRef}>
      <button type="button" className="cp-toggle" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="cp-toggle__id">{selected ? selected.id : "Choose a hosted model…"}</span>
        {selected ? <span className="cp-toggle__price">{priceLabel(selected)}</span> : null}
      </button>
      {open ? (
        <div className="cp-pop" role="listbox" aria-label="Model price catalog">
          <div className="cp-search">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                else if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, results.length - 1));
                else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
                else if (e.key === "Enter") {
                  const m = results[active];
                  if (m) pick(m);
                  e.preventDefault();
                }
              }}
              placeholder={`Search ${models.length} models…`}
              aria-label="Search models"
            />
          </div>
          <ul className="cp-list">
            {results.map((m, i) => (
              <li key={m.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={m.id === selectedId}
                  className={`cp-item${i === active ? " is-active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(m)}
                >
                  <span className="cp-item__id">{m.id}</span>
                  <span className="cp-item__meta">{priceLabel(m)}</span>
                </button>
              </li>
            ))}
            {results.length === 0 ? <li className="cp-empty">No models match &ldquo;{query}&rdquo;.</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
