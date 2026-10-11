import { localizeBenchText } from "./benchText";
import { useTranslation } from "react-i18next";
import { i18next } from "../../../i18n";
import { useMemo, useState } from "react";
import { Ring } from "../../ui/Ring";
import { Tag } from "../../ui/Tag";
import { GenericValue } from "./GenericResult";
import { fmtDuration, fmtNum, scoreTier, toneColor } from "./format";
import { CATEGORY_NAMES, type NormScenario, type NormToolResult, type ScenarioStatus } from "./normalize";
import { JsonDisclosure } from "./parts";

const STATUS_TONE: Record<ScenarioStatus, "good" | "warn" | "bad" | "neutral"> = { pass: "good", partial: "warn", fail: "bad", other: "neutral" };
const STATUS_RANK: Record<ScenarioStatus, number> = { fail: 0, partial: 1, other: 2, pass: 3 };
const SHOWN_KEYS = new Set(["scenario_id", "id", "title", "category", "status", "points", "max_points", "duration_seconds", "reasoning"]);

type SortKey = "order" | "worst" | "id" | "points" | "duration";

export function Stars({ n, max = 5 }: { n: number; max?: number }) {
  useTranslation();
  return (
    <span className="te-stars" role="img" aria-label={i18next.t("bench.ui.v1OfV2Stars_86f70b", "{v1} of {v2} stars", { v1: n, v2: max })}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < n ? "is-on" : undefined} aria-hidden>
          ★
        </span>
      ))}
    </span>
  );
}

/** Headline, safety, categories and scenarios of a tool-call result. */
export function ToolResult({ data, raw }: { data: NormToolResult; raw: unknown }) {
  useTranslation();
  const tier = scoreTier(data.score);
  const ratingStars = (data.rating?.match(/★/g) ?? []).length || tier?.stars || 0;
  const done = data.counts.pass + data.counts.partial + data.counts.fail + data.counts.other;
  return (
    <div className="te-toolresult">
      <section className="te-headline">
        <Ring value={data.score ?? 0} size={132} strokeWidth={11} color={toneColor(data.safety.length ? "warn" : (tier?.tone ?? "neutral"))} label={data.score != null ? fmtNum(data.score, 1) : "–"} caption={i18next.t("bench.ui.finalScore_ddcd5e", "Final score")} />
        <div className="te-headline__main">
          <div className="te-headline__rating">
            {ratingStars ? <Stars n={ratingStars} /> : null}
            <b>{(data.rating ? localizeBenchText(data.rating.replace(/[★☆]+/g, "").trim()) : "") || tier?.label || i18next.t("bench.ui.unrated_43f4e5", "Unrated")}</b>
          </div>
          <p className="te-faint">
            {data.safety.length ? i18next.t("bench.ui.theRatingIsCappedBecauseOfSafety_c964fd", "The rating is capped because of safety warnings. ") : ""}{i18next.t("bench.ui.tiers90Excellent75Good60Adequate_c9974e", "Tiers: 90+ Excellent, 75+ Good, 60+ Adequate, 40+ Weak, below that Poor.")}</p>
          <div className="te-tiles">
            <Tile label={i18next.t("bench.ui.deployability_63067e", "Deployability")} value={data.deployability} suffix="/100" />
            <Tile label={i18next.t("bench.ui.responsiveness_81f3f7", "Responsiveness")} value={data.responsiveness} suffix="/100" />
            <div className="te-tile">
              <span className="eyebrow">{i18next.t("bench.ui.completion_2ff255", "Completion")}</span>
              <b className="big-num">
                {done}
                <small>/ {data.total ?? done} {i18next.t("bench.ui.scenarios_c254d1", "scenarios")}</small>
              </b>
              <span className="te-counters te-counters--tight">
                <span className="te-counter-chip is-pass"><b>{data.counts.pass}</b> {i18next.t("bench.ui.pass_9d4e1e", "pass")}</span>
                <span className="te-counter-chip is-partial"><b>{data.counts.partial}</b> {i18next.t("bench.ui.partial_355705", "partial")}</span>
                <span className="te-counter-chip is-fail"><b>{data.counts.fail}</b> {i18next.t("bench.ui.fail_a602e2", "fail")}</span>
              </span>
            </div>
          </div>
          <p className="te-faint te-meta-line">
            {data.model ? <>{i18next.t("bench.ui.model_68c2cc", "Model")} <b className="mono">{data.model}</b> · </> : null}
            {data.backend ? <>{data.backend} · </> : null}
            {data.version ? <>tool-eval-bench {data.version} · </> : null}
            {data.runId ? <>{i18next.t("bench.ui.run_df6ad1", "run")} <span className="mono">{data.runId}</span></> : null}
          </p>
        </div>
      </section>

      {data.safety.length ? (
        <section className="te-safety" role="alert" aria-label={i18next.t("bench.ui.safetyWarnings_b864d9", "Safety warnings")}>
          <h3>{i18next.t("bench.ui.safetyWarningCount", "Safety warnings ({count})", { count: data.safety.length })}</h3>
          <ul>
            {data.safety.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.categories.length ? <Categories data={data} /> : null}
      {data.scenarios.length ? <Scenarios scenarios={data.scenarios} /> : null}

      {Object.keys(data.config).length ? (
        <details className="te-disclosure">
          <summary>
            <span>{i18next.t("bench.ui.configurationUsed_d95308", "Configuration used")}</span>
          </summary>
          <div className="te-disclosure__body">
            <GenericValue value={data.config} />
          </div>
        </details>
      ) : null}
      <JsonDisclosure value={raw} />
    </div>
  );
}

function Tile({ label, value, suffix }: { label: string; value: number | null; suffix?: string }) {
  useTranslation();
  const tier = scoreTier(value);
  return (
    <div className="te-tile">
      <span className="eyebrow">{label}</span>
      <b className="big-num">
        {value != null ? fmtNum(value, 1) : "–"}
        {value != null && suffix ? <small>{suffix}</small> : null}
      </b>
      {tier ? <Tag tone={tier.tone}>{tier.label}</Tag> : null}
    </div>
  );
}

function Categories({ data }: { data: NormToolResult }) {
  useTranslation();
  return (
    <section className="te-section">
      <h3>{i18next.t("bench.ui.categoryScores_cf8abb", "Category scores")}</h3>
      <ul className="te-catbars">
        {data.categories.map((c) => {
          const pct = c.percent == null ? null : Math.max(0, Math.min(100, c.percent));
          const rawName = c.name ?? CATEGORY_NAMES[c.id];
          const name = rawName ? localizeBenchText(rawName) : null;
          const tier = scoreTier(pct);
          return (
            <li key={c.id} title={c.name ? undefined : name ? i18next.t("bench.ui.categoryNameFromTheToolSDocumentation_66ad53", "Category name from the tool's documentation") : undefined}>
              <span className="te-catbars__id">{c.id}</span>
              <span className="te-catbars__name">{name ?? i18next.t("bench.ui.category_a3c686", "Category")}</span>
              <span className="te-catbars__track" role="img" aria-label={`${c.id}: ${pct == null ? i18next.t("bench.ui.noScore_2aa018", "no score") : i18next.t("bench.ui.v1Percent_33bfe5", "{v1} percent", { v1: Math.round(pct) })}`}>
                <i style={pct != null ? { width: `${pct}%`, background: toneColor(tier?.tone ?? "neutral") } : undefined} />
              </span>
              <span className="te-catbars__val mono">{pct != null ? `${Math.round(pct)}%` : "–"}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Scenarios({ scenarios }: { scenarios: NormScenario[] }) {
  useTranslation();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | ScenarioStatus>("all");
  const [cat, setCat] = useState("all");
  const [sort, setSort] = useState<SortKey>("order");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(150);
  const cats = useMemo(() => [...new Set(scenarios.map((s) => s.category).filter((c): c is string => Boolean(c)))].sort(), [scenarios]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = scenarios.filter((s) => (status === "all" || s.status === status) && (cat === "all" || s.category === cat) && (!needle || `${s.id} ${s.title ?? ""} ${s.reasoning ?? ""}`.toLowerCase().includes(needle)));
    const by: Record<SortKey, ((a: NormScenario, b: NormScenario) => number) | null> = {
      order: null,
      worst: (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status],
      id: (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }),
      points: (a, b) => (a.points ?? -1) - (b.points ?? -1),
      duration: (a, b) => (b.durationSeconds ?? -1) - (a.durationSeconds ?? -1),
    };
    const fn = by[sort];
    return fn ? [...list].sort(fn) : list;
  }, [scenarios, q, status, cat, sort]);
  const toggle = (id: string) => setOpen((p) => (p.has(id) ? new Set([...p].filter((x) => x !== id)) : new Set(p).add(id)));

  return (
    <section className="te-section">
      <h3>{i18next.t("bench.ui.scenarios_2dd4a8", "Scenarios")} <span className="te-faint">({rows.length === scenarios.length ? scenarios.length : i18next.t("bench.ui.v1OfV2_58f1a5", "{v1} of {v2}", { v1: rows.length, v2: scenarios.length })})</span></h3>
      <div className="te-filters">
        <input type="search" aria-label={i18next.t("bench.ui.searchScenarios_6a5d9a", "Search scenarios")} placeholder={i18next.t("bench.ui.searchIdTitleReasoning_f08d6c", "Search id, title, reasoning…")} value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label={i18next.t("bench.ui.filterByStatus_f43653", "Filter by status")} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="all">{i18next.t("bench.ui.allStatuses_640517", "All statuses")}</option>
          <option value="fail">{i18next.t("bench.ui.failed_09fef5", "Failed")}</option>
          <option value="partial">{i18next.t("bench.ui.partial_65de2e", "Partial")}</option>
          <option value="pass">{i18next.t("bench.ui.passed_271d60", "Passed")}</option>
          <option value="other">{i18next.t("bench.ui.other_6e6a6f", "Other")}</option>
        </select>
        {cats.length > 1 ? (
          <select aria-label={i18next.t("bench.ui.filterByCategory_459a08", "Filter by category")} value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="all">{i18next.t("bench.ui.allCategories_060be0", "All categories")}</option>
            {cats.map((c) => (
              <option key={c} value={c}>
                {c}
                {CATEGORY_NAMES[c] ? ` · ${localizeBenchText(CATEGORY_NAMES[c])}` : ""}
              </option>
            ))}
          </select>
        ) : null}
        <select aria-label={i18next.t("bench.ui.sort_adc4e9", "Sort")} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="order">{i18next.t("bench.ui.originalOrder_4d0912", "Original order")}</option>
          <option value="worst">{i18next.t("bench.ui.worstFirst_1e9a39", "Worst first")}</option>
          <option value="id">{i18next.t("bench.ui.byId_b7d3db", "By id")}</option>
          <option value="points">{i18next.t("bench.ui.fewestPoints_e8e05e", "Fewest points")}</option>
          <option value="duration">{i18next.t("bench.ui.slowest_b70a21", "Slowest")}</option>
        </select>
      </div>
      {rows.length === 0 ? <p className="te-empty">{i18next.t("bench.ui.noScenarioMatchesTheseFilters_7c7272", "No scenario matches these filters.")}</p> : null}
      <ul className="te-scn-rows">
        {rows.slice(0, limit).map((s) => {
          const isOpen = open.has(s.id);
          const extra = Object.fromEntries(Object.entries(s.raw).filter(([k]) => !SHOWN_KEYS.has(k)));
          return (
            <li key={s.id} className={`te-scn-row is-${STATUS_TONE[s.status]}`}>
              <button type="button" className="te-scn-row__head" aria-expanded={isOpen} onClick={() => toggle(s.id)}>
                <Tag tone={STATUS_TONE[s.status]}>{localizeBenchText(s.status)}</Tag>
                <span className="mono te-scn-row__id">{s.id}</span>
                <span className="te-scn-row__title">{s.title ?? <span className="te-faint">{i18next.t("bench.ui.noTitle_0cf161", "(no title)")}</span>}</span>
                {s.category ? <span className="te-token" title={CATEGORY_NAMES[s.category] ? localizeBenchText(CATEGORY_NAMES[s.category]) : undefined}>{s.category}</span> : null}
                <span className="mono te-scn-row__pts">{s.points != null ? `${fmtNum(s.points, 1)}${s.maxPoints != null ? `/${s.maxPoints}` : i18next.t("bench.ui.pts_30275c", " pts")}` : ""}</span>
                <span className="te-faint te-scn-row__dur">{s.durationSeconds != null ? fmtDuration(s.durationSeconds) : ""}</span>
                <span className="te-scn-row__chev" aria-hidden>{isOpen ? "−" : "+"}</span>
              </button>
              {isOpen ? (
                <div className="te-scn-row__body">
                  {s.reasoning ? (
                    <div>
                      <span className="eyebrow">{i18next.t("bench.ui.reasoning_e272c5", "Reasoning")}</span>
                      <pre className="te-pre">{s.reasoning}</pre>
                    </div>
                  ) : null}
                  {Object.keys(extra).length ? <GenericValue value={extra} /> : !s.reasoning ? <p className="te-faint">{i18next.t("bench.ui.noFurtherDetailsWereRecordedForThis_73ed50", "No further details were recorded for this scenario.")}</p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {rows.length > limit ? (
        <button type="button" className="btn btn--sm" onClick={() => setLimit((l) => l + 150)}>{i18next.t("bench.ui.showMore", "Show {count} more", { count: Math.min(150, rows.length - limit) })}</button>
      ) : null}
    </section>
  );
}
