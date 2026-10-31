import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import type { SparkSnapshot, ToolEvalRun } from "../../../api/types";
import { fetchToolEvalRuns } from "../../../api/client";
import { SparkChips } from "../SparkChips";
import { fmtDate, fmtNum } from "./format";
import { Skeleton } from "./parts";

interface OtherSparkRunsProps {
  /** Every Spark except the one whose history is open. */
  sparks: readonly SparkSnapshot[];
  type: string;
  selected: ToolEvalRun | null;
  onSelect: (run: ToolEvalRun | null) => void;
}

/** Pick one finished run from another Spark to compare against a run of this one. */
export function OtherSparkRuns({ sparks, type, selected, onSelect }: OtherSparkRunsProps) {
  const { t } = useTranslation("tooleval");
  const [sparkId, setSparkId] = useState<string | null>(selected?.sparkId ?? null);
  const [runs, setRuns] = useState<ToolEvalRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sparkId) {
      setRuns(null);
      setError(null);
      return;
    }
    let off = false;
    setRuns(null);
    setError(null);
    fetchToolEvalRuns(sparkId, type)
      .then((r) => !off && setRuns(r.runs.filter((x) => x.status === "completed")))
      .catch((e) => !off && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      off = true;
    };
  }, [sparkId, type]);

  const choose = (id: string) => {
    if (id === sparkId) return;
    setSparkId(id);
    onSelect(null);
  };

  return (
    <div className="te-xspark">
      <p className="te-note">{t("other.help")}</p>
      <SparkChips sparks={sparks} activeId={sparkId} onSelect={choose} ariaLabel={t("other.spark")} />
      {sparkId && !runs && !error ? <Skeleton lines={2} /> : null}
      {error ? <p className="te-bad">{t("other.failed", { error })}</p> : null}
      {runs && !runs.length ? <p className="te-faint">{t("other.empty")}</p> : null}
      {runs?.length ? (
        <ul className="te-xspark__list" role="radiogroup" aria-label={t("other.run")}>
          {runs.map((r) => (
            <li key={r.id}>
              <label className={`te-xspark__run ${selected?.id === r.id ? "is-on" : ""}`}>
                <input type="radio" name="te-xspark-run" checked={selected?.id === r.id} onChange={() => onSelect(r)} />
                <span className="te-xspark__main">
                  <b>{r.label || fmtDate(r.startedAt)}</b>
                  <span className="te-faint">
                    {r.label ? `${fmtDate(r.startedAt)} · ` : ""}
                    {r.model ?? t("ui.autoModel")}
                  </span>
                </span>
                <b className="te-xspark__score">{r.summary?.finalScore != null ? fmtNum(r.summary.finalScore, 1) : "–"}</b>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {selected ? (
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => onSelect(null)}>
          {t("other.clear")}
        </button>
      ) : null}
    </div>
  );
}
