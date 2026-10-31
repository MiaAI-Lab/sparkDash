import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("statistics");
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
          if (!cancelled) setError(e instanceof Error ? e.message : t("cost.usageLoadFailed"));
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
  }, [tick, t]);

  useEffect(() => {
    let cancelled = false;
    fetchModelPrices()
      .then((res) => {
        if (cancelled) return;
        setPrices({ models: res.models ?? [], at: res.fetchedAt ?? null, stale: res.stale ?? false });
        setPricesError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setPricesError(e instanceof Error ? e.message : t("cost.catalogLoadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [tick, t]);

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
    { id: "input", label: t("cost.input"), color: "var(--color-accent)" },
    { id: "output", label: t("cost.output"), color: "var(--color-violet)" },
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
          <h1>{t("cost.title")}</h1>
          <p className="page-head__sub">
            {t("cost.subtitle")}
          </p>
        </div>
      </header>

      {error ? (
        <div className="panel tk-note tk-note--err" role="alert">
          <span>
            {usage
              ? t("cost.staleError", { error })
              : t("cost.loadError", { error })}
          </span>
          <button type="button" className="btn btn--sm" onClick={() => setTick((t) => t + 1)}>
            {t("cost.retry")}
          </button>
        </div>
      ) : null}

      <section className="panel tk-card" aria-labelledby="cp-pick-title">
        <div className="tk-card__head">
          <div>
            <h2 id="cp-pick-title" className="tk-card__title">
              {t("cost.pricedAs")}
            </h2>
            {price ? <PriceLine price={price} /> : <p className="tk-card__sub">{t("cost.chooseModel")}</p>}
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
                  {t("cost.perUnit", { unit: unitWord })}
                </h2>
                <p className="tk-card__sub">
                  {t("cost.chartSummary", { range: spec.phrase, model: price.id })}
                  {view.useLifetime ? t("cost.retainedBuckets") : ""}
                </p>
              </div>
              <div className="tk-card__tools">
                <div className="seg" role="group" aria-label={t("cost.rangeAria")}>
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
              empty={t("cost.emptyChart")}
              totalLabel={t("cost.total")}
              ariaLabel={t("cost.chartAria", { unit: unitWord, model: price.id })}
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
              {t("cost.howPriced")}
            </h2>
            <ul>
              <li>
                {t("cost.computedRate", { input: fmtMoney(price.inputCostPerToken * 1_000_000), output: fmtMoney(price.outputCostPerToken * 1_000_000)})}
              </li>
              <li>
                {price.cacheReadCostPerToken != null
                  ? t("cost.cachedRate", { rate: fmtMoney(price.cacheReadCostPerToken * 1_000_000), savings: fmtMoney(view.cost.cacheSavings), range: spec.phrase })
                  : t("cost.noCachedRate")}
              </li>
              <li>
                {t("cost.catalogPrefix")} {" "}
                <a
                  href="https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("cost.catalogLink")}
                </a>
                {t("cost.catalogSuffix", { fetched: prices?.at ? new Date(prices.at).toLocaleString() : "", stale: prices?.stale ? t("cost.catalogStale") : "" })}
              </li>
              <li>{t("cost.tokenCounters")}</li>
            </ul>
          </section>
        </>
      ) : usage ? (
        pricesError ? (
          <div className="panel tk-note tk-note--err" role="status">
            <b>{t("cost.catalogError")}</b> {pricesError}
            <button type="button" className="btn btn--sm" onClick={() => setTick((t) => t + 1)}>
              {t("cost.retry")}
            </button>
          </div>
        ) : prices && prices.models.length === 0 ? (
          <div className="panel tk-note" role="status">
            <b>{t("cost.noPriceData")}</b> {t("cost.noPriceDataHelp")}
            <button type="button" className="btn btn--sm" onClick={() => setTick((t) => t + 1)}>{t("cost.retry")}</button>
          </div>
        ) : prices ? (
          <div className="panel tk-note" role="status">{t("cost.chooseModel")}</div>
        ) : (
          <div className="panel tk-note" role="status">
            {t("cost.loadingPrices")}
          </div>
        )
      ) : (
        <div className="panel tk-note" role="status">
          {t("cost.loading")}
        </div>
      )}
    </div>
  );
}

function PriceLine({ price }: { price: ModelPrice }) {
  const { t } = useTranslation("statistics");
  const ctx = [price.provider, price.maxInputTokens ? t("cost.context", { count: Math.round(price.maxInputTokens / 1000).toLocaleString("en-US") }) : null].filter(
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
  const { t } = useTranslation("statistics");
  const per = range.unit === "hour" ? "hour" : "day";
  const blended = blendedPerMillion(cost.totalCost, tally.total);
  const outputShare = cost.totalCost > 0 ? cost.outputCost / cost.totalCost : 0;
  // The engine published no cached-prompt counter: the cached share is unknown, not
  // zero. Saying "0 of them cached" would read as a measured cache miss and hide that
  // every prompt token is priced at the full input rate, which overstates the bill.
  const cacheUnknown = tally.cacheReported === false;
  return (
    <section className="tk-tiles" aria-label={t("cost.summaryAria", { range: range.phrase })}>
      <Tile label={t("cost.totalCost")} value={fmtMoney(cost.totalCost)} sub={t("cost.forRange", { range: range.phrase })} title={cost.totalCost.toFixed(6)} />
      <Tile
        label={t("cost.input")}
        value={fmtMoney(cost.inputCost)}
        sub={
          cacheUnknown
            ? t("cost.cacheUnknown", { prompt: fmt(tally.prompt) })
            : t("cost.cacheKnown", { prompt: fmt(tally.prompt), cached: fmt(tally.cached) })
        }
        title={cost.inputCost.toFixed(6)}
      />
      <Tile
        label={t("cost.output")}
        value={fmtMoney(cost.outputCost)}
        sub={t("cost.outputSub", { tokens: fmt(tally.generated), share: (outputShare * 100).toFixed(0) })}
        title={cost.outputCost.toFixed(6)}
      />
      <Tile
        label={t("cost.cacheSavings")}
        value={cost.cacheSavings > 0 ? fmtMoney(cost.cacheSavings) : "—"}
        sub={
          cost.cacheSavings > 0
            ? t("cost.cacheSavingsSub")
            : cacheUnknown
              ? t("cost.cacheUnknownShort")
              : t("cost.noCacheDiscount")
        }
      />
      <Tile
        label={t("cost.average", { unit: per })}
        value={fmtMoney(cost.totalCost / Math.max(1, days))}
        unit={t("cost.perUnitSuffix", { unit: per })}
        sub={t("cost.averageSub", { days, unit: per, tracked: range.count == null ? t("cost.tracked") : "" })}
      />
      <Tile
        label={t("cost.blendedRate")}
        value={blended == null ? "—" : `$${blended.toFixed(2)}`}
        unit={t("cost.perMillionTokens")}
        sub={t("cost.tokensPriced", { tokens: fmt(tally.total) })}
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
  const { t } = useTranslation("statistics");
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
        <span className="cp-toggle__id">{selected ? selected.id : t("cost.chooseModelEllipsis")}</span>
        {selected ? <span className="cp-toggle__price">{priceLabel(selected)}</span> : null}
      </button>
      {open ? (
        <div className="cp-pop" role="listbox" aria-label={t("cost.catalogAria")}>
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
              placeholder={t("cost.searchPlaceholder", { count: models.length })}
              aria-label={t("cost.searchAria")}
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
            {results.length === 0 ? <li className="cp-empty">{t("cost.noModels", { query })}</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
