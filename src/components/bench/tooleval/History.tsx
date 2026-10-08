import { useMemo, useState } from "react";
import type { ToolEvalRun } from "../../../api/types";
import { Tag } from "../../ui/Tag";
import { compareGeneric, compareToolResults, configCaveats, normalizeForCompare, type Delta } from "./compare";
import { fmtDate, fmtDuration, fmtNum } from "./format";
import { useToolEvalResult } from "./hooks";
import { Notice, Skeleton } from "./parts";
import { CATEGORY_NAMES } from "./normalize";
import { statusLabel, statusTone } from "./status";

interface HistoryProps {
  sparkId: string;
  sparkName: string;
  runs: ToolEvalRun[] | null;
  error: string | null;
  followedId: string | null;
  viewedId: string | null;
  onReload: () => void;
  onOpen: (run: ToolEvalRun) => void;
  onRerun: (run: ToolEvalRun) => void;
  onDelete: (run: ToolEvalRun) => Promise<boolean>;
  onRefresh: (run: ToolEvalRun) => Promise<boolean>;
  onAttach: (run: ToolEvalRun) => void;
}

function headline(run: ToolEvalRun): string {
  const s = run.summary;
  if (s?.finalScore != null) return fmtNum(s.finalScore, 1);
  return "–";
}

/** Runs of this page type on this Spark, with open / re-run / delete and a two-run compare. */
export function History({ sparkId, sparkName, runs, error, followedId, viewedId, onReload, onOpen, onRerun, onDelete, onRefresh, onAttach }: HistoryProps) {
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));
  const pair = useMemo(() => {
    if (picked.length !== 2 || !runs) return null;
    const found = picked.map((id) => runs.find((r) => r.id === id)).filter((r): r is ToolEvalRun => Boolean(r));
    return found.length === 2 ? ([...found].sort((a, b) => a.startedAt - b.startedAt) as [ToolEvalRun, ToolEvalRun]) : null;
  }, [picked, runs]);

  if (error && !runs) {
    return <Notice tone="bad" title="Could not load the history" actions={<button type="button" className="btn btn--sm" onClick={onReload}>Retry</button>}>{error}</Notice>;
  }
  if (!runs) return <Skeleton lines={4} className="te-card te-card--pad" />;
  if (!runs.length) {
    return (
      <div className="te-empty te-empty--big">
        <b>No runs yet</b>
        <p>Runs of this benchmark on {sparkName} show up here with their results, so you can open, re-run and compare them.</p>
      </div>
    );
  }

  return (
    <div className="te-history">
      <p className="te-note">
        Tick two runs to compare them. Results are only comparable when model, endpoint and options match closely; differences are listed when you compare.
      </p>
      <ul className="te-runs">
        {runs.map((r) => {
          const stuck = r.status === "running" && r.id !== followedId;
          const dur = r.finishedAt ? (r.finishedAt - r.startedAt) / 1000 : null;
          return (
            <li key={r.id} className={`te-run ${viewedId === r.id ? "is-viewed" : ""}`}>
              <label className="te-run__pick" title="Select for comparison">
                <input type="checkbox" checked={picked.includes(r.id)} onChange={() => toggle(r.id)} aria-label={`Compare run from ${fmtDate(r.startedAt)}`} />
              </label>
              <div className="te-run__main">
                <div className="te-run__title">
                  <b>{r.label || fmtDate(r.startedAt)}</b>
                  <Tag tone={statusTone(r.status)}>{statusLabel(r.status, !stuck)}</Tag>
                  {r.summary?.rating ? <span className="te-faint">{r.summary.rating}</span> : null}
                </div>
                <div className="te-faint te-run__sub">
                  {r.label ? `${fmtDate(r.startedAt)} · ` : ""}
                  {r.model ?? "auto model"} · {dur != null ? fmtDuration(dur) : "in progress"}
                  {r.summary?.counts ? ` · ${r.summary.counts.pass}/${r.summary.counts.partial}/${r.summary.counts.fail} pass/partial/fail` : ""}
                  {r.summary?.safetyWarnings ? ` · ${r.summary.safetyWarnings} safety warning(s)` : ""}
                </div>
              </div>
              <div className="te-run__score" title={r.summary ? "Final score" : "No headline number"}>
                <b className="big-num">{headline(r)}</b>
              </div>
              <div className="te-run__actions">
                {confirmDel === r.id ? (
                  <>
                    <span className="te-confirm-text">Delete this run?</span>
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      disabled={busyId === r.id}
                      onClick={async () => {
                        setBusyId(r.id);
                        await onDelete(r);
                        setBusyId(null);
                        setConfirmDel(null);
                        setPicked((p) => p.filter((x) => x !== r.id));
                      }}
                    >
                      Delete
                    </button>
                    <button type="button" className="btn btn--sm" onClick={() => setConfirmDel(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn--sm" onClick={() => onOpen(r)}>Open</button>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => onRerun(r)} title="Load these options into the form">Re-run…</button>
                    {stuck ? (
                      <>
                        <button type="button" className="btn btn--sm btn--ghost" onClick={() => onAttach(r)}>Watch</button>
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          disabled={busyId === r.id}
                          onClick={async () => {
                            setBusyId(r.id);
                            await onRefresh(r);
                            setBusyId(null);
                          }}
                          title="Ask the Spark whether this run has finished"
                        >
                          {busyId === r.id ? "Checking…" : "Refresh status"}
                        </button>
                      </>
                    ) : null}
                    <button type="button" className="btn btn--sm btn--ghost" disabled={r.status === "running"} onClick={() => setConfirmDel(r.id)} title={r.status === "running" ? "Stop the run first" : "Delete"}>
                      Delete
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {picked.length === 1 ? <p className="te-faint">Select one more run to compare.</p> : null}
      {pair ? <ComparePanel sparkId={sparkId} a={pair[0]} b={pair[1]} /> : null}
    </div>
  );
}

function DeltaCell({ d, suffix = "" }: { d: Delta; suffix?: string }) {
  if (d.delta == null) return <span className="te-faint">–</span>;
  const good = d.delta === 0 ? null : d.higherIsBetter ? d.delta > 0 : d.delta < 0;
  return (
    <span className={`te-delta ${good == null ? "" : good ? "is-good" : "is-bad"}`}>
      {d.delta > 0 ? "+" : ""}
      {fmtNum(d.delta, 1)}
      {suffix}
    </span>
  );
}

const CHANGE_LABEL = { regression: "Regressed", improvement: "Improved", changed: "Changed", "only-a": "Only in earlier run", "only-b": "Only in later run" } as const;

/** Two runs side by side: deltas, categories and changed scenarios (or changed metrics for other result types). */
function ComparePanel({ sparkId, a, b }: { sparkId: string; a: ToolEvalRun; b: ToolEvalRun }) {
  const ra = useToolEvalResult(sparkId, a.id);
  const rb = useToolEvalResult(sparkId, b.id);
  const caveats = configCaveats(a, b);
  const loading = ra.loading || rb.loading;
  const error = ra.error || rb.error;
  const na = ra.result ? normalizeForCompare(ra.result) : null;
  const nb = rb.result ? normalizeForCompare(rb.result) : null;
  const tool = na && nb ? compareToolResults(na, nb) : null;
  const generic = !tool && ra.result && rb.result ? compareGeneric(ra.result, rb.result) : null;

  return (
    <section className="panel te-card te-compare" aria-label="Run comparison">
      <div className="te-card__head">
        <h2>Compare</h2>
      </div>
      <div className="te-compare__runs">
        <div><span className="eyebrow">Earlier (A)</span><b>{a.label || fmtDate(a.startedAt)}</b><span className="te-faint">{a.model ?? "auto model"}</span></div>
        <div><span className="eyebrow">Later (B)</span><b>{b.label || fmtDate(b.startedAt)}</b><span className="te-faint">{b.model ?? "auto model"}</span></div>
      </div>
      {caveats.length ? (
        <Notice tone="warn" title="These runs are not directly comparable">
          <ul className="te-list">
            {caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          Differences like these can explain a change in score on their own.
        </Notice>
      ) : (
        <p className="te-ok">Same model, endpoint and options: a fair comparison.</p>
      )}
      {loading ? <Skeleton lines={4} /> : null}
      {error ? <Notice tone="bad" title="A result could not be loaded">{error}</Notice> : null}
      {tool ? (
        <>
          <div className="te-tablewrap">
            <table className="te-table">
              <thead>
                <tr><th scope="col">Metric</th><th scope="col" className="is-num">A</th><th scope="col" className="is-num">B</th><th scope="col" className="is-num">Change</th></tr>
              </thead>
              <tbody>
                {tool.headline.map((d) => (
                  <tr key={d.label}>
                    <th scope="row">{d.label}</th>
                    <td className="is-num">{d.a != null ? fmtNum(d.a, 1) : "–"}</td>
                    <td className="is-num">{d.b != null ? fmtNum(d.b, 1) : "–"}</td>
                    <td className="is-num"><DeltaCell d={d} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {tool.categories.length ? (
            <>
              <h3>Categories</h3>
              <ul className="te-catdeltas">
                {tool.categories.map((c) => (
                  <li key={c.id}>
                    <span className="te-catbars__id">{c.id}</span>
                    <span className="te-catbars__name">{c.name ?? CATEGORY_NAMES[c.id] ?? ""}</span>
                    <span className="mono te-faint">{c.a != null ? `${Math.round(c.a)}%` : "–"} → {c.b != null ? `${Math.round(c.b)}%` : "–"}</span>
                    <DeltaCell d={c} suffix=" pts" />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <h3>
            Scenarios that changed <span className="te-faint">({tool.changes.length}; {tool.unchanged} unchanged)</span>
          </h3>
          {tool.changes.length ? (
            <ul className="te-changes">
              {tool.changes.map((c) => (
                <li key={c.id} className={`is-${c.kind}`}>
                  <Tag tone={c.kind === "regression" ? "bad" : c.kind === "improvement" ? "good" : "neutral"}>{CHANGE_LABEL[c.kind]}</Tag>
                  <span className="mono">{c.id}</span>
                  <span className="te-scn-list__title">{c.title ?? ""}</span>
                  <span className="te-faint">
                    {c.from ?? "–"} → {c.to ?? "–"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="te-empty">Every scenario ended with the same status in both runs.</p>
          )}
        </>
      ) : null}
      {generic ? (
        generic.changed.length ? (
          <div className="te-tablewrap">
            <table className="te-table">
              <thead>
                <tr><th scope="col">Metric</th><th scope="col" className="is-num">A</th><th scope="col" className="is-num">B</th><th scope="col" className="is-num">Change</th></tr>
              </thead>
              <tbody>
                {generic.changed.map((m) => (
                  <tr key={m.path}>
                    <th scope="row" className="mono">{m.path}</th>
                    <td className="is-num">{m.a != null ? fmtNum(m.a, 3) : "–"}</td>
                    <td className="is-num">{m.b != null ? fmtNum(m.b, 3) : "–"}</td>
                    <td className="is-num">{m.pct != null ? `${m.pct > 0 ? "+" : ""}${m.pct.toFixed(1)}%` : m.delta != null ? fmtNum(m.delta, 3) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="te-faint">{generic.same} numbers are identical.</p>
          </div>
        ) : (
          <p className="te-empty">No numbers differ between these runs.</p>
        )
      ) : null}
      {!loading && !error && !tool && !generic ? <p className="te-empty">Nothing to compare yet.</p> : null}
    </section>
  );
}

