import { useToolEvalCategories } from "./labels";
import { useTranslation } from "react-i18next";
import { useMemo, useState } from "react";
import { Ring } from "../../ui/Ring";
import { Tag } from "../../ui/Tag";
import { GenericValue } from "./GenericResult";
import { fmtDuration, fmtNum, scoreTier, toneColor } from "./format";
import { CATEGORY_NAMES, type NormScenario, type NormToolResult, type ScenarioStatus } from "./normalize";
import { JsonDisclosure } from "./parts";
import { useToolEvalPresentation } from "./presentation";

const STATUS_TONE: Record<ScenarioStatus, "good" | "warn" | "bad" | "neutral"> = { pass: "good", partial: "warn", fail: "bad", other: "neutral" };
const STATUS_RANK: Record<ScenarioStatus, number> = { fail: 0, partial: 1, other: 2, pass: 3 };
const SHOWN_KEYS = new Set(["scenario_id", "id", "title", "category", "status", "points", "max_points", "duration_seconds", "reasoning"]);

type SortKey = "order" | "worst" | "id" | "points" | "duration";

export function Stars({ n, max = 5 }: { n: number; max?: number }) {
  const { t } = useTranslation("tooleval");
  return (
    <span className="te-stars" role="img" aria-label={t("result.stars", { n, max })}>
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
  const { t } = useTranslation("tooleval");
  const presentation = useToolEvalPresentation();
  const tier = scoreTier(data.score, presentation);
  const ratingStars = (data.rating?.match(/★/g) ?? []).length || tier?.stars || 0;
  const done = data.counts.pass + data.counts.partial + data.counts.fail + data.counts.other;
  return (
    <div className="te-toolresult">
      <section className="te-headline">
        <Ring value={data.score ?? 0} size={132} strokeWidth={11} color={toneColor(data.safety.length ? "warn" : (tier?.tone ?? "neutral"))} label={data.score != null ? fmtNum(data.score, 1) : "–"} caption={t("result.finalScore")} />
        <div className="te-headline__main">
          <div className="te-headline__rating">
            {ratingStars ? <Stars n={ratingStars} /> : null}
            <b>{data.rating?.replace(/[★☆]+/g, "").trim() || tier?.label || t("ui.unrated")}</b>
          </div>
          <p className="te-faint">
            {data.safety.length ? "The rating is capped because of safety warnings. " : ""}
            {t("ui.tiers90Excellent75Good60Adequate")}
          </p>
          <div className="te-tiles">
            <Tile label={t("ui.deployability")} value={data.deployability} suffix="/100" />
            <Tile label={t("ui.responsiveness")} value={data.responsiveness} suffix="/100" />
            <div className="te-tile">
              <span className="eyebrow">{t("ui.completion")}</span>
              <b className="big-num">
                {done}
                <small>/ {data.total ?? done} {t("ui.scenarios")}</small>
              </b>
              <span className="te-counters te-counters--tight">
                <span className="te-counter-chip is-pass"><b>{data.counts.pass}</b> {t("ui.pass")}</span>
                <span className="te-counter-chip is-partial"><b>{data.counts.partial}</b> {t("ui.partial")}</span>
                <span className="te-counter-chip is-fail"><b>{data.counts.fail}</b> {t("ui.fail")}</span>
              </span>
            </div>
          </div>
          <p className="te-faint te-meta-line">
            {data.model ? <>{t("ui.tokens.colModel")} <b className="mono">{data.model}</b> · </> : null}
            {data.backend ? <>{data.backend} · </> : null}
            {data.version ? <>tool-eval-bench {data.version} · </> : null}
            {data.runId ? <>{t("ui.run")} <span className="mono">{data.runId}</span></> : null}
          </p>
        </div>
      </section>

      {data.safety.length ? (
        <section className="te-safety" role="alert" aria-label={t("ui.safetyWarnings")}>
          <h3>{t("ui.safetyWarnings_ToolResult")}{data.safety.length})</h3>
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
            <span>{t("ui.configurationUsed")}</span>
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
  const presentation = useToolEvalPresentation();
  const tier = scoreTier(value, presentation);
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
  const { t } = useTranslation("tooleval");
  const presentation = useToolEvalPresentation();
  const categoryNames = useToolEvalCategories();
  return (
    <section className="te-section">
      <h3>{t("ui.categoryScores")}</h3>
      <ul className="te-catbars">
        {data.categories.map((c) => {
          const pct = c.percent == null ? null : Math.max(0, Math.min(100, c.percent));
          const name = c.name ?? categoryNames[c.id] ?? null;
          const tier = scoreTier(pct, presentation);
          return (
            <li key={c.id} title={c.name ? undefined : name ? t("ui.categoryNameFromTheToolSDocumentation") : undefined}>
              <span className="te-catbars__id">{c.id}</span>
              <span className="te-catbars__name">{name ?? t("ui.filters.category")}</span>
              <span className="te-catbars__track" role="img" aria-label={`${c.id}: ${pct == null ? t("ui.noScore") : `${Math.round(pct)} percent`}`}>
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
  const { t } = useTranslation("tooleval");
  const categoryNames = useToolEvalCategories();
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
      <h3>{t("ui.scenarios_ToolResult")} <span className="te-faint">({rows.length === scenarios.length ? scenarios.length : `${rows.length} of ${scenarios.length}`})</span></h3>
      <div className="te-filters">
        <input type="search" aria-label={t("ui.searchScenarios")} placeholder={t("ui.searchIdTitleReasoning")} value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label={t("ui.filterByStatus")} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="all">{t("ui.allStatuses")}</option>
          <option value="fail">{t("ui.status.failed")}</option>
          <option value="partial">{t("ui.text.partial")}</option>
          <option value="pass">{t("ui.passed")}</option>
          <option value="other">{t("ui.category.other")}</option>
        </select>
        {cats.length > 1 ? (
          <select aria-label={t("ui.filterByCategory")} value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="all">{t("ui.filters.allCategories")}</option>
            {cats.map((c) => (
              <option key={c} value={c}>
                {c}
                {categoryNames[c] ? ` · ${categoryNames[c]}` : ""}
              </option>
            ))}
          </select>
        ) : null}
        <select aria-label={t("ui.sort")} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="order">{t("ui.originalOrder")}</option>
          <option value="worst">{t("ui.worstFirst")}</option>
          <option value="id">{t("ui.byId")}</option>
          <option value="points">{t("ui.fewestPoints")}</option>
          <option value="duration">{t("ui.slowest")}</option>
        </select>
      </div>
      {rows.length === 0 ? <p className="te-empty">{t("ui.noScenarioMatchesTheseFilters")}</p> : null}
      <ul className="te-scn-rows">
        {rows.slice(0, limit).map((s) => {
          const isOpen = open.has(s.id);
          const extra = Object.fromEntries(Object.entries(s.raw).filter(([k]) => !SHOWN_KEYS.has(k)));
          return (
            <li key={s.id} className={`te-scn-row is-${STATUS_TONE[s.status]}`}>
              <button type="button" className="te-scn-row__head" aria-expanded={isOpen} onClick={() => toggle(s.id)}>
                <Tag tone={STATUS_TONE[s.status]}>{s.rawStatus ?? s.status}</Tag>
                <span className="mono te-scn-row__id">{s.id}</span>
                <span className="te-scn-row__title">{s.title ?? <span className="te-faint">{t("ui.noTitle")}</span>}</span>
                {s.category ? <span className="te-token" title={categoryNames[s.category]}>{s.category}</span> : null}
                <span className="mono te-scn-row__pts">{s.points != null ? `${fmtNum(s.points, 1)}${s.maxPoints != null ? `/${s.maxPoints}` : " pts"}` : ""}</span>
                <span className="te-faint te-scn-row__dur">{s.durationSeconds != null ? fmtDuration(s.durationSeconds) : ""}</span>
                <span className="te-scn-row__chev" aria-hidden>{isOpen ? "−" : "+"}</span>
              </button>
              {isOpen ? (
                <div className="te-scn-row__body">
                  {s.reasoning ? (
                    <div>
                      <span className="eyebrow">{t("ui.text.reasoning")}</span>
                      <pre className="te-pre">{s.reasoning}</pre>
                    </div>
                  ) : null}
                  {Object.keys(extra).length ? <GenericValue value={extra} /> : !s.reasoning ? <p className="te-faint">{t("ui.noFurtherDetailsWereRecordedForThis")}</p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {rows.length > limit ? (
        <button type="button" className="btn btn--sm" onClick={() => setLimit((l) => l + 150)}>
          {t("ui.comfy.show")} {Math.min(150, rows.length - limit)} {t("ui.more")}
        </button>
      ) : null}
    </section>
  );
}
