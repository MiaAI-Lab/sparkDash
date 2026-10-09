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
  return (
    <span className="te-stars" role="img" aria-label={`${n} of ${max} stars`}>
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
  const tier = scoreTier(data.score);
  const ratingStars = (data.rating?.match(/★/g) ?? []).length || tier?.stars || 0;
  const done = data.counts.pass + data.counts.partial + data.counts.fail + data.counts.other;
  return (
    <div className="te-toolresult">
      <section className="te-headline">
        <Ring value={data.score ?? 0} size={132} strokeWidth={11} color={toneColor(data.safety.length ? "warn" : (tier?.tone ?? "neutral"))} label={data.score != null ? fmtNum(data.score, 1) : "–"} caption="Final score" />
        <div className="te-headline__main">
          <div className="te-headline__rating">
            {ratingStars ? <Stars n={ratingStars} /> : null}
            <b>{data.rating?.replace(/[★☆]+/g, "").trim() || tier?.label || "Unrated"}</b>
          </div>
          <p className="te-faint">
            {data.safety.length ? "The rating is capped because of safety warnings. " : ""}
            Tiers: 90+ Excellent, 75+ Good, 60+ Adequate, 40+ Weak, below that Poor.
          </p>
          <div className="te-tiles">
            <Tile label="Deployability" value={data.deployability} suffix="/100" />
            <Tile label="Responsiveness" value={data.responsiveness} suffix="/100" />
            <div className="te-tile">
              <span className="eyebrow">Completion</span>
              <b className="big-num">
                {done}
                <small>/ {data.total ?? done} scenarios</small>
              </b>
              <span className="te-counters te-counters--tight">
                <span className="te-counter-chip is-pass"><b>{data.counts.pass}</b> pass</span>
                <span className="te-counter-chip is-partial"><b>{data.counts.partial}</b> partial</span>
                <span className="te-counter-chip is-fail"><b>{data.counts.fail}</b> fail</span>
              </span>
            </div>
          </div>
          <p className="te-faint te-meta-line">
            {data.model ? <>Model <b className="mono">{data.model}</b> · </> : null}
            {data.backend ? <>{data.backend} · </> : null}
            {data.version ? <>tool-eval-bench {data.version} · </> : null}
            {data.runId ? <>run <span className="mono">{data.runId}</span></> : null}
          </p>
        </div>
      </section>

      {data.safety.length ? (
        <section className="te-safety" role="alert" aria-label="Safety warnings">
          <h3>Safety warnings ({data.safety.length})</h3>
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
            <span>Configuration used</span>
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
  return (
    <section className="te-section">
      <h3>Category scores</h3>
      <ul className="te-catbars">
        {data.categories.map((c) => {
          const pct = c.percent == null ? null : Math.max(0, Math.min(100, c.percent));
          const name = c.name ?? CATEGORY_NAMES[c.id] ?? null;
          const tier = scoreTier(pct);
          return (
            <li key={c.id} title={c.name ? undefined : name ? "Category name from the tool's documentation" : undefined}>
              <span className="te-catbars__id">{c.id}</span>
              <span className="te-catbars__name">{name ?? "Category"}</span>
              <span className="te-catbars__track" role="img" aria-label={`${c.id}: ${pct == null ? "no score" : `${Math.round(pct)} percent`}`}>
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
      <h3>Scenarios <span className="te-faint">({rows.length === scenarios.length ? scenarios.length : `${rows.length} of ${scenarios.length}`})</span></h3>
      <div className="te-filters">
        <input type="search" aria-label="Search scenarios" placeholder="Search id, title, reasoning…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="all">All statuses</option>
          <option value="fail">Failed</option>
          <option value="partial">Partial</option>
          <option value="pass">Passed</option>
          <option value="other">Other</option>
        </select>
        {cats.length > 1 ? (
          <select aria-label="Filter by category" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="all">All categories</option>
            {cats.map((c) => (
              <option key={c} value={c}>
                {c}
                {CATEGORY_NAMES[c] ? ` · ${CATEGORY_NAMES[c]}` : ""}
              </option>
            ))}
          </select>
        ) : null}
        <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="order">Original order</option>
          <option value="worst">Worst first</option>
          <option value="id">By id</option>
          <option value="points">Fewest points</option>
          <option value="duration">Slowest</option>
        </select>
      </div>
      {rows.length === 0 ? <p className="te-empty">No scenario matches these filters.</p> : null}
      <ul className="te-scn-rows">
        {rows.slice(0, limit).map((s) => {
          const isOpen = open.has(s.id);
          const extra = Object.fromEntries(Object.entries(s.raw).filter(([k]) => !SHOWN_KEYS.has(k)));
          return (
            <li key={s.id} className={`te-scn-row is-${STATUS_TONE[s.status]}`}>
              <button type="button" className="te-scn-row__head" aria-expanded={isOpen} onClick={() => toggle(s.id)}>
                <Tag tone={STATUS_TONE[s.status]}>{s.rawStatus ?? s.status}</Tag>
                <span className="mono te-scn-row__id">{s.id}</span>
                <span className="te-scn-row__title">{s.title ?? <span className="te-faint">(no title)</span>}</span>
                {s.category ? <span className="te-token" title={CATEGORY_NAMES[s.category]}>{s.category}</span> : null}
                <span className="mono te-scn-row__pts">{s.points != null ? `${fmtNum(s.points, 1)}${s.maxPoints != null ? `/${s.maxPoints}` : " pts"}` : ""}</span>
                <span className="te-faint te-scn-row__dur">{s.durationSeconds != null ? fmtDuration(s.durationSeconds) : ""}</span>
                <span className="te-scn-row__chev" aria-hidden>{isOpen ? "−" : "+"}</span>
              </button>
              {isOpen ? (
                <div className="te-scn-row__body">
                  {s.reasoning ? (
                    <div>
                      <span className="eyebrow">Reasoning</span>
                      <pre className="te-pre">{s.reasoning}</pre>
                    </div>
                  ) : null}
                  {Object.keys(extra).length ? <GenericValue value={extra} /> : !s.reasoning ? <p className="te-faint">No further details were recorded for this scenario.</p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {rows.length > limit ? (
        <button type="button" className="btn btn--sm" onClick={() => setLimit((l) => l + 150)}>
          Show {Math.min(150, rows.length - limit)} more
        </button>
      ) : null}
    </section>
  );
}
