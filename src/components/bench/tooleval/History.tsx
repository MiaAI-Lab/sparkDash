import { localizedServerText } from "../../../i18n/messages";
import { localizeBenchText } from "./benchText";
import { useTranslation } from "react-i18next";
import { i18next } from "../../../i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolEvalRun } from "../../../api/types";
import { Tag } from "../../ui/Tag";
import { compareGeneric, configCaveats, normalizeForCompare } from "./compare";
import { SideBySide } from "./SideBySide";
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
  useTranslation();
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
    return <Notice tone="bad" title={i18next.t("bench.ui.couldNotLoadTheHistory_8a8155", "Could not load the history")} actions={<button type="button" className="btn btn--sm" onClick={onReload}>{i18next.t("bench.ui.retry_9f5cd8", "Retry")}</button>}>{localizedServerText(error)}</Notice>;
  }
  if (!runs) return <Skeleton lines={4} className="te-card te-card--pad" />;
  if (!runs.length) {
    return (
      <div className="te-empty te-empty--big">
        <b>{i18next.t("bench.ui.noRunsYet_578f60", "No runs yet")}</b>
        <p>{i18next.t("bench.ui.runsOfThisBenchmarkOn_2ebfe5", "Runs of this benchmark on")} {sparkName} {i18next.t("bench.ui.showUpHereWithTheirResultsSo_d47b84", "show up here with their results, so you can open, re-run and compare them.")}</p>
      </div>
    );
  }

  return (
    <div className="te-history">
      <p className="te-note">{i18next.t("bench.ui.tickTwoRunsToCompareThemResults_dcac1c", "Tick two runs to compare them. Results are only comparable when model, endpoint and options match closely; differences are listed when you compare.")}</p>
      <ul className="te-runs">
        {runs.map((r) => {
          const stuck = r.status === "running" && r.id !== followedId;
          const dur = r.finishedAt ? (r.finishedAt - r.startedAt) / 1000 : null;
          return (
            <li key={r.id} className={`te-run ${viewedId === r.id ? "is-viewed" : ""}`}>
              <label className="te-run__pick" title={i18next.t("bench.ui.selectForComparison_1a8fc3", "Select for comparison")}>
                <input type="checkbox" checked={picked.includes(r.id)} onChange={() => toggle(r.id)} aria-label={i18next.t("bench.ui.compareRunFromV1_c0ffe7", "Compare run from {v1}", { v1: fmtDate(r.startedAt) })} />
              </label>
              <div className="te-run__main">
                <div className="te-run__title">
                  <b>{r.label || fmtDate(r.startedAt)}</b>
                  <Tag tone={statusTone(r.status)}>{statusLabel(r.status, !stuck)}</Tag>
                  {r.summary?.rating ? <span className="te-faint">{r.summary.rating.replace(/[^★☆]+/, (label) => localizeBenchText(label.trim()))}</span> : null}
                </div>
                <div className="te-faint te-run__sub">
                  {r.label ? `${fmtDate(r.startedAt)} · ` : ""}
                  {r.model ?? i18next.t("bench.ui.autoModel_361286", "auto model")} · {dur != null ? fmtDuration(dur) : i18next.t("bench.ui.inProgress_d6e91b", "in progress")}
                  {r.summary?.counts ? i18next.t("bench.ui.v1V2V3PassPartialFail_a45c95", " · {v1}/{v2}/{v3} pass/partial/fail", { v1: r.summary.counts.pass, v2: r.summary.counts.partial, v3: r.summary.counts.fail }) : ""}
                  {r.summary?.safetyWarnings ? i18next.t("bench.ui.v1SafetyWarningS_a1974d", " · {v1} safety warning(s)", { v1: r.summary.safetyWarnings }) : ""}
                </div>
              </div>
              <div className="te-run__score" title={r.summary ? i18next.t("bench.ui.finalScore_ddcd5e", "Final score") : i18next.t("bench.ui.noHeadlineNumber_ce7e96", "No headline number")}>
                <b className="big-num">{headline(r)}</b>
              </div>
              <div className="te-run__actions">
                {confirmDel === r.id ? (
                  <>
                    <span className="te-confirm-text">{i18next.t("bench.ui.deleteThisRun_378d28", "Delete this run?")}</span>
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
                    >{i18next.t("bench.ui.delete_f6fdbe", "Delete")}</button>
                    <button type="button" className="btn btn--sm" onClick={() => setConfirmDel(null)}>{i18next.t("bench.ui.cancel_77dfd2", "Cancel")}</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn--sm" onClick={() => onOpen(r)}>{i18next.t("bench.ui.open_cf9b77", "Open")}</button>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => onRerun(r)} title={i18next.t("bench.ui.loadTheseOptionsIntoTheForm_e4ac56", "Load these options into the form")}>{i18next.t("bench.ui.reRun_24e901", "Re-run…")}</button>
                    {stuck ? (
                      <>
                        <button type="button" className="btn btn--sm btn--ghost" onClick={() => onAttach(r)}>{i18next.t("bench.ui.watch_d91ebf", "Watch")}</button>
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          disabled={busyId === r.id}
                          onClick={async () => {
                            setBusyId(r.id);
                            await onRefresh(r);
                            setBusyId(null);
                          }}
                          title={i18next.t("bench.ui.askTheSparkWhetherThisRunHas_cac20f", "Ask the Spark whether this run has finished")}
                        >
                          {busyId === r.id ? i18next.t("bench.ui.checking_820d60", "Checking…") : i18next.t("bench.ui.refreshStatus_ade15a", "Refresh status")}
                        </button>
                      </>
                    ) : null}
                    <button type="button" className="btn btn--sm btn--ghost" disabled={r.status === "running"} onClick={() => setConfirmDel(r.id)} title={r.status === "running" ? i18next.t("bench.ui.stopTheRunFirst_26451e", "Stop the run first") : i18next.t("bench.ui.delete_f6fdbe", "Delete")}>{i18next.t("bench.ui.delete_f6fdbe", "Delete")}</button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {picked.length === 1 ? <p className="te-faint">{i18next.t("bench.ui.selectOneMoreRunToCompare_b552e8", "Select one more run to compare.")}</p> : null}
      {pair ? <ComparePanel key={`${pair[0].id}:${pair[1].id}`} sparkId={sparkId} a={pair[0]} b={pair[1]} /> : null}
    </div>
  );
}

/** Two runs side by side: deltas, categories and changed scenarios (or changed metrics for other result types). */
function ComparePanel({ sparkId, a, b }: { sparkId: string; a: ToolEvalRun; b: ToolEvalRun }) {
  useTranslation();
  const [swapped, setSwapped] = useState(false);
  const ref = useRef<HTMLElement>(null);
  // Picking the second run opens the comparison: bring it into view.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, []);
  const ra = useToolEvalResult(sparkId, a.id);
  const rb = useToolEvalResult(sparkId, b.id);
  const caveats = configCaveats(a, b);
  const loading = ra.loading || rb.loading;
  const error = ra.error || rb.error;
  const na = ra.result ? normalizeForCompare(ra.result) : null;
  const nb = rb.result ? normalizeForCompare(rb.result) : null;
  const tool = na && nb ? { a: swapped ? nb : na, b: swapped ? na : nb } : null;
  const generic = !tool && ra.result && rb.result ? compareGeneric(ra.result, rb.result) : null;

  return (
    <section ref={ref} className="panel te-card te-compare" aria-label={i18next.t("bench.ui.runComparison_2e597a", "Run comparison")}>
      <div className="te-card__head">
        <h2>{i18next.t("bench.ui.compare_8d105c", "Compare")}</h2>
      </div>
      {caveats.length ? (
        <Notice tone="warn" title={i18next.t("bench.ui.theseRunsAreNotDirectlyComparable_c5eaef", "These runs are not directly comparable")}>
          <ul className="te-list">
            {caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>{i18next.t("bench.ui.differencesLikeTheseCanExplainAChange_b51a4c", "Differences like these can explain a change in score on their own.")}</Notice>
      ) : (
        <p className="te-ok">{i18next.t("bench.ui.sameModelEndpointAndOptionsAFair_597972", "Same model, endpoint and options: a fair comparison.")}</p>
      )}
      {loading ? <Skeleton lines={4} /> : null}
      {error ? <Notice tone="bad" title={i18next.t("bench.ui.aResultCouldNotBeLoaded_5ab4f4", "A result could not be loaded")}>{localizedServerText(error)}</Notice> : null}
      {tool ? <SideBySide a={tool.a} b={tool.b} runA={swapped ? b : a} runB={swapped ? a : b} onSwap={() => setSwapped((v) => !v)} /> : null}
      {generic ? (
        generic.changed.length ? (
          <div className="te-tablewrap">
            <table className="te-table">
              <thead>
                <tr><th scope="col">{i18next.t("bench.ui.metric_b2bb76", "Metric")}</th><th scope="col" className="is-num">A</th><th scope="col" className="is-num">B</th><th scope="col" className="is-num">{i18next.t("bench.ui.change_64fbd9", "Change")}</th></tr>
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
            <p className="te-faint">{generic.same} {i18next.t("bench.ui.numbersAreIdentical_9624f2", "numbers are identical.")}</p>
          </div>
        ) : (
          <p className="te-empty">{i18next.t("bench.ui.noNumbersDifferBetweenTheseRuns_596cac", "No numbers differ between these runs.")}</p>
        )
      ) : null}
      {!loading && !error && !tool && !generic ? <p className="te-empty">{i18next.t("bench.ui.nothingToCompareYet_03e44f", "Nothing to compare yet.")}</p> : null}
    </section>
  );
}

